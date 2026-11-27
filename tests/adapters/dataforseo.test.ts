import { describe, expect, it, vi } from 'vitest';
import {
  DataForSeoProvider,
  DataForSeoTaskProvider,
} from '../../src/adapters/dataforseo.js';
import type { HttpClient, HttpResponse } from '../../src/core/http-client.js';
import { MemoryRunStore } from '../../src/core/run.js';
import { createLibrarium } from '../../src/run-core-entry.js';

// Fixture shapes mirror jkudish/laravel-ai-librarium
// tests/Feature/DataForSeoDriverTest.php and DataForSeoLlmResponsesTest.php,
// so both languages are checked against the same provider receipts.
const LOGIN = 'dfs-test-login';
const PASSWORD = 'dfs-test-password';
const TASK_ID = '09061159-1535-0612-0000-c2a3f0b1d4e5';
const env = { DATAFORSEO_LOGIN: LOGIN, DATAFORSEO_PASSWORD: PASSWORD };
const basic = `Basic ${Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64')}`;
const controls = { locationCode: 2840, languageCode: 'en' };

function response<T>(data: T, status = 200): HttpResponse<T> {
  return { status, statusText: 'OK', data, headers: {}, durationMs: 1 };
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

type Surface = 'chatgpt' | 'gemini' | 'google_ai_mode';
const families: Record<Surface, string> = {
  chatgpt: 'ai_optimization/chat_gpt/llm_scraper',
  gemini: 'ai_optimization/gemini/llm_scraper',
  google_ai_mode: 'serp/google/ai_mode',
};
const identities: Record<Surface, Record<string, Record<string, string>>> = {
  chatgpt: {
    task_post: {
      api: 'ai_optimization',
      function: 'task_post',
      se: 'chatgpt',
      se_type: 'llm_scraper',
    },
    task_get: {
      api: 'ai_optimization',
      function: 'llm_scraper',
      se: 'chat_gpt',
    },
    live: { api: 'ai_optimization', function: 'llm_scraper', se: 'chat_gpt' },
  },
  gemini: {
    task_post: {
      api: 'ai_optimization',
      function: 'llm_scraper',
      se: 'gemini',
    },
    task_get: { api: 'ai_optimization', function: 'llm_scraper', se: 'gemini' },
    live: { api: 'ai_optimization', function: 'llm_scraper', se: 'gemini' },
  },
  google_ai_mode: {
    task_post: {
      api: 'serp',
      function: 'task_post',
      se: 'google',
      se_type: 'ai_mode',
    },
    task_get: {
      api: 'serp',
      function: 'task_get',
      se: 'google',
      se_type: 'ai_mode',
    },
    live: { api: 'serp', function: 'live', se: 'google', se_type: 'ai_mode' },
  },
};

function scraperResult(surface: Surface, query: string) {
  const base = {
    keyword: query,
    location_code: 2840,
    language_code: 'en',
    datetime: '2026-09-06 11:59:58.1234 +00:00',
  };
  if (surface === 'google_ai_mode')
    return {
      ...base,
      items: [
        {
          type: 'ai_overview',
          markdown: 'Collected answer from Google AI Mode.',
          items: [],
          references: [
            {
              type: 'ai_overview_reference',
              url: 'https://example.test/source',
              title: 'Captured source',
              text: 'Supporting excerpt.',
              source: 'Example',
            },
          ],
        },
      ],
    };
  return {
    ...base,
    model: surface === 'chatgpt' ? 'gpt-observed' : 'gemini-observed',
    markdown: 'Collected answer from the scraper.',
    sources: [
      {
        type: surface === 'chatgpt' ? 'chat_gpt_source' : 'gemini_source',
        url: 'https://example.test/source',
        title: 'Captured source',
        snippet: 'Supporting excerpt.',
        source_name: 'Example',
      },
    ],
    items: [],
  };
}

function envelope(input: {
  surface: Surface;
  operation: string;
  query: string;
  status: number;
  completed: boolean;
  cost: string;
  result?: Record<string, unknown>;
}) {
  return {
    version: '0.1.20260906',
    status_code: 20000,
    status_message: 'Ok.',
    cost: input.cost,
    tasks_count: 1,
    tasks_error: 0,
    tasks: [
      {
        id: TASK_ID,
        status_code: input.status,
        cost: input.cost,
        result_count: input.completed ? 1 : 0,
        path: [
          'v3',
          ...families[input.surface].split('/'),
          ...input.operation.split('/'),
        ],
        data: {
          ...identities[input.surface][input.operation.split('/')[0]],
          keyword: input.query,
          location_code: 2840,
          language_code: 'en',
        },
        result: input.completed
          ? [input.result ?? scraperResult(input.surface, input.query)]
          : null,
      },
    ],
  };
}

function llmEnvelope(platform: string, body: Record<string, unknown>) {
  return {
    version: '0.1.20260722',
    status_code: 20000,
    tasks_count: 1,
    tasks_error: 0,
    tasks: [
      {
        id: '07221754-1535-0612-0000-d708c6651bc3',
        status_code: 20000,
        // Task cost already includes money_spent; never add it again.
        cost: 0.029631,
        result_count: 1,
        path: ['v3', 'ai_optimization', platform, 'llm_responses', 'live'],
        data: {
          api: 'ai_optimization',
          function: 'llm_responses',
          se: platform,
          ...body,
        },
        result: [
          {
            model_name: body.model_name,
            input_tokens: 8174,
            output_tokens: 476,
            web_search: true,
            money_spent: 0.0290312,
            datetime: '2026-07-22 17:54:30 +00:00',
            items: [
              {
                type: 'reasoning',
                sections: [
                  { type: 'summary_text', text: 'Not answer content' },
                ],
              },
              {
                type: 'message',
                sections: [
                  {
                    type: 'text',
                    text: 'Answer cites one page.',
                    annotations: [
                      {
                        url: 'https://example.com/cited',
                        title: 'Cited',
                        start_index: 0,
                        end_index: 6,
                        text: 'Answer',
                      },
                    ],
                  },
                ],
              },
            ],
            fan_out_queries: ['related question'],
            search_results: [
              {
                url: 'https://example.com/uncited',
                title: 'Unused',
                date: '2026-10-30 00:00:00 +00:00',
                snippet: 'Retrieved only',
              },
              {
                url: 'https://example.com/cited',
                title: 'Cited',
                date: null,
                snippet: null,
              },
            ],
          },
        ],
      },
    ],
  };
}

const llmTransport = (platform: string) =>
  transport(({ options }) =>
    response(
      llmEnvelope(platform, (options.body as Record<string, unknown>[])[0]),
    ),
  );

describe('DataForSEO LLM Responses Live', () => {
  it.each([
    ['dataforseo-llm-chatgpt', 'chat_gpt', 'gpt-4.1-mini'],
    ['dataforseo-llm-claude', 'claude', 'claude-opus-5'],
    ['dataforseo-llm-perplexity', 'perplexity', 'sonar-pro'],
    ['dataforseo-llm-gemini', 'gemini', 'gemini-2.5-flash'],
  ] as const)(
    '%s maps message sections, annotations, retrieval and the task cost',
    async (id, platform, model) => {
      const { client, calls } = llmTransport(platform);
      const result = await new DataForSeoProvider(id, {
        credentials: { env },
        httpClient: client,
        options: { maxOutputTokens: 2048 },
      }).execute('Research café + %', { timeout: 30 });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(
        `https://api.dataforseo.com/v3/ai_optimization/${platform}/llm_responses/live`,
      );
      expect(calls[0].options).toMatchObject({
        method: 'POST',
        headers: { Authorization: basic },
        retry: { mode: 'never' },
        redirect: 'manual',
        body: [
          {
            user_prompt: 'Research café + %',
            model_name: model,
            web_search: true,
            max_output_tokens: 2048,
          },
        ],
      });
      expect(result.error).toBeUndefined();
      expect(result.content).toBe('Answer cites one page.');
      expect(
        result.citations.map(({ url, title }) => ({ url, title })),
      ).toEqual([{ url: 'https://example.com/cited', title: 'Cited' }]);
      expect(result.searchResults).toEqual([
        {
          url: 'https://example.com/uncited',
          title: 'Unused',
          snippet: 'Retrieved only',
          publishedAt: '2026-10-30T00:00:00Z',
        },
        { url: 'https://example.com/cited', title: 'Cited' },
      ]);
      expect(result.usage?.costUsdDecimal).toBe('0.029631');
      expect(result.model).toBe(model);
      expect(result.providerMeta?.['dataforseo:fan_out_queries']).toEqual([
        'related question',
      ]);
    },
  );

  it('forwards a model override and the supported web search controls', async () => {
    const { client, calls } = llmTransport('chat_gpt');
    await new DataForSeoProvider('dataforseo-llm-chatgpt', {
      credentials: { env },
      httpClient: client,
      model: 'gpt-4.1',
      options: {
        maxOutputTokens: 1024,
        forceWebSearch: true,
        webSearchCountryIsoCode: 'FR',
        webSearchCity: 'Paris',
      },
    }).execute('Research', { timeout: 30 });
    expect((calls[0].options.body as unknown[])[0]).toEqual({
      user_prompt: 'Research',
      model_name: 'gpt-4.1',
      web_search: true,
      max_output_tokens: 1024,
      force_web_search: true,
      web_search_country_iso_code: 'FR',
      web_search_city: 'Paris',
    });
  });

  it('rejects overlong Unicode prompts before HTTP but accepts exactly 500 characters', async () => {
    const { client, calls } = llmTransport('chat_gpt');
    const provider = new DataForSeoProvider('dataforseo-llm-chatgpt', {
      credentials: { env },
      httpClient: client,
      options: { maxOutputTokens: 2048 },
    });
    const rejected = await provider.execute('é'.repeat(501), { timeout: 30 });
    expect(rejected.error).toContain('1 to 500');
    expect(rejected.failureDiagnostic?.kind).toBe('invalid_request');
    expect(calls).toHaveLength(0);
    const accepted = await provider.execute('é'.repeat(500), { timeout: 30 });
    expect(accepted.content).toBe('Answer cites one page.');
    expect(calls).toHaveLength(1);
  });

  it('rejects platform controls the endpoint does not support', async () => {
    const { client, calls } = llmTransport('gemini');
    const result = await new DataForSeoProvider('dataforseo-llm-gemini', {
      credentials: { env },
      httpClient: client,
      options: { forceWebSearch: true },
    }).execute('Research', { timeout: 30 });
    expect(result.failureDiagnostic?.kind).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });
});

describe('DataForSEO scraper and AI Mode Live', () => {
  it('URL-encodes the keyword and accepts the live function current receipts echo', async () => {
    const query = 'Best virtual numbers?';
    let payload = envelope({
      surface: 'chatgpt',
      operation: 'live/advanced',
      query,
      status: 20000,
      completed: true,
      cost: '0.004',
    });
    payload.tasks[0].data.function = 'live';
    payload.tasks[0].data.keyword = encodeURIComponent(query);
    const { client, calls } = transport(() => response(payload));
    const provider = new DataForSeoProvider('dataforseo-chatgpt-live', {
      credentials: { env },
      httpClient: client,
      options: { ...controls, forceWebSearch: true },
    });
    const result = await provider.execute(query, { timeout: 30 });
    expect(calls[0].url).toBe(
      'https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced',
    );
    expect(calls[0].options.body).toEqual([
      {
        keyword: 'Best%20virtual%20numbers%3F',
        location_code: 2840,
        language_code: 'en',
        force_web_search: true,
      },
    ]);
    expect(result.content).toBe('Collected answer from the scraper.');
    expect(result.citations.map((citation) => citation.url)).toEqual([
      'https://example.test/source',
    ]);
    expect(result.model).toBe('gpt-observed');
    expect(result.usage?.costUsdDecimal).toBe('0.004');

    payload = structuredClone(payload);
    payload.tasks[0].data.function = 'task_get';
    const rejected = await new DataForSeoProvider('dataforseo-chatgpt-live', {
      credentials: { env },
      httpClient: transport(() => response(payload)).client,
      options: { ...controls, forceWebSearch: true },
    }).execute(query, { timeout: 30 });
    expect(rejected.error).toContain('different task family');
  });

  it('keeps the ChatGPT retrieval set separate from its citations', async () => {
    const payload = envelope({
      surface: 'chatgpt',
      operation: 'live/advanced',
      query: 'Retrieval',
      status: 20000,
      completed: true,
      cost: '0.004',
    });
    (payload.tasks[0].result?.[0] as Record<string, unknown>).search_results = [
      {
        type: 'chatgpt_search_result',
        url: 'https://example.test/uncited',
        title: 'First',
        description: 'Unused',
      },
      {
        type: 'chatgpt_search_result',
        url: 'https://example.test/source',
        title: 'Cited',
      },
    ];
    const result = await new DataForSeoProvider('dataforseo-chatgpt-live', {
      credentials: { env },
      httpClient: transport(() => response(payload)).client,
      options: controls,
    }).execute('Retrieval', { timeout: 30 });
    expect(result.searchResults).toEqual([
      {
        url: 'https://example.test/uncited',
        title: 'First',
        snippet: 'Unused',
      },
      { url: 'https://example.test/source', title: 'Cited' },
    ]);
    expect(result.citations.map((citation) => citation.url)).toEqual([
      'https://example.test/source',
    ]);
  });

  it('maps text and table blocks without Markdown and reports omitted types', async () => {
    const payload = envelope({
      surface: 'chatgpt',
      operation: 'live/advanced',
      query: 'fallback blocks',
      status: 20000,
      completed: true,
      cost: '0.004',
      result: {
        keyword: 'fallback blocks',
        location_code: 2840,
        language_code: 'en',
        datetime: '2026-09-06 11:59:58 +00:00',
        markdown: null,
        sources: null,
        items: [
          { type: 'chat_gpt_text', markdown: 'Text answer.' },
          { type: 'chat_gpt_table', markdown: '| A | B |\n| - | - |' },
          { type: 'chat_gpt_images', markdown: 'image must not become answer' },
        ],
      },
    });
    const result = await new DataForSeoProvider('dataforseo-chatgpt-live', {
      credentials: { env },
      httpClient: transport(() => response(payload)).client,
      options: controls,
    }).execute('fallback blocks', { timeout: 30 });
    expect(result.content).toBe('Text answer.\n\n| A | B |\n| - | - |');
    expect(result.citations).toEqual([]);
    expect(result.providerMeta?.['dataforseo:omitted_item_types']).toEqual([
      'chat_gpt_images',
    ]);
  });

  it('maps the AI Mode overview and never substitutes organic results for it', async () => {
    const options = { ...controls, device: 'mobile', os: 'ios' };
    const ok = envelope({
      surface: 'google_ai_mode',
      operation: 'live/advanced',
      query: 'ai mode',
      status: 20000,
      completed: true,
      cost: '0.004',
    });
    const result = await new DataForSeoProvider(
      'dataforseo-google-ai-mode-live',
      {
        credentials: { env },
        httpClient: transport(() => response(ok)).client,
        options,
      },
    ).execute('ai mode', { timeout: 30 });
    expect(result.content).toBe('Collected answer from Google AI Mode.');
    expect(result.citations[0]).toMatchObject({
      url: 'https://example.test/source',
      title: 'Captured source',
      snippet: 'Supporting excerpt.',
      publisher: 'Example',
    });

    const organic = structuredClone(ok);
    (organic.tasks[0].result?.[0] as Record<string, unknown>).items = [
      { type: 'organic', url: 'https://example.test/organic' },
    ];
    const missing = await new DataForSeoProvider(
      'dataforseo-google-ai-mode-live',
      {
        credentials: { env },
        httpClient: transport(() => response(organic)).client,
        options,
      },
    ).execute('ai mode', { timeout: 30 });
    expect(missing.content).toBe('');
    expect(missing.error).toContain('no supported answer content');
  });

  it('reports the charge of a billed Live task whose result cannot be mapped', async () => {
    const payload = envelope({
      surface: 'gemini',
      operation: 'live/advanced',
      query: 'q',
      status: 20000,
      completed: true,
      cost: '0.004',
    });
    (payload.tasks[0].result?.[0] as Record<string, unknown>).datetime = 'bad';
    const result = await new DataForSeoProvider('dataforseo-gemini-live', {
      credentials: { env },
      httpClient: transport(() => response(payload)).client,
      options: controls,
    }).execute('q', { timeout: 30 });
    expect(result.error).toContain('observation timestamp');
    expect(result.usage?.costUsdDecimal).toBe('0.004');
  });

  it('requires location controls and a credential before any HTTP', async () => {
    const { client, calls } = transport(() => response({}));
    const noControls = await new DataForSeoProvider('dataforseo-gemini-live', {
      credentials: { env },
      httpClient: client,
      options: {},
    }).execute('q', { timeout: 30 });
    expect(noControls.failureDiagnostic?.kind).toBe('invalid_request');
    expect(noControls.error).toContain('locationCode and languageCode');
    const noCredential = await new DataForSeoProvider(
      'dataforseo-gemini-live',
      {
        credentials: { env: { DATAFORSEO_LOGIN: LOGIN } },
        httpClient: client,
        options: controls,
      },
    ).execute('q', { timeout: 30 });
    expect(noCredential.failureDiagnostic?.kind).toBe('authentication');
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, {}, 'authentication'],
    [402, {}, 'billing'],
    [429, {}, 'rate_limit'],
  ] as const)(
    'maps HTTP %i to a bounded %s failure',
    async (status, body, kind) => {
      const result = await new DataForSeoProvider('dataforseo-gemini-live', {
        credentials: { env },
        httpClient: transport(() => response(body, status)).client,
        options: controls,
      }).execute('q', { timeout: 30 });
      expect(result.failureDiagnostic).toMatchObject({
        kind,
        httpStatus: status,
      });
    },
  );

  it('fails closed on task errors, mismatched ids and reflected credentials', async () => {
    const run = async (mutate: (payload: any) => void) => {
      const payload = envelope({
        surface: 'gemini',
        operation: 'live/advanced',
        query: 'q',
        status: 20000,
        completed: true,
        cost: '0.004',
      });
      mutate(payload);
      return new DataForSeoProvider('dataforseo-gemini-live', {
        credentials: { env },
        httpClient: transport(() => response(payload)).client,
        options: controls,
      }).execute('q', { timeout: 30 });
    };
    const funds = await run((payload) => {
      payload.tasks[0].status_code = 40200;
    });
    expect(funds.failureDiagnostic?.kind).toBe('billing');
    expect(
      (
        await run((payload) => {
          payload.tasks[0].id = '00000000-0000-0000-0000-000000000000';
          payload.tasks[0].path = ['v3', 'wrong'];
        })
      ).error,
    ).toContain('unexpected endpoint path');
    const echoed = await run((payload) => {
      payload.tasks[0].result[0].markdown = `leaked ${PASSWORD}`;
    });
    expect(echoed.error).toContain('unsafe response content');
    expect(JSON.stringify(echoed)).not.toContain(PASSWORD);
  });
});

describe('DataForSEO standard-priority tasks', () => {
  it('posts once, polls pending task_get states, then retrieves with the submission charge', async () => {
    const states = [40602, 40601, 20000];
    const { client, calls } = transport(({ url }) => {
      if (url.endsWith('/task_post'))
        return response(
          envelope({
            surface: 'google_ai_mode',
            operation: 'task_post',
            query: 'standard',
            status: 20100,
            completed: false,
            cost: '0.0012',
          }),
        );
      const status = states.shift() ?? 20000;
      return response(
        envelope({
          surface: 'google_ai_mode',
          operation: `task_get/advanced/${TASK_ID}`,
          query: 'standard',
          status,
          completed: status === 20000,
          cost: '0',
        }),
      );
    });
    const provider = new DataForSeoTaskProvider('dataforseo-google-ai-mode', {
      credentials: { env },
      httpClient: client,
      options: controls,
    });
    const handle = await provider.submit('standard', { timeout: 30 });
    expect(handle).toMatchObject({
      taskId: TASK_ID,
      status: 'pending',
      usage: { costUsdDecimal: '0.0012' },
    });
    expect(calls[0]).toMatchObject({
      url: 'https://api.dataforseo.com/v3/serp/google/ai_mode/task_post',
      options: { method: 'POST', retry: { mode: 'never' } },
    });
    expect((await provider.poll(handle)).status).toBe('running');
    expect((await provider.poll(handle)).status).toBe('running');
    expect((await provider.poll(handle)).status).toBe('completed');
    const result = await provider.retrieve(handle);
    expect(result.content).toBe('Collected answer from Google AI Mode.');
    expect(result.usage?.costUsdDecimal).toBe('0.0012');
    expect(
      calls.filter((call) => call.url.endsWith('/task_post')),
    ).toHaveLength(1);
    expect(calls.at(-1)?.url).toBe(
      `https://api.dataforseo.com/v3/serp/google/ai_mode/task_get/advanced/${TASK_ID}`,
    );
  });

  it('marks a result DataForSEO no longer holds as a non-retryable expiry', async () => {
    const provider = new DataForSeoTaskProvider('dataforseo-gemini', {
      credentials: { env },
      httpClient: transport(() =>
        response(
          envelope({
            surface: 'gemini',
            operation: `task_get/advanced/${TASK_ID}`,
            query: 'q',
            status: 40401,
            completed: false,
            cost: '0',
          }),
        ),
      ).client,
      options: controls,
    });
    const polled = await provider.poll({
      provider: 'dataforseo-gemini',
      taskId: TASK_ID,
      query: 'q',
      submittedAt: Date.now(),
      status: 'pending',
    });
    expect(polled).toMatchObject({
      status: 'failed',
      failureDiagnostic: { kind: 'expired' },
    });
  });

  it('throws on transient task_get failures so the caller polls again', async () => {
    const provider = new DataForSeoTaskProvider('dataforseo-gemini', {
      credentials: { env },
      httpClient: transport(() => response({}, 503)).client,
      options: controls,
    });
    await expect(
      provider.poll({
        provider: 'dataforseo-gemini',
        taskId: TASK_ID,
        query: 'q',
        submittedAt: Date.now(),
        status: 'pending',
      }),
    ).rejects.toThrow('temporarily');
  });

  it('never retries an ambiguous submission', async () => {
    const client = vi.fn(async () => {
      throw new Error('socket hang up');
    }) as unknown as HttpClient;
    const provider = new DataForSeoTaskProvider('dataforseo-gemini', {
      credentials: { env },
      httpClient: client,
      options: controls,
    });
    await expect(provider.submit('q', { timeout: 30 })).rejects.toThrow(
      'not retried',
    );
    expect(client).toHaveBeenCalledOnce();
  });
});

describe('DataForSEO through the public Run', () => {
  it('runs an engine at live priority and projects one deduplicated retrieval set', async () => {
    const payload = envelope({
      surface: 'chatgpt',
      operation: 'live/advanced',
      query: 'q',
      status: 20000,
      completed: true,
      cost: '0.004',
    });
    (payload.tasks[0].result?.[0] as Record<string, unknown>).search_results = [
      {
        type: 'chatgpt_search_result',
        url: 'https://example.test/uncited',
        title: 'First',
      },
      {
        type: 'chatgpt_search_result',
        url: 'https://example.test/uncited',
        title: 'Duplicate',
      },
    ];
    const { client, calls } = transport(() => response(payload));
    const store = new MemoryRunStore();
    const librarium = createLibrarium({
      store,
      env,
      httpClient: client,
      config: {
        version: 3,
        engines: {
          collector: 'searchapi',
          chatgpt: {
            collector: 'dataforseo',
            priority: 'live',
            options: controls,
          },
        },
      },
    });
    const run = await librarium.research('q', { only: ['chatgpt'] });
    const [result] = run.results;
    expect(calls[0].url).toContain('/chat_gpt/llm_scraper/live/advanced');
    expect(result).toMatchObject({
      status: 'done',
      observation: 'surface',
      answer: 'Collected answer from the scraper.',
      citations: [
        { url: 'https://example.test/source', title: 'Captured source' },
      ],
      search_results: [
        {
          url: 'https://example.test/uncited',
          title: 'First',
          snippet: null,
          published_at: null,
        },
      ],
      cost: { reported: '0.004' },
    });
    expect(JSON.stringify(await store.get(run.id))).not.toContain(PASSWORD);
  });

  it('keeps the task_post charge when a standard task resumes after its owner dies', async () => {
    const store = new MemoryRunStore();
    const handleKey = new Uint8Array(32).fill(7);
    const config = {
      version: 3 as const,
      engines: {
        collector: 'searchapi',
        'gemini-app': { collector: 'dataforseo', options: controls },
      },
    };
    let snapshot: Awaited<ReturnType<MemoryRunStore['get']>> = null;
    let gets = 0;
    let posts = 0;
    const httpClient = (async (url: string) => {
      if (url.endsWith('/task_post')) {
        posts++;
        return response(
          envelope({
            surface: 'gemini',
            operation: 'task_post',
            query: 'q',
            status: 20100,
            completed: false,
            cost: '0.0012',
          }),
        );
      }
      gets++;
      if (gets === 1) snapshot = await store.get((await store.list())[0].id);
      return response(
        envelope({
          surface: 'gemini',
          operation: `task_get/advanced/${TASK_ID}`,
          query: 'q',
          status: gets === 1 ? 40602 : 20000,
          completed: gets !== 1,
          cost: '0',
        }),
      );
    }) as unknown as HttpClient;
    const run = await createLibrarium({
      store,
      handleKey,
      env,
      httpClient,
      config,
      owner: { id: 'old-owner', alive: () => true },
    }).research('q', { only: ['gemini-app'] });
    expect(run.results[0].cost.reported).toBe('0.0012');
    expect(snapshot).not.toBeNull();

    const recovered = new MemoryRunStore();
    await recovered.save(snapshot as never, null);
    const resumed = await createLibrarium({
      store: recovered,
      handleKey,
      env,
      httpClient,
      config,
      owner: { id: 'new-owner', alive: (id) => id !== 'old-owner' },
    }).get(run.id, { wait: true });
    expect(resumed?.results[0]).toMatchObject({
      status: 'done',
      answer: 'Collected answer from the scraper.',
      cost: { reported: '0.0012' },
    });
    expect(posts).toBe(1);
  });

  it('asks openai through DataForSEO LLM Responses with DataForSEO credentials', async () => {
    const { client, calls } = llmTransport('chat_gpt');
    const run = await createLibrarium({
      store: new MemoryRunStore(),
      env,
      httpClient: client,
    }).research('Research', {
      only: ['openai'],
      options: { openai: { collector: 'dataforseo' } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/chat_gpt/llm_responses/live');
    expect(run.results[0]).toMatchObject({
      status: 'done',
      answer: 'Answer cites one page.',
      citations: [{ url: 'https://example.com/cited', title: 'Cited' }],
      cost: { reported: '0.029631' },
      provenance: { collector: 'dataforseo' },
    });
  });
});
