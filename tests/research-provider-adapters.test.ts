import { describe, expect, it, vi } from 'vitest';
import { ExaResearchProvider } from '../src/adapters/exa-research.js';
import {
  getAllProviders,
  getExactProvider,
  initializeProviders,
} from '../src/adapters/index.js';
import { TavilyResearchProvider } from '../src/adapters/tavily-research.js';
import { YouResearchBackgroundProvider } from '../src/adapters/you-research-background.js';
import type { HttpClient } from '../src/core/http-client.js';
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

  it('fails closed on malformed status and empty Tavily completion', async () => {
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
    await expect(provider.poll(handle)).resolves.toMatchObject({
      status: 'failed',
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
      status: 'failed',
      providerStatus: 'invalid_response',
    });
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
