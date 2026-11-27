import { describe, expect, it, vi } from 'vitest';
import { SerplyProvider } from '../../src/adapters/serply.js';
import type { HttpClient, HttpResponse } from '../../src/core/http-client.js';
import { MemoryRunStore } from '../../src/core/run.js';
import { SOURCE_CATALOG } from '../../src/core/source-catalog.js';
import { createLibrarium } from '../../src/run-core-entry.js';

// Offline only: Serply has no live verification yet. Shapes follow
// https://serply.io/docs/resources/google-search (retrieved 2026-11-27).
const KEY = 'serply-test-key';

function response<T>(data: T, status = 200): HttpResponse<T> {
  return { status, statusText: 'OK', data, headers: {}, durationMs: 1 };
}

function transport(...responses: HttpResponse<unknown>[]) {
  const calls: { url: string; options: Record<string, unknown> }[] = [];
  const client = vi.fn(async (url: string, options: unknown) => {
    calls.push({ url, options: options as Record<string, unknown> });
    return responses.shift() ?? response({ detail: 'unexpected call' }, 500);
  }) as unknown as HttpClient;
  return { client, calls };
}

const result = (link: string, title: string, description?: string) => ({
  title,
  ...(description && { description }),
  position: 1,
  result_type: 'organic',
  link,
});

const provider = (client: HttpClient, options: Record<string, unknown> = {}) =>
  new SerplyProvider({
    credentials: { env: { SERPLY_API_KEY: KEY } },
    httpClient: client,
    ...options,
  });

describe('Serply Google Search', () => {
  it('always pins gl and sends one GET with the key header', async () => {
    const { client, calls } = transport(response({ results: [] }));
    await provider(client).execute('search api', { timeout: 7 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://api.serply.io/v1/search?q=search+api&num=10&gl=us',
    );
    expect(calls[0].options).toMatchObject({
      method: 'GET',
      headers: { 'X-Api-Key': KEY },
      timeout: 7_000,
      retry: { mode: 'never' },
      redirect: 'manual',
    });

    const custom = transport(response({ results: [] }));
    await provider(custom.client, {
      gl: 'de',
      hl: 'de',
      num: 5,
      device: 'mobile',
    }).execute('suche', { timeout: 7 });
    expect(custom.calls[0].url).toBe(
      'https://api.serply.io/v1/search?q=suche&num=5&gl=de&hl=de',
    );
    expect(custom.calls[0].options.headers).toEqual({
      'X-Api-Key': KEY,
      'X-User-Agent': 'mobile',
    });
  });

  it('deduplicates overlapping results by link and trims to num', async () => {
    const { client } = transport(
      response({
        results: [
          result('https://a.example/', 'A', 'First'),
          result('https://a.example/', 'A again'),
          result('https://b.example/', 'B'),
          result('javascript:alert(1)', 'Unsafe'),
          result('https://c.example/', 'C'),
        ],
        ai_overview: {
          title: 'AI Overview',
          metadata: {
            present: true,
            text: 'Overview answer.',
            sources: [{ url: 'https://cited.example/page' }],
          },
        },
      }),
    );
    const mapped = await provider(client, { num: 2 }).execute('q', {
      timeout: 7,
    });
    expect(mapped.error).toBeUndefined();
    expect(mapped.citations.map((citation) => citation.url)).toEqual([
      'https://a.example/',
      'https://b.example/',
    ]);
    expect(mapped.citations[0]).toMatchObject({
      title: 'A',
      snippet: 'First',
      sourceKind: 'web_page',
    });
    expect(mapped.content).toBe(
      '1. [A](https://a.example/)\n   First\n2. [B](https://b.example/)',
    );
    // The AI Overview is evidence only: never content or a citation.
    expect(mapped.content).not.toContain('Overview answer');
    expect(mapped.providerMeta?.['serply:ai_overview']).toEqual({
      text: 'Overview answer.',
      sources: ['https://cited.example/page'],
    });
    expect(mapped.usage).toEqual({ billableUnits: 1, unit: 'request' });
  });

  it('retries a 502 exactly once', async () => {
    const recovered = transport(
      response({ detail: 'Bad gateway' }, 502),
      response({ results: [result('https://a.example/', 'A')] }),
    );
    const ok = await provider(recovered.client).execute('q', { timeout: 7 });
    expect(recovered.calls).toHaveLength(2);
    expect(ok.citations).toHaveLength(1);

    const failing = transport(
      response({ detail: 'Bad gateway' }, 502),
      response({ detail: 'Bad gateway' }, 502),
    );
    const failed = await provider(failing.client).execute('q', { timeout: 7 });
    expect(failing.calls).toHaveLength(2);
    expect(failed.failureDiagnostic).toEqual({
      kind: 'provider',
      httpStatus: 502,
    });
  });

  it.each([
    [401, 'authentication'],
    [403, 'authentication'],
    [422, 'invalid_request'],
    [429, 'rate_limit'],
    [500, 'provider'],
  ] as const)('maps HTTP %i to %s without retrying', async (status, kind) => {
    const { client, calls } = transport(
      response({ detail: 'Human-readable error message' }, status),
    );
    const failed = await provider(client).execute('q', { timeout: 7 });
    expect(calls).toHaveLength(1);
    expect(failed.failureDiagnostic).toEqual({ kind, httpStatus: status });
    expect(failed.error).toBe(`Serply rejected the request (HTTP ${status}).`);
  });

  it('fails closed on malformed bodies and reflected credentials', async () => {
    const malformed = await provider(
      transport(response({ detail: 'ok' })).client,
    ).execute('q', { timeout: 7 });
    expect(malformed.error).toContain('malformed');
    const reflected = await provider(
      transport(response({ results: [], query: `q ${KEY}` })).client,
    ).execute('q', { timeout: 7 });
    expect(reflected.error).toContain('reflected the configured credential');
    expect(JSON.stringify(reflected)).not.toContain(KEY);
  });

  it('rejects invalid options and a missing key before HTTP', async () => {
    const { client, calls } = transport();
    const upper = await provider(client, { gl: 'US' }).execute('q', {
      timeout: 7,
    });
    expect(upper.failureDiagnostic?.kind).toBe('invalid_request');
    const tooMany = await provider(client, { num: 20 }).execute('q', {
      timeout: 7,
    });
    expect(tooMany.failureDiagnostic?.kind).toBe('invalid_request');
    const missing = await new SerplyProvider({
      credentials: { env: {} },
      httpClient: client,
    }).execute('q', { timeout: 7 });
    expect(missing.failureDiagnostic?.kind).toBe('authentication');
    expect(calls).toHaveLength(0);
  });

  it('runs as the google collector once the spec lists serply/search', async () => {
    // librarium-spec has no serply collector yet; inject the planned variant.
    const google = SOURCE_CATALOG.find((source) => source.id === 'google');
    const collector = google?.options?.collector;
    if (!collector?.values || !collector.variants)
      throw new Error('google collector option missing');
    collector.values.push('serply');
    collector.variants.serply = {
      js: 'serply/search',
      php: 'serply-search',
      env: 'SERPLY_API_KEY',
    };
    try {
      const { client, calls } = transport(
        response({ results: [result('https://a.example/', 'A')] }),
      );
      const store = new MemoryRunStore();
      const run = await createLibrarium({
        store,
        env: { SERPLY_API_KEY: KEY },
        httpClient: client,
      }).research('q', {
        only: ['google'],
        options: { google: { collector: 'serply' } },
      });
      expect(calls[0].url).toBe(
        'https://api.serply.io/v1/search?q=q&num=10&gl=us',
      );
      expect(run.results[0]).toMatchObject({
        status: 'done',
        answer: null,
        citations: [{ url: 'https://a.example/', title: 'A' }],
        cost: { reported: null },
      });
      expect(JSON.stringify(await store.get(run.id))).not.toContain(KEY);
    } finally {
      collector.values.pop();
      delete collector.variants.serply;
    }
  });
});
