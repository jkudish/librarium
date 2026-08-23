import { describe, expect, it, vi } from 'vitest';
import { ExaResearchProvider } from '../src/adapters/exa-research.js';
import {
  getAllProviders,
  getExactProvider,
  initializeProviders,
} from '../src/adapters/index.js';
import { TavilyResearchProvider } from '../src/adapters/tavily-research.js';
import { YouResearchBackgroundProvider } from '../src/adapters/you-research-background.js';
import {
  type HttpClient,
  HttpRequestTimeoutError,
} from '../src/core/http-client.js';
import { adapterProfileBinding } from '../src/core/profile-bindings.js';
import { buildProviderCatalog } from '../src/core/profile-catalog.js';

function response<T>(data: T, status = 200) {
  return { status, statusText: 'OK', data, headers: {}, durationMs: 1 };
}

const exaRun = (overrides: Record<string, unknown> = {}) => ({
  id: 'agent_run_01j7x9v0m2n4p6q8r0s2t4v6w8',
  object: 'agent_run',
  status: 'running',
  createdAt: '2026-08-12T12:00:00.000Z',
  completedAt: null,
  output: { text: '', structured: null, grounding: [] },
  usage: {},
  costDollars: { total: 0 },
  ...overrides,
});
const YOU_ID = 'f1e2d3c4-0000-4000-8000-000000000000';
const youTask = (overrides: Record<string, unknown> = {}) => ({
  id: YOU_ID,
  task_type: 'research',
  status: 'running',
  created_at: '2026-08-12T12:00:00.000Z',
  updated_at: null,
  completed_at: null,
  error: null,
  result: null,
  ...overrides,
});

describe('durable research provider adapters', () => {
  it('hides internal ids at public ingress while exact plans initialize them', async () => {
    await initializeProviders({
      providers: {
        exa: { enabled: true },
        tavily: { enabled: true },
        'you-research': { enabled: true },
      },
      credentials: {
        env: {
          EXA_API_KEY: 'test-key',
          TAVILY_API_KEY: 'test-key',
          YOU_COM_API_KEY: 'test-key',
        },
      },
    });
    const internal = [
      'exa-research',
      'tavily-research',
      'you-research-background',
    ];
    expect(getAllProviders().map(({ id }) => id)).not.toEqual(
      expect.arrayContaining(internal),
    );
    for (const id of internal) {
      expect(adapterProfileBinding(id)).toBeUndefined();
      expect(getExactProvider(id)).toMatchObject({
        id,
        execution: 'background',
      });
    }

    const catalog = buildProviderCatalog({
      providerConfigs: {
        exa: { enabled: true },
        tavily: { enabled: true },
        'you-research': { enabled: true },
      },
      credentials: {
        env: {
          EXA_API_KEY: 'test-key',
          TAVILY_API_KEY: 'test-key',
          YOU_COM_API_KEY: 'test-key',
        },
      },
    });
    expect(catalog.get('exa', 'research')?.binding.adapter_id).toBe(
      'exa-research',
    );
    expect(catalog.get('tavily', 'research')?.binding.adapter_id).toBe(
      'tavily-research',
    );
    expect(catalog.get('you-research', 'research')?.binding.adapter_id).toBe(
      'you-research-background',
    );
    expect(
      catalog
        .resolveDefault()
        .map((identity) => `${identity.provider_id}/${identity.profile_id}`),
    ).toEqual(['you-research/grounded', 'exa/search', 'tavily/search']);
  });

  it('uses exact Exa Agent run URLs and validates terminal output', async () => {
    const calls: string[] = [];
    const httpClient: HttpClient = async <_T>(url, options) => {
      calls.push(url);
      if (url.endsWith('/cancel'))
        return response(exaRun({ status: 'cancelled' })) as never;
      if (options?.method === 'POST') return response(exaRun()) as never;
      return response(
        exaRun({
          status: 'completed',
          completedAt: '2026-08-12T12:01:00.000Z',
          output: {
            text: 'report',
            structured: null,
            grounding: [
              { citations: [{ url: 'https://exa.example', title: 'Exa' }] },
            ],
          },
          usage: { searches: 2 },
          costDollars: { total: 0.21 },
        }),
      ) as never;
    };
    const provider = new ExaResearchProvider({
      credentials: { env: { EXA_API_KEY: 'test-key' } },
      httpClient,
      effort: 'auto',
      maxCostDollars: 1,
    });
    const handle = await provider.submit('query', { timeout: 10 });
    await expect(provider.poll(handle)).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(provider.retrieve(handle)).resolves.toMatchObject({
      content: 'report',
      citations: [{ url: 'https://exa.example' }],
      usage: { costUsd: 0.21 },
    });
    await provider.cancel(handle);
    expect(calls).toEqual([
      'https://api.exa.ai/agent/runs',
      `https://api.exa.ai/agent/runs/${handle.taskId}`,
      `https://api.exa.ai/agent/runs/${handle.taskId}`,
      `https://api.exa.ai/agent/runs/${handle.taskId}/cancel`,
    ]);
  });

  it('fails closed on malformed and empty Exa completed responses', async () => {
    for (const data of [
      exaRun({ status: 'mystery' }),
      exaRun({ status: 'completed', completedAt: '2026-08-12T12:01:00.000Z' }),
      exaRun({
        status: 'completed',
        completedAt: '2026-08-12T12:01:00.000Z',
        output: { structured: {}, grounding: [] },
      }),
      exaRun({
        status: 'completed',
        completedAt: '2026-08-12T12:01:00.000Z',
        output: { text: '   ', structured: {}, grounding: [] },
      }),
    ]) {
      const provider = new ExaResearchProvider({
        credentials: { env: { EXA_API_KEY: 'test-key' } },
        httpClient: async () => response(data) as never,
      });
      const result = await provider.retrieve({
        provider: provider.id,
        taskId: 'agent_run_x',
        query: 'q',
        submittedAt: 0,
        status: 'completed',
      });
      expect(result.error).toBeTruthy();
      expect(result.content).toBe('');
    }
  });

  it('accepts a non-empty Exa structured result without text', async () => {
    const provider = new ExaResearchProvider({
      credentials: { env: { EXA_API_KEY: 'test-key' } },
      httpClient: async () =>
        response(
          exaRun({
            status: 'completed',
            completedAt: '2026-08-12T12:01:00.000Z',
            output: {
              structured: { conclusion: 'report' },
              grounding: [],
            },
          }),
        ) as never,
    });
    await expect(
      provider.retrieve({
        provider: provider.id,
        taskId: 'agent_run_x',
        query: 'q',
        submittedAt: 0,
        status: 'completed',
      }),
    ).resolves.toMatchObject({
      content: '{\n  "conclusion": "report"\n}',
    });
  });

  it('uses non-empty Exa structured output when text is blank', async () => {
    const provider = new ExaResearchProvider({
      credentials: { env: { EXA_API_KEY: 'test-key' } },
      httpClient: async () =>
        response(
          exaRun({
            status: 'completed',
            completedAt: '2026-08-12T12:01:00.000Z',
            output: {
              text: '   ',
              structured: { conclusion: 'report' },
              grounding: [],
            },
          }),
        ) as never,
    });
    await expect(
      provider.retrieve({
        provider: provider.id,
        taskId: 'agent_run_x',
        query: 'q',
        submittedAt: 0,
        status: 'completed',
      }),
    ).resolves.toMatchObject({
      content: '{\n  "conclusion": "report"\n}',
    });
  });

  it('uses valid Exa text when the structured result is empty', async () => {
    const provider = new ExaResearchProvider({
      credentials: { env: { EXA_API_KEY: 'test-key' } },
      httpClient: async () =>
        response(
          exaRun({
            status: 'completed',
            completedAt: '2026-08-12T12:01:00.000Z',
            output: { text: 'report', structured: {}, grounding: [] },
          }),
        ) as never,
    });
    await expect(
      provider.retrieve({
        provider: provider.id,
        taskId: 'agent_run_x',
        query: 'q',
        submittedAt: 0,
        status: 'completed',
      }),
    ).resolves.toMatchObject({ content: 'report' });
  });

  it('preserves a valid Exa remote id from a malformed create response', async () => {
    const provider = new ExaResearchProvider({
      credentials: { env: { EXA_API_KEY: 'test-key' } },
      httpClient: async () =>
        response({
          id: 'agent_run_preserved',
          status: 'mystery',
        }) as never,
    });
    await expect(
      provider.submit('query', { timeout: 10 }),
    ).resolves.toMatchObject({
      taskId: 'agent_run_preserved',
      status: 'failed',
      providerStatus: 'invalid_response',
    });
  });

  it.each([
    ['authentication', 401, 'authentication'],
    ['forbidden', 403, 'authentication'],
    ['invalid request', 422, 'invalid_request'],
    ['rate limit', 429, 'rate_limit'],
    ['server error', 503, 'provider'],
  ] as const)(
    'classifies Exa create HTTP %s as a bounded unsafe-to-retry diagnostic',
    async (_label, status, kind) => {
      const provider = new ExaResearchProvider({
        credentials: { env: { EXA_API_KEY: 'test-key' } },
        httpClient: async () =>
          response(
            { error: { message: 'Bearer secret-token' } },
            status,
          ) as never,
      });
      const submission = provider.submit('query', { timeout: 10 });
      await expect(submission).rejects.toMatchObject({
        name: 'UnsafeToRetrySubmissionError',
        message:
          'Exa Agent submission failed before a valid handle was returned.',
        failureDiagnostic: { kind, httpStatus: status },
      });
      await expect(submission).rejects.not.toThrow(/secret|token|Bearer/i);
    },
  );

  it('classifies a missing Exa key as authentication before any POST', async () => {
    const httpClient = vi.fn(async () => response(exaRun()));
    const provider = new ExaResearchProvider({
      credentials: { env: {} },
      httpClient,
    });
    await expect(
      provider.submit('query', { timeout: 10 }),
    ).rejects.toMatchObject({
      name: 'UnsafeToRetrySubmissionError',
      failureDiagnostic: { kind: 'authentication' },
    });
    expect(httpClient).not.toHaveBeenCalled();
  });

  it('classifies an Exa create timeout as maybe-accepted, not a proven rejection', async () => {
    const provider = new ExaResearchProvider({
      credentials: { env: { EXA_API_KEY: 'test-key' } },
      httpClient: async () => {
        throw new HttpRequestTimeoutError(30_000);
      },
    });
    await expect(
      provider.submit('query', { timeout: 10 }),
    ).rejects.toMatchObject({
      name: 'UnsafeToRetrySubmissionError',
      failureDiagnostic: { kind: 'timeout' },
    });
  });

  it('validates the You.com background lifecycle and completed output', async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const httpClient: HttpClient = async <_T>(url, options) => {
      calls.push({ url, body: options?.body });
      if (options?.method === 'POST') {
        return response(
          {
            task_id: YOU_ID,
            type: 'research',
            status: 'queued',
            created_at: '2026-08-12T12:00:00.000Z',
          },
          202,
        ) as never;
      }
      return response(
        youTask({
          status: 'completed',
          completed_at: '2026-08-12T12:01:00.000Z',
          result: {
            output: {
              content: { conclusion: 'report' },
              content_type: 'object',
              sources: [{ url: 'https://you.example' }],
            },
            warnings: [],
          },
        }),
      ) as never;
    };
    const provider = new YouResearchBackgroundProvider({
      credentials: { env: { YOU_COM_API_KEY: 'test-key' } },
      httpClient,
      researchEffort: 'frontier',
      outputSchema: {
        type: 'object',
        properties: { conclusion: { type: 'string' } },
        required: ['conclusion'],
        additionalProperties: false,
      },
      includeDomains: ['example.com'],
      country: 'ca',
    });
    const handle = await provider.submit('query', { timeout: 10 });
    await expect(provider.poll(handle)).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(provider.retrieve(handle)).resolves.toMatchObject({
      content: '{\n  "conclusion": "report"\n}',
    });
    expect(calls[0]?.body).toMatchObject({
      background: true,
      research_effort: 'frontier',
    });
  });

  it('fails closed on malformed and empty You.com completed responses', async () => {
    for (const data of [
      youTask({ status: 'mystery' }),
      youTask({
        status: 'completed',
        result: { output: { content: '', sources: [] } },
      }),
    ]) {
      const provider = new YouResearchBackgroundProvider({
        credentials: { env: { YOU_COM_API_KEY: 'test-key' } },
        httpClient: async () => response(data) as never,
      });
      const result = await provider.retrieve({
        provider: provider.id,
        taskId: YOU_ID,
        query: 'q',
        submittedAt: 0,
        status: 'completed',
      });
      expect(result.error).toBeTruthy();
      expect(result.content).toBe('');
    }
  });

  it('preserves a valid You.com remote id from a malformed create response', async () => {
    const provider = new YouResearchBackgroundProvider({
      credentials: { env: { YOU_COM_API_KEY: 'test-key' } },
      httpClient: async () =>
        response({ task_id: YOU_ID, status: 'mystery' }, 202) as never,
    });
    await expect(
      provider.submit('query', { timeout: 10 }),
    ).resolves.toMatchObject({
      taskId: YOU_ID,
      status: 'failed',
      providerStatus: 'invalid_response',
    });
  });

  it('uses Tavily 201 create, repeated 202 progress, then strict 200 completion', async () => {
    let gets = 0;
    const calls: string[] = [];
    const httpClient: HttpClient = async <_T>(url, options) => {
      calls.push(url);
      if (options?.method === 'POST') {
        return response(
          {
            request_id: 'tavily-run',
            created_at: '2026-08-12T12:00:00.000Z',
            status: 'pending',
            input: 'query',
            model: 'pro',
            response_time: 0.1,
          },
          201,
        ) as never;
      }
      gets += 1;
      if (gets <= 2)
        return response(
          { request_id: 'tavily-run', status: 'in_progress', response_time: 1 },
          202,
        ) as never;
      return response({
        request_id: 'tavily-run',
        created_at: '2026-08-12T12:00:00.000Z',
        status: 'completed',
        content: { conclusion: 'report' },
        sources: [{ title: 'Tavily', url: 'https://tavily.example' }],
        response_time: 2,
      }) as never;
    };
    const provider = new TavilyResearchProvider({
      credentials: { env: { TAVILY_API_KEY: 'test-key' } },
      httpClient,
      model: 'pro',
    });
    const handle = await provider.submit('query', { timeout: 10 });
    await expect(provider.poll(handle)).resolves.toMatchObject({
      status: 'running',
    });
    await expect(provider.poll(handle)).resolves.toMatchObject({
      status: 'running',
    });
    await expect(provider.poll(handle)).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(provider.retrieve(handle)).resolves.toMatchObject({
      content: '{\n  "conclusion": "report"\n}',
    });
    expect(calls[0]).toBe('https://api.tavily.com/research');
    expect(new Set(calls.slice(1))).toEqual(
      new Set(['https://api.tavily.com/research/tavily-run']),
    );
  });

  it('keeps malformed Tavily status nonterminal and rejects empty retrieval', async () => {
    const provider = new TavilyResearchProvider({
      credentials: { env: { TAVILY_API_KEY: 'test-key' } },
      httpClient: vi.fn(async () =>
        response({
          request_id: 'tavily-run',
          created_at: '2026-08-12T12:00:00.000Z',
          status: 'completed',
          content: '',
          sources: [],
          response_time: 1,
        }),
      ) as HttpClient,
    });
    const handle = {
      provider: provider.id,
      taskId: 'tavily-run',
      query: 'q',
      submittedAt: 0,
      status: 'running' as const,
    };
    await expect(provider.poll(handle)).rejects.toMatchObject({
      message: 'Tavily Research status check failed.',
      failureDiagnostic: { kind: 'provider', httpStatus: 200 },
    });
    await expect(provider.retrieve(handle)).resolves.toMatchObject({
      content: '',
      error: expect.any(String),
    });
  });

  it('preserves a valid Tavily remote id from a malformed create response', async () => {
    const provider = new TavilyResearchProvider({
      credentials: { env: { TAVILY_API_KEY: 'test-key' } },
      httpClient: async () =>
        response(
          { request_id: 'tavily-preserved', status: 'mystery' },
          201,
        ) as never,
    });
    await expect(
      provider.submit('query', { timeout: 10 }),
    ).resolves.toMatchObject({
      taskId: 'tavily-preserved',
      status: 'pending',
      providerStatus: 'invalid_response',
      lastPollError: 'Tavily returned a malformed create response',
    });
  });

  it('recovers exactly one uncertain Tavily submission from project-scoped logs without resubmitting', async () => {
    const httpClient = vi.fn(async <_T>(url: string, _options = {}) => {
      if (url === 'https://api.tavily.com/research') {
        throw new TypeError('fetch failed after write');
      }
      expect(url).toBe('https://api.tavily.com/logs');
      return response({
        logs: [
          {
            timestamp: '2026-08-23T12:00:00.000Z',
            endpoint: 'research',
            request_id: 'recovered-task',
          },
        ],
        count: 1,
      }) as never;
    }) as HttpClient;
    const provider = new TavilyResearchProvider({
      credentials: { env: { TAVILY_API_KEY: 'test-key' } },
      httpClient,
    });

    await expect(
      provider.submit('query', {
        timeout: 10,
        submissionId: 'attempt-frozen-123',
      }),
    ).resolves.toMatchObject({
      taskId: 'recovered-task',
      status: 'pending',
      providerStatus: 'reconciled_from_logs',
    });

    const submissionCalls = httpClient.mock.calls.filter(
      ([url]) => url === 'https://api.tavily.com/research',
    );
    expect(submissionCalls).toHaveLength(1);
    expect(submissionCalls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-key',
        'X-Project-ID': 'attempt-frozen-123',
      },
    });
    const logsCall = httpClient.mock.calls.find(
      ([url]) => url === 'https://api.tavily.com/logs',
    );
    expect(logsCall?.[1]).toMatchObject({
      method: 'POST',
      body: {
        limit: 2,
        endpoints: ['research'],
        project_id: 'attempt-frozen-123',
        filter_by_api_key: true,
      },
    });
  });

  it('refuses ambiguous Tavily log custody and never resubmits', async () => {
    const httpClient = vi.fn(async <_T>(url: string) => {
      if (url === 'https://api.tavily.com/research') {
        throw new TypeError('fetch failed after write');
      }
      return response({
        logs: ['one', 'two'].map((suffix) => ({
          timestamp: '2026-08-23T12:00:00.000Z',
          endpoint: 'research',
          request_id: `task-${suffix}`,
        })),
        count: 2,
      }) as never;
    }) as HttpClient;
    const provider = new TavilyResearchProvider({
      credentials: { env: { TAVILY_API_KEY: 'test-key' } },
      httpClient,
    });

    await expect(
      provider.submit('query', {
        timeout: 10,
        submissionId: 'attempt-frozen-ambiguous',
      }),
    ).rejects.toMatchObject({
      name: 'UnsafeToRetrySubmissionError',
      failureDiagnostic: { kind: 'network' },
    });
    expect(
      httpClient.mock.calls.filter(
        ([url]) => url === 'https://api.tavily.com/research',
      ),
    ).toHaveLength(1);
  });

  it.each([
    ['malformed progress', response({ status: 'in_progress' }, 202), 202],
    ['malformed success', response({ status: 'completed' }, 200), 200],
    ['authentication', response({}, 401), 401],
    ['authorization', response({}, 403), 403],
    ['billing', response({}, 433), 433],
    ['invalid request', response({}, 422), 422],
  ] as const)(
    'keeps accepted Tavily custody on $label poll evidence',
    async (_label, pollResponse, httpStatus) => {
      const provider = new TavilyResearchProvider({
        credentials: { env: { TAVILY_API_KEY: 'test-key' } },
        httpClient: vi.fn(async () => pollResponse) as HttpClient,
      });
      const handle = {
        provider: provider.id,
        taskId: 'tavily-run',
        query: 'q',
        submittedAt: 0,
        status: 'running' as const,
      };

      await expect(provider.poll(handle)).rejects.toMatchObject({
        message: 'Tavily Research status check failed.',
        failureDiagnostic: { httpStatus },
      });
      expect(handle).toEqual(
        expect.objectContaining({ taskId: 'tavily-run', status: 'running' }),
      );
    },
  );

  it.each([
    'file:///private/report',
    'javascript:alert(1)',
    'data:text/plain,report',
    'https://user:password@example.com/report',
    'not a URL',
  ])('rejects unsafe Tavily citation URL %s', async (url) => {
    const provider = new TavilyResearchProvider({
      credentials: { env: { TAVILY_API_KEY: 'test-key' } },
      httpClient: async () =>
        response({
          request_id: 'tavily-run',
          created_at: '2026-08-12T12:00:00.000Z',
          status: 'completed',
          content: 'report',
          sources: [{ title: 'unsafe', url }],
          response_time: 1,
        }) as never,
    });

    await expect(
      provider.retrieve({
        provider: provider.id,
        taskId: 'tavily-run',
        query: 'q',
        submittedAt: 0,
        status: 'completed',
      }),
    ).resolves.toMatchObject({
      content: '',
      citations: [],
      error: 'Tavily Research retrieval failed.',
    });
  });

  it.each([
    {
      label: 'authentication',
      implementation: async () =>
        response({ error: { message: 'secret invalid token' } }, 401) as never,
      diagnostic: { kind: 'authentication', httpStatus: 401 },
    },
    {
      label: 'plan restriction',
      implementation: async () =>
        response({ detail: { error: 'PLAN_REQUIRED' } }, 403) as never,
      diagnostic: { kind: 'plan_required', httpStatus: 403 },
    },
    {
      label: 'rate limit',
      implementation: async () =>
        response({ detail: { error: 'plan upgrade required' } }, 429) as never,
      diagnostic: { kind: 'rate_limit', httpStatus: 429 },
    },
    {
      label: 'plan usage limit',
      implementation: async () =>
        response({ detail: { error: 'usage limit reached' } }, 432) as never,
      diagnostic: { kind: 'plan_required', httpStatus: 432 },
    },
    {
      label: 'pay-as-you-go limit',
      implementation: async () =>
        response({ detail: { error: 'paygo limit reached' } }, 433) as never,
      diagnostic: { kind: 'billing', httpStatus: 433 },
    },
    {
      label: 'invalid request',
      implementation: async () => response({}, 422) as never,
      diagnostic: { kind: 'invalid_request', httpStatus: 422 },
    },
    {
      label: 'provider response',
      implementation: async () => response({}, 503) as never,
      diagnostic: { kind: 'provider', httpStatus: 503 },
    },
    {
      label: 'request timeout with quota text',
      implementation: async () =>
        response({ detail: { error: 'quota exceeded' } }, 408) as never,
      diagnostic: { kind: 'timeout', httpStatus: 408 },
    },
    {
      label: 'gateway timeout with quota text',
      implementation: async () =>
        response({ detail: { error: 'quota exceeded' } }, 504) as never,
      diagnostic: { kind: 'timeout', httpStatus: 504 },
    },
    {
      label: 'provider failure with quota text',
      implementation: async () =>
        response({ detail: { error: 'quota exceeded' } }, 500) as never,
      diagnostic: { kind: 'provider', httpStatus: 500 },
    },
    {
      label: 'network failure',
      implementation: async () => {
        throw new TypeError('fetch failed https://secret.example/token');
      },
      diagnostic: { kind: 'network' },
    },
    {
      label: 'timeout',
      implementation: async () => {
        throw new DOMException('secret timeout detail', 'TimeoutError');
      },
      diagnostic: { kind: 'timeout' },
    },
    {
      label: 'invalid 201 handle',
      implementation: async () => response({ status: 'pending' }, 201) as never,
      diagnostic: { kind: 'provider', httpStatus: 201 },
    },
  ])(
    'keeps Tavily $label submission failures bounded and unsafe to retry',
    async ({ implementation, diagnostic }) => {
      const httpClient = vi.fn(implementation);
      const provider = new TavilyResearchProvider({
        credentials: { env: { TAVILY_API_KEY: 'test-key' } },
        httpClient,
      });

      const submission = provider.submit('query', { timeout: 10 });
      await expect(submission).rejects.toMatchObject({
        name: 'UnsafeToRetrySubmissionError',
        message:
          'Tavily Research submission failed before a valid handle was returned.',
        failureDiagnostic: diagnostic,
      });
      await expect(submission).rejects.not.toThrow(
        /secret|token|https?:|PLAN_REQUIRED/i,
      );
      expect(httpClient).toHaveBeenCalledTimes(1);
    },
  );

  it('redacts Tavily terminal and transport failures at poll and retrieval boundaries', async () => {
    const terminalFailure = {
      request_id: 'tavily-run',
      status: 'failed',
      error: { message: 'Bearer secret-token https://secret.example/raw' },
    };
    const terminal = new TavilyResearchProvider({
      credentials: { env: { TAVILY_API_KEY: 'test-key' } },
      httpClient: vi.fn(async () => response(terminalFailure)) as HttpClient,
    });
    const handle = {
      provider: terminal.id,
      taskId: 'tavily-run',
      query: 'q',
      submittedAt: 0,
      status: 'running' as const,
    };

    await expect(terminal.poll(handle)).resolves.toEqual({
      status: 'failed',
      rawStatus: 'failed',
      message: 'Tavily Research task failed.',
      failureDiagnostic: { kind: 'provider' },
    });
    await expect(terminal.retrieve(handle)).resolves.toMatchObject({
      content: '',
      error: 'Tavily Research retrieval failed.',
      failureDiagnostic: { kind: 'provider', httpStatus: 200 },
    });

    const transport = new TavilyResearchProvider({
      credentials: { env: { TAVILY_API_KEY: 'test-key' } },
      httpClient: vi.fn(async () => {
        throw new TypeError('fetch failed https://secret.example/Bearer-token');
      }) as HttpClient,
    });
    await expect(transport.poll(handle)).rejects.toMatchObject({
      message: 'Tavily Research status check failed.',
      failureDiagnostic: { kind: 'network' },
    });
    await expect(transport.retrieve(handle)).resolves.toMatchObject({
      error: 'Tavily Research retrieval failed.',
      failureDiagnostic: { kind: 'network' },
    });

    const serialized = JSON.stringify([
      await terminal.retrieve(handle),
      await transport.retrieve(handle),
    ]);
    expect(serialized).not.toMatch(/secret|bearer|https?:|raw/i);
  });

  it('rejects invalid structured and source options before any transport call', async () => {
    const invalidCases = [
      {
        provider: 'exa' as const,
        options: { outputSchema: {} },
      },
      {
        provider: 'tavily' as const,
        options: { outputSchema: { type: 'object' } },
      },
      {
        provider: 'you-research' as const,
        options: { freshness: 'soon' },
      },
      {
        provider: 'you-research' as const,
        options: {
          includeDomains: Array.from(
            { length: 501 },
            (_, index) => `d${index}.example`,
          ),
        },
      },
      {
        provider: 'you-research' as const,
        options: {
          outputSchema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: [],
            additionalProperties: true,
          },
        },
      },
    ];
    for (const testCase of invalidCases) {
      const transport = vi.fn();
      await initializeProviders({
        providers: {
          [testCase.provider]: { enabled: true, options: testCase.options },
        },
        credentials: {
          env: {
            EXA_API_KEY: 'test-key',
            TAVILY_API_KEY: 'test-key',
            YOU_COM_API_KEY: 'test-key',
          },
        },
        httpClient: transport as HttpClient,
      });
      const id =
        testCase.provider === 'tavily'
          ? 'tavily-research'
          : testCase.provider === 'exa'
            ? 'exa-research'
            : 'you-research-background';
      const provider = getExactProvider(id);
      expect(provider?.configurationError).toBeTruthy();
      await expect(
        provider?.execute('query', { timeout: 10 }),
      ).resolves.toMatchObject({
        error: expect.any(String),
      });
      expect(transport).not.toHaveBeenCalled();
    }
  });
});
