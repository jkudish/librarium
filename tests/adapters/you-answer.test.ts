import { describe, expect, it, vi } from 'vitest';
import { YouAnswerProvider } from '../../src/adapters/you-answer.js';
import type { HttpClient } from '../../src/core/http-client.js';

const KEY = 'you-answer-synthetic-secret';

function response<T>(status: number, data: T) {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {},
    data,
    durationMs: 1,
  };
}

function provider(
  configured: unknown = {},
  httpClient: HttpClient = async () => response(200, {}) as never,
) {
  const instance = new YouAnswerProvider(configured);
  instance.configure({
    credentials: { env: { YOU_COM_API_KEY: KEY } },
    httpClient,
  });
  return instance;
}

describe('You.com Answer', () => {
  it('uses the exact one-attempt Answer request and keeps considered sources distinct from citations', async () => {
    const httpClient = vi.fn(async () =>
      response(200, {
        answer: 'A cited statement [[1]].',
        citations: [
          {
            source: 'https://cited.example/article',
            excerpts: ['The provider-reported supporting passage.'],
          },
        ],
        results: {
          web: [
            {
              url: 'https://cited.example/article',
              title: 'Cited title',
              snippets: ['Cited search snippet'],
            },
            {
              url: 'https://considered.example/only',
              title: 'Considered but uncited',
              snippets: ['This must not become a citation.'],
            },
          ],
        },
      }),
    ) as unknown as HttpClient;
    const abort = new AbortController();
    const result = await provider(
      {
        freshness: '2026-08-01to2026-08-13',
        country: 'CA',
        language: 'EN-GB',
        excludeDomains: ['spam.example'],
        boostDomains: ['primary.example'],
      },
      httpClient,
    ).execute('focused answer', { timeout: 7, signal: abort.signal });

    expect(httpClient).toHaveBeenCalledOnce();
    expect(httpClient).toHaveBeenCalledWith(
      'https://api.you.com/v1/answer',
      expect.objectContaining({
        method: 'POST',
        headers: { 'X-API-Key': KEY },
        timeout: 7_000,
        signal: abort.signal,
        retry: { mode: 'never' },
        body: {
          query: 'focused answer',
          freshness: '2026-08-01to2026-08-13',
          country: 'CA',
          language: 'EN-GB',
          exclude_domains: ['spam.example'],
          boost_domains: ['primary.example'],
        },
      }),
    );
    expect(result).toMatchObject({
      content: 'A cited statement [[1]].',
      citations: [
        {
          url: 'https://cited.example/article',
          snippet: 'The provider-reported supporting passage.',
        },
      ],
      providerMeta: {
        'you-com:answer': {
          observation: 'api_output',
          citation_entries: [
            {
              citation_number: 1,
              source_url: 'https://cited.example/article',
              inline_reference_count: 1,
            },
          ],
          considered_web_results: [
            { url: 'https://cited.example/article' },
            { url: 'https://considered.example/only' },
          ],
        },
      },
    });
    expect(result.citations).not.toContainEqual(
      expect.objectContaining({ url: 'https://considered.example/only' }),
    );
  });

  it('accepts explicit empty required arrays but rejects malformed data and citation relations', async () => {
    const cases: Array<[unknown, boolean]> = [
      [{ answer: 'Answer', citations: [], results: { web: [] } }, true],
      [
        { answer: 'Answer', citations: {}, results: { web: [] } },
        false,
      ],
      [
        {
          answer: 'Answer',
          citations: [{ source: 'not-a-url', excerpts: [] }],
          results: { web: [] },
        },
        false,
      ],
      [
        {
          answer: 'Answer',
          citations: [{ source: 'https://source.example' }],
          results: { web: [] },
        },
        false,
      ],
      [
        { answer: 'Answer', citations: [], results: { web: {} } },
        false,
      ],
      [
        { answer: 'Answer', citations: [], results: { web: [{}] } },
        false,
      ],
      [
        {
          answer: 'Broken reference [[2]].',
          citations: [{ source: 'https://only.example', excerpts: [] }],
          results: { web: [] },
        },
        false,
      ],
      [{ answer: '   ', citations: [], results: { web: [] } }, false],
      [null, false],
    ];

    for (const [data, succeeds] of cases) {
      const result = await provider(
        {},
        async () => response(200, data) as never,
      ).execute('response shape', { timeout: 5 });
      if (succeeds) {
        expect(result.error).toBeUndefined();
      } else {
        expect(result).toMatchObject({
          content: '',
          citations: [],
          preventFallback: true,
          error: expect.stringContaining('You.com Answer'),
        });
      }
    }
  });

  it.each([
    ['citations', { answer: 'Answer', results: { web: [] } }],
    ['results', { answer: 'Answer', citations: [] }],
    ['results.web', { answer: 'Answer', citations: [], results: {} }],
    [
      'citation excerpts',
      {
        answer: 'Answer',
        citations: [{ source: 'https://source.example' }],
        results: { web: [] },
      },
    ],
  ])('rejects a 200 response missing required %s', async (_field, data) => {
    const result = await provider(
      {},
      async () => response(200, data) as never,
    ).execute('required response fields', { timeout: 5 });

    expect(result).toMatchObject({
      content: '',
      citations: [],
      preventFallback: true,
      error: expect.stringContaining('You.com Answer'),
    });
  });

  it.each([
    ['blank query', {}, '   '],
    ['401 character query', {}, 'x'.repeat(401)],
    ['unknown option', { undocumented: true }, 'query'],
    [
      'include and exclude conflict',
      {
        includeDomains: ['include.example'],
        excludeDomains: ['exclude.example'],
      },
      'query',
    ],
    [
      'include and boost conflict',
      { includeDomains: ['include.example'], boostDomains: ['boost.example'] },
      'query',
    ],
    [
      'overlong include list',
      {
        includeDomains: Array.from({ length: 501 }, (_, i) => `d${i}.example`),
      },
      'query',
    ],
    ['unsupported country', { country: 'ZZ' }, 'query'],
    ['unsupported language', { language: 'XX' }, 'query'],
    [
      'invalid freshness date',
      { freshness: '2026-02-30to2026-03-01' },
      'query',
    ],
    [
      'reversed freshness range',
      { freshness: '2026-08-13to2026-08-01' },
      'query',
    ],
  ])('fails %s before any transport call', async (_case, configured, query) => {
    const httpClient = vi.fn();
    const result = await provider(configured, httpClient as HttpClient).execute(
      query,
      { timeout: 5 },
    );

    expect(httpClient).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      content: '',
      citations: [],
      preventFallback: true,
      error: expect.stringContaining('You.com Answer'),
    });
  });

  it('does not make paid health-check requests', async () => {
    const httpClient = vi.fn();
    await expect(
      provider({}, httpClient as HttpClient).test(),
    ).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('disabled'),
    });
    expect(httpClient).not.toHaveBeenCalled();
  });

  it.each([401, 402, 403, 422, 429, 500])(
    'returns HTTP %s errors once without leaking a known key',
    async (status) => {
      const httpClient = vi.fn(async () =>
        response(status, {
          detail: `rejected ${KEY}`,
          headers: { 'X-API-Key': KEY },
        }),
      ) as unknown as HttpClient;
      const result = await provider({}, httpClient).execute('one transport', {
        timeout: 5,
      });

      expect(httpClient).toHaveBeenCalledOnce();
      expect(result.error).toContain(`returned ${status}`);
      expect(result.error).not.toContain(KEY);
      expect(result).toMatchObject({ preventFallback: true });
    },
  );

  it('returns abort diagnostics without retrying or leaking credentials', async () => {
    const httpClient = vi.fn(async () => {
      throw new Error(`Request aborted for ${KEY}`);
    }) as unknown as HttpClient;
    const result = await provider({}, httpClient).execute('cancel request', {
      timeout: 5,
      signal: AbortSignal.abort(),
    });

    expect(httpClient).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      content: '',
      citations: [],
      preventFallback: true,
    });
    expect(result.error).not.toContain(KEY);
  });
});
