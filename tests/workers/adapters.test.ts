import { describe, expect, it } from 'vitest';
import { GeminiGroundedProvider } from '../../src/adapters/gemini-grounded.js';
import {
  getProvider,
  initializeProviders,
  registerProvider,
} from '../../src/adapters/index.js';
import { PerplexitySearchProvider } from '../../src/adapters/perplexity-search.js';
import { SearchApiProvider } from '../../src/adapters/searchapi.js';
import { dispatch } from '../../src/core/dispatcher.js';
import type { HttpClient } from '../../src/core/http-client.js';
import type {
  Config,
  Provider,
  ProviderOptions,
  ProviderResult,
} from '../../src/types.js';

function makeConfig(): Config {
  return {
    version: 1,
    defaults: {
      outputDir: './agents/librarium',
      maxParallel: 2,
      timeout: 10,
      asyncTimeout: 60,
      asyncPollInterval: 1,
      mode: 'sync',
      llmWebSearch: true,
    },
    providers: { 'worker-mock': { enabled: true } },
    customProviders: {},
    trustedProviderIds: [],
    groups: {},
  };
}

describe('internal adapters in workerd', () => {
  it('initializes built-ins and dispatches an in-memory provider', async () => {
    await initializeProviders({
      credentials: { env: { GEMINI_API_KEY: 'test-key' } },
    });
    const gemini = new GeminiGroundedProvider({
      credentials: { env: { GEMINI_API_KEY: 'test-key' } },
    });
    expect(gemini.id).toBe('gemini-grounded');
    expect(getProvider('gemini-grounded')?.id).toBe('gemini-grounded');

    const mockProvider: Provider = {
      id: 'worker-mock',
      displayName: 'Worker Mock',
      tier: 'ai-grounded',
      execution: 'inline',
      envVar: '',
      requiresApiKey: false,
      execute: async (
        query: string,
        _options: ProviderOptions,
      ): Promise<ProviderResult> => ({
        provider: 'worker-mock',
        tier: 'ai-grounded',
        content: `workerd:${query}`,
        citations: [
          {
            url: 'https://example.com/source',
            title: 'Example Source',
            provider: 'worker-mock',
          },
        ],
        durationMs: 5,
        model: 'mock-model',
      }),
    };
    registerProvider(mockProvider);

    const result = await dispatch({
      config: makeConfig(),
      providerIds: ['worker-mock'],
      query: 'hello',
      mode: 'sync',
      credentials: { env: {} },
    });

    expect(result.asyncTasks).toEqual([]);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({
      outputFile:
        'provider-worker-mock--d31b38595ef057e4742a7edf5bdb8342f5070092f6c5739eaab6d5f54d9687ed.md',
      metaFile:
        'provider-worker-mock--d31b38595ef057e4742a7edf5bdb8342f5070092f6c5739eaab6d5f54d9687ed.meta.json',
    });
    expect(result.results[0]).toMatchObject({
      provider: 'worker-mock',
      status: 'success',
      text: 'workerd:hello',
      sourceUrls: ['https://example.com/source'],
    });
  });

  it('runs Perplexity Search through an injected transport', async () => {
    const requests: unknown[] = [];
    const provider = new PerplexitySearchProvider({
      credentials: { env: { PERPLEXITY_API_KEY: 'test-key' } },
      additionalQueries: ['worker perspective'],
      httpClient: async (_url, options) => {
        requests.push(options?.body);
        return {
          status: 200,
          statusText: 'OK',
          data: { id: 'worker-search', results: [] },
          headers: {},
          durationMs: 1,
        };
      },
    });

    await expect(
      provider.execute('worker query', { timeout: 10 }),
    ).resolves.toMatchObject({ content: 'No results found.', citations: [] });
    expect(requests).toEqual([
      { query: ['worker query', 'worker perspective'], max_results: 10 },
    ]);
  });

  it('keeps SearchAPI credentials out of bearer/ZDR request URLs', async () => {
    const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
    const httpClient: HttpClient = async <T>(url, options = {}) => {
      calls.push({ url, options });
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        data: { organic_results: [] } as T,
        durationMs: 1,
      };
    };
    const provider = new SearchApiProvider({
      apiKey: 'worker-searchapi-synthetic-key',
      httpClient,
      zeroRetention: true,
    });

    await provider.execute('worker transport', { timeout: 5 });
    expect(calls).toHaveLength(1);
    const request = calls[0];
    if (!request) throw new Error('SearchAPI request was not recorded');
    const url = new URL(request.url);
    expect(url.searchParams.has('api_key')).toBe(false);
    expect(url.searchParams.get('zero_retention')).toBe('true');
    expect(request.options.headers).toEqual({
      Authorization: 'Bearer worker-searchapi-synthetic-key',
    });
  });
});
