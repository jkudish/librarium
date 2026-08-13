import { describe, expect, it } from 'vitest';
import { ExaResearchProvider } from '../src/adapters/exa-research.js';
import {
  getAllProviders,
  getExactProvider,
  initializeProviders,
} from '../src/adapters/index.js';
import { TavilyResearchProvider } from '../src/adapters/tavily-research.js';
import { YouResearchBackgroundProvider } from '../src/adapters/you-research-background.js';
import type { HttpClient } from '../src/core/http-client.js';
import { buildProviderCatalog } from '../src/core/profile-catalog.js';

function response<T>(data: T, status = 200) {
  return { status, statusText: 'OK', data, headers: {}, durationMs: 1 };
}

describe('durable research provider adapters', () => {
  it('hides internal adapter ids while exact research bindings initialize them', async () => {
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

    const publicIds = getAllProviders().map(({ id }) => id);
    expect(publicIds).not.toEqual(
      expect.arrayContaining([
        'exa-research',
        'tavily-research',
        'you-research-background',
      ]),
    );
    for (const adapterId of [
      'exa-research',
      'tavily-research',
      'you-research-background',
    ]) {
      expect(getExactProvider(adapterId)).toMatchObject({
        id: adapterId,
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
  });

  it('submits, polls, retrieves, and remotely cancels Exa Agent work', async () => {
    const calls: Array<{ url: string; options?: unknown }> = [];
    const httpClient: HttpClient = async <_T>(url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/cancel')) {
        return response({ status: 'cancelled' }) as never;
      }
      if (options?.method === 'POST') {
        return response({ id: 'exa-run', status: 'queued' }) as never;
      }
      return response({
        status: 'completed',
        output: {
          text: 'report',
          grounding: [
            { citations: [{ url: 'https://exa.example', title: 'Exa' }] },
          ],
        },
        costDollars: { total: 0.21 },
      }) as never;
    };
    const provider = new ExaResearchProvider({
      credentials: { env: { EXA_API_KEY: 'test-key' } },
      httpClient,
      effort: 'auto',
      maxCostDollars: 1,
      outputSchema: { type: 'object' },
    });
    const handle = await provider.submit('query', { timeout: 10 });
    expect(handle).toMatchObject({
      provider: 'exa-research',
      taskId: 'exa-run',
      status: 'pending',
    });
    await expect(provider.poll(handle)).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(provider.retrieve(handle)).resolves.toMatchObject({
      content: 'report',
      citations: [{ url: 'https://exa.example' }],
      usage: { costUsd: 0.21 },
    });
    await expect(provider.cancel(handle)).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(calls[0]).toMatchObject({
      url: 'https://api.exa.ai/agent',
      options: {
        body: {
          query: 'query',
          effort: 'auto',
          budget: { maxCostDollars: 1 },
        },
      },
    });
  });

  it('always requests background You.com research, including frontier', async () => {
    const calls: Array<{ options?: { body?: unknown } }> = [];
    const httpClient: HttpClient = async <_T>(_url, options) => {
      calls.push({ options });
      if (options?.method === 'POST') {
        return response({ task_id: 'you-run', status: 'queued' }) as never;
      }
      return response({
        status: 'completed',
        result: {
          output: {
            content: { conclusion: 'report' },
            sources: [{ url: 'https://you.example' }],
          },
        },
      }) as never;
    };
    const provider = new YouResearchBackgroundProvider({
      credentials: { env: { YOU_COM_API_KEY: 'test-key' } },
      httpClient,
      researchEffort: 'frontier',
      outputSchema: { type: 'object' },
      includeDomains: ['example.com'],
      country: 'ca',
    });
    const handle = await provider.submit('query', { timeout: 10 });
    await expect(provider.poll(handle)).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(provider.retrieve(handle)).resolves.toMatchObject({
      content: '{\n  "conclusion": "report"\n}',
      citations: [{ url: 'https://you.example' }],
    });
    expect(calls[0]?.options?.body).toMatchObject({
      background: true,
      research_effort: 'frontier',
      source_control: { include_domains: ['example.com'], country: 'CA' },
    });
    expect('cancel' in provider).toBe(false);
  });

  it('uses the documented Tavily Research create and status endpoints', async () => {
    const calls: Array<{ url: string; options?: { body?: unknown } }> = [];
    const httpClient: HttpClient = async <_T>(url, options) => {
      calls.push({ url, options });
      if (options?.method === 'POST') {
        return response(
          {
            request_id: 'tavily-run',
            created_at: '2026-08-12T12:00:00.000Z',
            status: 'pending',
          },
          201,
        ) as never;
      }
      return response({
        request_id: 'tavily-run',
        status: 'completed',
        content: { conclusion: 'report' },
        sources: [{ title: 'Tavily', url: 'https://tavily.example' }],
      }) as never;
    };
    const provider = new TavilyResearchProvider({
      credentials: { env: { TAVILY_API_KEY: 'test-key' } },
      httpClient,
      model: 'pro',
      outputSchema: { type: 'object' },
      citationFormat: 'mla',
    });
    const handle = await provider.submit('query', { timeout: 10 });
    await expect(provider.poll(handle)).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(provider.retrieve(handle)).resolves.toMatchObject({
      content: '{\n  "conclusion": "report"\n}',
      citations: [{ url: 'https://tavily.example', title: 'Tavily' }],
    });
    expect(calls[0]).toMatchObject({
      url: 'https://api.tavily.com/research',
      options: {
        body: {
          input: 'query',
          model: 'pro',
          stream: false,
          output_schema: { type: 'object' },
          citation_format: 'mla',
        },
      },
    });
    expect(calls.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: 'https://api.tavily.com/research/tavily-run',
        }),
      ]),
    );
    expect('cancel' in provider).toBe(false);
  });
});
