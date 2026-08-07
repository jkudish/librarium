import {
  BUILTIN_PROVIDER_DESCRIPTORS,
  type Config,
  dispatch,
  GeminiGroundedProvider,
  getProvider,
  type HttpClient,
  type HttpStreamClient,
  httpStreamRequest,
  initializeProviders,
  PerplexitySearchProvider,
  type Provider,
  type ProviderOptions,
  type ProviderResult,
  registerProvider,
  SearchApiProvider,
} from 'librarium/core';
import { describe, expect, it } from 'vitest';
import { PerplexityProSearchProvider } from '../../src/adapters/perplexity-pro-search.js';
import {
  PRO_SEARCH_CONTENT,
  splitEveryByte,
  streamResponse,
} from '../fixtures/perplexity-pro-search.js';

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
    providers: {
      'worker-mock': {
        enabled: true,
      },
    },
    customProviders: {},
    trustedProviderIds: [],
    groups: {},
  };
}

describe('librarium/core in workerd', () => {
  it('imports the core export, initializes adapters, and dispatches in memory', async () => {
    expect(BUILTIN_PROVIDER_DESCRIPTORS).toHaveLength(24);
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
    expect(result.results).toEqual([
      {
        provider: 'worker-mock',
        tier: 'ai-grounded',
        status: 'success',
        text: 'workerd:hello',
        sourceUrls: ['https://example.com/source'],
        citations: [
          {
            url: 'https://example.com/source',
            title: 'Example Source',
            provider: 'worker-mock',
          },
        ],
        durationMs: 5,
        model: 'mock-model',
        tokenUsage: undefined,
        metering: { kind: 'manual_unmetered' },
        error: undefined,
        fallbackFor: undefined,
      },
    ]);
  });

  it('runs Perplexity Search through an injected Worker-safe transport', async () => {
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
    ).resolves.toMatchObject({
      content: 'No results found.',
      citations: [],
    });
    expect(requests).toEqual([
      { query: ['worker query', 'worker perspective'], max_results: 10 },
    ]);
  });

  it('constructs SearchAPI requests with fetch-only Worker globals', async () => {
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

    await expect(
      provider.execute('worker transport', { timeout: 5 }),
    ).resolves.toMatchObject({
      provider: 'searchapi',
      content: 'No results found.',
    });
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

  it('imports the streaming core transport and runs Pro Search in workerd', async () => {
    expect(typeof httpStreamRequest).toBe('function');
    const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
    const httpStreamClient: HttpStreamClient = async (url, options = {}) => {
      calls.push({ url, options });
      return streamResponse(splitEveryByte());
    };
    const provider = new PerplexityProSearchProvider({
      apiKey: 'worker-perplexity-synthetic-key',
      httpStreamClient,
    });

    await expect(
      provider.execute('worker Pro Search', { timeout: 5 }),
    ).resolves.toMatchObject({
      provider: 'perplexity-pro-search',
      content: PRO_SEARCH_CONTENT,
      model: 'sonar-pro',
      usage: { costUsd: 0.014138 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://api.perplexity.ai/v1/sonar',
      options: {
        body: {
          model: 'sonar-pro',
          stream: true,
          stream_mode: 'concise',
          web_search_options: { search_type: 'pro' },
        },
        retry: { mode: 'never' },
      },
    });
  });
});
