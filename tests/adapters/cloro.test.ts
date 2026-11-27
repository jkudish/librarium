import { describe, expect, it, vi } from 'vitest';
import { CloroProvider, CloroTaskProvider } from '../../src/adapters/cloro.js';
import type { HttpClient, HttpResponse } from '../../src/core/http-client.js';
import { MemoryRunStore } from '../../src/core/run.js';
import { createLibrarium } from '../../src/run-core-entry.js';

// Response shapes follow the examples at https://cloro.dev/docs
// (api-reference/endpoint/*, retrieved 2026-11-26).
const KEY = 'cloro-test-key';
const env = { CLORO_API_KEY: KEY };
const TASK_ID = 'b27a21e1-7c39-4aa2-a347-23e828c426f9';

function response<T>(
  data: T,
  status = 200,
  headers: Record<string, string> = {},
): HttpResponse<T> {
  return { status, statusText: 'OK', data, headers, durationMs: 1 };
}

type Call = { url: string; options: Record<string, unknown> };
function transport(handler: (call: Call) => HttpResponse<unknown>) {
  const calls: Call[] = [];
  const client = vi.fn(async (url: string, options: unknown) => {
    const call = { url, options: options as Record<string, unknown> };
    calls.push(call);
    return handler(call);
  }) as unknown as HttpClient;
  return { client, calls };
}

const chatgptResult = {
  model: null,
  text: "Here's what I found about AI recruiting tools...",
  markdown: "Here's what I found about **AI recruiting tools**...",
  sources: [
    {
      position: 1,
      url: 'https://www.rippling.com/blog/ai-recruiting',
      label: '12 Best AI Recruiting Tools For HR in 2025',
      description: 'Top AI recruiting tools.',
      footnote: false,
      datePublished: '2025-05-22',
    },
    {
      position: 2,
      url: 'https://www.selectsoftwarereviews.com/buyer-guide/ai-recruiting',
      label: '10+ Best AI Recruiting Software for 2025',
      description: 'Reviews and pricing information.',
      footnote: true,
    },
  ],
  citationPills: [
    {
      label: 'Index.dev guide',
      citationPillId: 1,
      url: 'https://www.index.dev/blog/ai-recruiting-software',
      domain: 'index.dev',
      position: 1,
    },
  ],
  entities: [{ name: 'Rippling', type: 'brand' }],
  searchQueries: ['best ai recruiting tools'],
};

const liveProvider = (
  id: string,
  surface: ConstructorParameters<typeof CloroProvider>[1],
  client: HttpClient,
  options: Record<string, unknown> = { country: 'US' },
) =>
  new CloroProvider(id, surface, {
    credentials: { env },
    httpClient: client,
    options,
  });

describe('Cloro live priority', () => {
  it('sends one non-retried sync call and separates ChatGPT citations from retrieval', async () => {
    const { client, calls } = transport(() =>
      response({ success: true, result: chatgptResult }, 200, {
        'x-credits-charged': '7',
      }),
    );
    const result = await liveProvider('cloro-chatgpt-live', 'chatgpt', client, {
      country: 'US',
      state: 'CA',
    }).execute('AI recruiting tools', { timeout: 30 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.cloro.dev/v1/monitor/chatgpt');
    expect(calls[0].options).toMatchObject({
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}` },
      retry: { mode: 'never' },
      redirect: 'manual',
      body: {
        prompt: 'AI recruiting tools',
        country: 'US',
        state: 'CA',
        include: { markdown: true },
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.content).toBe(
      "Here's what I found about **AI recruiting tools**...",
    );
    // Pills plus the sources ChatGPT links in its text (footnote: false).
    expect(result.citations.map((citation) => citation.url)).toEqual([
      'https://www.index.dev/blog/ai-recruiting-software',
      'https://www.rippling.com/blog/ai-recruiting',
    ]);
    expect(result.searchResults).toEqual([
      {
        url: 'https://www.rippling.com/blog/ai-recruiting',
        title: '12 Best AI Recruiting Tools For HR in 2025',
        snippet: 'Top AI recruiting tools.',
        publishedAt: '2025-05-22T00:00:00Z',
      },
      {
        url: 'https://www.selectsoftwarereviews.com/buyer-guide/ai-recruiting',
        title: '10+ Best AI Recruiting Software for 2025',
        snippet: 'Reviews and pricing information.',
      },
    ]);
    expect(result.usage).toEqual({ billableUnits: 7, unit: 'credit' });
    expect(result.usage?.costUsdDecimal).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  it('treats Gemini and AI Mode sources as cited pages without a retrieval set', async () => {
    const { client } = transport(() =>
      response({
        success: true,
        result: {
          text: 'Gemini answer',
          sources: [{ url: 'https://example.com/a', label: 'A' }],
          citationPills: [{ url: 'https://example.com/a', label: 'A' }],
        },
      }),
    );
    const result = await liveProvider(
      'cloro-gemini-live',
      'gemini',
      client,
    ).execute('q', { timeout: 30 });
    expect(result.content).toBe('Gemini answer');
    expect(result.citations).toHaveLength(1);
    expect(result.searchResults).toBeUndefined();
  });

  it('asks Google for its AI Overview and fails clearly when Google showed none', async () => {
    const { client, calls } = transport(() =>
      response({ success: true, result: { organicResults: [] } }, 200, {
        'x-credits-charged': '7',
      }),
    );
    const result = await liveProvider(
      'cloro-google-ai-overview-live',
      'google-ai-overview',
      client,
    ).execute('cast iron rust', { timeout: 30 });
    expect(calls[0].url).toBe('https://api.cloro.dev/v1/monitor/google');
    expect(calls[0].options.body).toEqual({
      query: 'cast iron rust',
      country: 'US',
      include: { aioverview: { markdown: true } },
    });
    expect(result.error).toContain('no AI Overview');
    expect(result.usage).toEqual({ billableUnits: 7, unit: 'credit' });
  });

  it('maps Google Search and News results to ranked sources', async () => {
    const organic = transport(() =>
      response({
        success: true,
        result: {
          organicResults: [
            {
              position: 1,
              title: 'How to Clean a Rusty Cast-Iron Skillet',
              link: 'https://www.marthastewart.com/rusty-skillet',
              snippet: 'Scrub with steel wool.',
              date: 'Aug 2, 2026',
            },
            {
              position: 2,
              title: 'Duplicate',
              link: 'https://www.marthastewart.com/rusty-skillet',
            },
          ],
        },
      }),
    );
    // The google research source has no country option, so Search pins US.
    const search = await liveProvider(
      'cloro-google-search',
      'google-search',
      organic.client,
      {},
    ).execute('rusty skillet', { timeout: 30 });
    expect(organic.calls[0].options.body).toEqual({
      query: 'rusty skillet',
      country: 'US',
    });
    expect(search.tier).toBe('raw-search');
    expect(search.citations).toEqual([
      expect.objectContaining({
        url: 'https://www.marthastewart.com/rusty-skillet',
        title: 'How to Clean a Rusty Cast-Iron Skillet',
        sourceKind: 'web_page',
      }),
    ]);
    expect(search.content).toBe(
      '1. [How to Clean a Rusty Cast-Iron Skillet](https://www.marthastewart.com/rusty-skillet) — Aug 2, 2026\n   Scrub with steel wool.',
    );

    const news = transport(() =>
      response({
        success: true,
        result: {
          newsResults: [
            {
              title: 'Breaking climate news',
              link: 'https://example.com/article',
              source: 'Example News',
              date: '2 hours ago',
            },
          ],
        },
      }),
    );
    const mapped = await liveProvider(
      'cloro-google-news',
      'google-news',
      news.client,
      { country: 'GB' },
    ).execute('climate', { timeout: 30 });
    expect(news.calls[0].url).toBe(
      'https://api.cloro.dev/v1/monitor/google/news',
    );
    expect(mapped.citations[0]).toMatchObject({
      url: 'https://example.com/article',
      publisher: 'Example News',
      sourceKind: 'news_article',
    });
  });

  it('validates country, state and the Bing prompt length before any HTTP', async () => {
    const { client, calls } = transport(() => response({}));
    const missing = await liveProvider(
      'cloro-gemini-live',
      'gemini',
      client,
      {},
    ).execute('q', { timeout: 30 });
    expect(missing.failureDiagnostic?.kind).toBe('invalid_request');
    expect(missing.error).toContain('uppercase ISO country');
    const lower = await liveProvider('cloro-gemini-live', 'gemini', client, {
      country: 'us',
    }).execute('q', { timeout: 30 });
    expect(lower.error).toContain('uppercase ISO 3166-1');
    const state = await liveProvider('cloro-chatgpt-live', 'chatgpt', client, {
      country: 'CA',
      state: 'ON',
    }).execute('q', { timeout: 30 });
    expect(state.error).toContain('state requires country US');
    const bing = await liveProvider(
      'cloro-bing-ai-mode-live',
      'bing-ai-mode',
      client,
    ).execute('é'.repeat(600), { timeout: 30 });
    expect(bing.error).toContain('3,500 URL-encoded characters');
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, 'UNAUTHORIZED', 'authentication'],
    [403, 'INSUFFICIENT_CREDITS', 'billing'],
    [429, 'CONCURRENCY_LIMIT_EXCEEDED', 'rate_limit'],
  ] as const)(
    'maps HTTP %i %s to %s without retrying',
    async (status, code, kind) => {
      const { client, calls } = transport(() =>
        response(
          { success: false, error: { code, message: `upstream ${KEY}` } },
          status,
        ),
      );
      const result = await liveProvider(
        'cloro-google-ai-mode-live',
        'google-ai-mode',
        client,
      ).execute('q', { timeout: 30 });
      expect(calls).toHaveLength(1);
      expect(result.failureDiagnostic).toEqual({ kind, httpStatus: status });
      expect(result.error).toBe(
        `Cloro rejected the request (HTTP ${status}, ${code}).`,
      );
    },
  );
});

describe('Cloro standard priority', () => {
  const taskProvider = (client: HttpClient, id = 'cloro-chatgpt') =>
    new CloroTaskProvider(id, 'chatgpt', {
      credentials: { env },
      httpClient: client,
      options: { country: 'US' },
    });
  const task = (status: string, extra: Record<string, unknown> = {}) => ({
    task: {
      id: TASK_ID,
      taskType: 'CHATGPT',
      status,
      createdAt: new Date().toISOString(),
    },
    credits: {
      creditsToCharge: 5,
      creditsCharged: status === 'COMPLETED' ? 5 : null,
    },
    ...extra,
  });

  it('submits one idempotent async task, polls it and retrieves the result', async () => {
    const states = ['QUEUED', 'PROCESSING', 'COMPLETED'];
    const { client, calls } = transport(({ url }) =>
      url.endsWith('/v1/async/task')
        ? response({ success: true, ...task('QUEUED') })
        : response(
            task(states.shift() ?? 'COMPLETED', { response: chatgptResult }),
          ),
    );
    const provider = taskProvider(client);
    const handle = await provider.submit('AI recruiting tools', {
      timeout: 30,
      submissionId: 'attempt-1',
    });
    expect(handle).toMatchObject({ taskId: TASK_ID, status: 'pending' });
    expect(calls[0]).toMatchObject({
      url: 'https://api.cloro.dev/v1/async/task',
      options: {
        method: 'POST',
        retry: { mode: 'never' },
        body: {
          taskType: 'CHATGPT',
          idempotencyKey: 'librarium-attempt-1',
          payload: {
            prompt: 'AI recruiting tools',
            country: 'US',
            include: { markdown: true },
          },
        },
      },
    });
    expect((await provider.poll(handle)).status).toBe('pending');
    expect((await provider.poll(handle)).status).toBe('running');
    expect(await provider.poll(handle)).toMatchObject({
      status: 'completed',
      usage: { billableUnits: 5, unit: 'credit' },
    });
    const result = await provider.retrieve(handle);
    expect(result.citations).toHaveLength(2);
    expect(result.usage).toEqual({ billableUnits: 5, unit: 'credit' });
    expect(calls.at(-1)?.url).toBe(
      `https://api.cloro.dev/v1/async/task/${TASK_ID}`,
    );
  });

  it('adopts the existing task when its idempotency key was already used', async () => {
    const { client, calls } = transport(() =>
      response(
        {
          success: false,
          error: {
            code: 'RESOURCE_ALREADY_EXISTS',
            details: { taskId: TASK_ID },
          },
        },
        409,
      ),
    );
    const handle = await taskProvider(client).submit('q', {
      timeout: 30,
      submissionId: 'attempt-1',
    });
    expect(handle.taskId).toBe(TASK_ID);
    expect(calls).toHaveLength(1);
  });

  it('rejects an underfunded submission without retrying it', async () => {
    const { client, calls } = transport(() =>
      response(
        { success: false, error: { code: 'INSUFFICIENT_CREDITS' } },
        403,
      ),
    );
    await expect(
      taskProvider(client).submit('q', { timeout: 30 }),
    ).rejects.toMatchObject({ failureDiagnostic: { kind: 'billing' } });
    expect(calls).toHaveLength(1);
  });

  it('reports a failed task with its credit code', async () => {
    const { client } = transport(() =>
      response(
        task('FAILED', {
          response: { error: { code: 'INSUFFICIENT_CREDITS' } },
        }),
      ),
    );
    const polled = await taskProvider(client).poll({
      provider: 'cloro-chatgpt',
      taskId: TASK_ID,
      query: 'q',
      submittedAt: Date.now(),
      status: 'pending',
    });
    expect(polled).toMatchObject({
      status: 'failed',
      failureDiagnostic: { kind: 'billing' },
    });
  });

  it('expires a task after Cloro deletes it, without asking again after 24 hours', async () => {
    const deleted = transport(() =>
      response({ success: false, error: { code: 'NOT_FOUND' } }, 404),
    );
    const handle = {
      provider: 'cloro-chatgpt',
      taskId: TASK_ID,
      query: 'q',
      submittedAt: Date.now(),
      status: 'pending' as const,
    };
    expect(await taskProvider(deleted.client).poll(handle)).toMatchObject({
      status: 'failed',
      failureDiagnostic: { kind: 'expired' },
    });
    const aged = transport(() => response(task('COMPLETED')));
    const retrieved = await taskProvider(aged.client).retrieve({
      ...handle,
      submittedAt: Date.now() - 24 * 60 * 60 * 1000 - 1,
    });
    expect(retrieved.failureDiagnostic?.kind).toBe('expired');
    expect(retrieved.error).toContain('24 hours');
    expect(aged.calls).toHaveLength(0);
  });

  it('throws on transient poll failures so the caller polls again', async () => {
    const { client } = transport(() => response({}, 502));
    await expect(
      taskProvider(client).poll({
        provider: 'cloro-chatgpt',
        taskId: TASK_ID,
        query: 'q',
        submittedAt: Date.now(),
        status: 'pending',
      }),
    ).rejects.toThrow('HTTP 502');
  });
});

describe('Cloro through the public Run', () => {
  it('collects the bing-ai-mode engine with credits as evidence, not a USD cost', async () => {
    const { client, calls } = transport(() =>
      response(
        {
          success: true,
          result: {
            text: 'Bing answer',
            sources: [
              { url: 'https://example.com/read', label: 'Read' },
              { url: 'https://example.com/read', label: 'Read again' },
            ],
            citationPills: [
              { url: 'https://example.com/cited', label: 'Cited' },
            ],
          },
        },
        200,
        { 'x-credits-charged': '6' },
      ),
    );
    const store = new MemoryRunStore();
    const run = await createLibrarium({
      store,
      env,
      httpClient: client,
      config: {
        version: 3,
        engines: {
          collector: 'cloro',
          priority: 'live',
          options: { country: 'US' },
        },
      },
    }).research('q', { only: ['bing-ai-mode'] });
    expect(calls[0].url).toBe('https://api.cloro.dev/v1/monitor/bing/aimode');
    expect(run.results[0]).toMatchObject({
      source: 'bing-ai-mode',
      status: 'done',
      observation: 'surface',
      answer: 'Bing answer',
      citations: [{ url: 'https://example.com/cited', title: 'Cited' }],
      search_results: [
        {
          url: 'https://example.com/read',
          title: 'Read',
          snippet: null,
          published_at: null,
        },
      ],
      cost: { reported: null },
    });
    const stored = JSON.stringify(await store.get(run.id));
    expect(stored).toContain('"billableUnits":6');
    expect(stored).not.toContain(KEY);
  });

  it('skips bing-ai-mode as no_collector under a collector that cannot observe it', async () => {
    const run = await createLibrarium({
      store: new MemoryRunStore(),
      env: { ...env, SEARCHAPI_API_KEY: 'searchapi-test-key' },
      config: { version: 3, engines: { collector: 'searchapi' } },
    }).research('q', { only: ['chatgpt', 'bing-ai-mode'], dryRun: true });
    expect(run.results.map((result) => result.source)).toEqual(['chatgpt']);
    expect(run.skipped).toEqual([
      { source: 'bing-ai-mode', reason: 'no_collector' },
    ]);
  });
});
