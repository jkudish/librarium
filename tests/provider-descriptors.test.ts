import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAllProviders,
  getProvider,
  initializeProviders,
} from '../src/adapters/index.js';
import { PerplexitySearchOptionsSchema } from '../src/adapters/perplexity-search-options.js';
import { BUILTIN_PROVIDER_DESCRIPTORS } from '../src/adapters/provider-descriptors.js';
import {
  computeInitProviderChoices,
  DEFAULT_GROUPS,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_ENV_VARS,
  PROVIDER_ID_ALIASES,
  validateDefaultGroups,
} from '../src/constants.js';
import { getMeteringKind } from '../src/core/metering.js';
import { PROVIDER_CATALOG } from '../src/core/provider-catalog.js';
import { BUILTIN_PROVIDER_CATALOG } from '../src/core/provider-profiles.js';
import { RETIRED_PROVIDER_REPLACEMENTS } from '../src/core/retired-provider-ids.js';
import { searchApiOptionsSchema } from '../src/core/searchapi.js';

describe('built-in provider descriptors', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('drives registry, catalog, credentials, aliases, and metering', async () => {
    await initializeProviders();
    expect(BUILTIN_PROVIDER_DESCRIPTORS).toHaveLength(37);
    expect(getAllProviders()).toHaveLength(BUILTIN_PROVIDER_DESCRIPTORS.length);

    for (const descriptor of BUILTIN_PROVIDER_DESCRIPTORS) {
      const provider = getProvider(descriptor.id);
      expect(provider).toMatchObject({
        id: descriptor.id,
        displayName: descriptor.display.name,
        envVar: descriptor.credential.envVar,
        tier: descriptor.tier,
        execution: descriptor.capabilities.execution,
      });
      expect(PROVIDER_DISPLAY_NAMES[descriptor.id]).toBe(
        descriptor.display.name,
      );
      expect(PROVIDER_ENV_VARS[descriptor.id]).toBe(
        descriptor.credential.envVar,
      );
      expect(PROVIDER_CATALOG[descriptor.id]).toMatchObject({
        displayName: descriptor.display.name,
        envVar: descriptor.credential.envVar,
        tier: descriptor.tier,
        defaultModel: descriptor.defaultModel,
      });
      expect(getMeteringKind(descriptor.id)).toBe(descriptor.metering.kind);
      for (const alias of descriptor.aliases) {
        expect(PROVIDER_ID_ALIASES[alias]).toBe(descriptor.id);
      }
      if (descriptor.defaultModel && provider && 'model' in provider) {
        expect(provider.model).toBe(descriptor.defaultModel);
      }
    }
  });

  it('keeps retired ids out of the active registry and alias map', async () => {
    await initializeProviders();
    for (const id of Object.keys(RETIRED_PROVIDER_REPLACEMENTS)) {
      expect(getProvider(id)).toBeUndefined();
      expect(PROVIDER_ID_ALIASES[id]).toBeUndefined();
      expect(getAllProviders().map((provider) => provider.id)).not.toContain(
        id,
      );
    }
  });

  it('preserves the established registry order independently of catalog order', async () => {
    await initializeProviders();
    expect(getAllProviders().map(({ id }) => id)).toEqual([
      'perplexity-sonar-deep',
      'perplexity-deep-research',
      'openai-research',
      'gemini-deep',
      'parallel-research',
      'perplexity-sonar-pro',
      'gemini-grounded',
      'grok',
      'openrouter-online',
      'brave-answers',
      'exa',
      'you-research',
      'you-answer',
      'kagi-fastgpt',
      'perplexity-search',
      'brave-search',
      'jina-search',
      'firecrawl-search',
      'searchapi',
      'serpapi',
      'tavily',
      'claude',
      'openai-chat',
      'gemini-chat',
      'openrouter-chat',
      'parallel-search',
      'parallel-turbo',
      'searchapi-chatgpt',
      'searchapi-gemini',
      'searchapi-perplexity',
      'searchapi-google-ai-mode',
      'searchapi-bing-copilot',
      'searchapi-google-ai-overview',
      'grok-x-only',
      'grok-combined',
      'valyu-search',
      'valyu-research',
    ]);
  });

  it('declares descriptor-owned setup policy for shared credentials', () => {
    const optIn = BUILTIN_PROVIDER_DESCRIPTORS.filter(
      ({ credential }) => !credential.autoEnable,
    ).map(({ id }) => id);

    expect(optIn).toEqual(
      expect.arrayContaining([
        'searchapi-chatgpt',
        'searchapi-gemini',
        'searchapi-perplexity',
        'searchapi-google-ai-mode',
        'searchapi-bing-copilot',
        'searchapi-google-ai-overview',
        'claude',
        'openai-chat',
        'gemini-chat',
        'openrouter-chat',
        'parallel-research',
        'parallel-search',
        'parallel-turbo',
        'you-answer',
      ]),
    );
    expect(
      BUILTIN_PROVIDER_DESCRIPTORS.find(({ id }) => id === 'searchapi')
        ?.credential.autoEnable,
    ).toBe(true);
    expect(
      BUILTIN_PROVIDER_DESCRIPTORS.find(
        ({ id }) => id === 'perplexity-sonar-pro',
      )?.credential.autoEnable,
    ).toBe(true);
  });

  it('keeps Brave Answers and Brave Search credentials distinct', () => {
    expect(PROVIDER_ENV_VARS['brave-answers']).toBe('BRAVE_ANSWERS_API_KEY');
    expect(PROVIDER_ENV_VARS['brave-search']).toBe('BRAVE_API_KEY');
    expect(
      BUILTIN_PROVIDER_CATALOG.find(
        ({ provider_id }) => provider_id === 'brave-answers',
      )?.credential.env_var,
    ).toBe(PROVIDER_ENV_VARS['brave-answers']);
    expect(
      BUILTIN_PROVIDER_CATALOG.find(
        ({ provider_id }) => provider_id === 'brave-search',
      )?.credential.env_var,
    ).toBe(PROVIDER_ENV_VARS['brave-search']);

    const answerOnly = computeInitProviderChoices({
      BRAVE_ANSWERS_API_KEY: 'answers-fixture-key',
    }).filter(({ id }) => id.startsWith('brave-'));
    const searchOnly = computeInitProviderChoices({
      BRAVE_API_KEY: 'search-fixture-key',
    }).filter(({ id }) => id.startsWith('brave-'));

    expect(
      answerOnly.map(({ id, enableByDefault }) => ({ id, enableByDefault })),
    ).toEqual([
      { id: 'brave-answers', enableByDefault: true },
      { id: 'brave-search', enableByDefault: false },
    ]);
    expect(
      searchOnly.map(({ id, enableByDefault }) => ({ id, enableByDefault })),
    ).toEqual([
      { id: 'brave-answers', enableByDefault: false },
      { id: 'brave-search', enableByDefault: true },
    ]);
  });

  it('keeps every Parallel profile opt-in when its shared key is present', () => {
    const parallel = computeInitProviderChoices({
      PARALLEL_API_KEY: 'parallel-fixture-key',
    }).filter((choice) => choice.envVar === 'PARALLEL_API_KEY');

    expect(
      parallel.map(({ id, isOptIn, enableByDefault }) => ({
        id,
        isOptIn,
        enableByDefault,
      })),
    ).toEqual([
      { id: 'parallel-research', isOptIn: true, enableByDefault: false },
      { id: 'parallel-search', isOptIn: true, enableByDefault: false },
      { id: 'parallel-turbo', isOptIn: true, enableByDefault: false },
    ]);
  });

  it('does not forward Parallel metering-only options to strict adapter schemas', async () => {
    const httpClient = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      durationMs: 1,
      data: { results: [] },
    }));
    const initialized = await initializeProviders({
      httpClient,
      credentials: { env: { PARALLEL_API_KEY: 'parallel-fixture-key' } },
      providers: { 'parallel-search': { options: { perUnitUsd: 0.01 } } },
    });

    expect(initialized.warnings).not.toContain(
      'Invalid options for parallel-search',
    );
    const result = await getProvider('parallel-search')?.execute('query', {
      timeout: 5,
    });
    expect(result?.error).toBeUndefined();
    expect(httpClient).toHaveBeenCalledOnce();
  });

  it('uses strict typed option schemas for the new integration surfaces', () => {
    for (const id of [
      'searchapi-chatgpt',
      'searchapi-gemini',
      'searchapi-perplexity',
      'searchapi-google-ai-mode',
      'searchapi-bing-copilot',
      'searchapi-google-ai-overview',
    ]) {
      expect(
        BUILTIN_PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.id === id)
          ?.optionsSchema,
      ).toBe(searchApiOptionsSchema);
    }
    expect(
      BUILTIN_PROVIDER_DESCRIPTORS.find(({ id }) => id === 'perplexity-search')
        ?.optionsSchema,
    ).toBe(PerplexitySearchOptionsSchema);
    for (const id of ['grok', 'grok-x-only', 'grok-combined'] as const) {
      expect(
        BUILTIN_PROVIDER_DESCRIPTORS.find(
          ({ id: candidate }) => candidate === id,
        )?.optionsSchema.safeParse({ undocumented: true }).success,
      ).toBe(false);
    }
    expect(
      BUILTIN_PROVIDER_DESCRIPTORS.find(
        ({ id }) => id === 'you-answer',
      )?.optionsSchema.safeParse({ undocumented: true }).success,
    ).toBe(false);
  });

  it('blocks invalid Grok options before HTTP without disabling other adapters', async () => {
    const httpClient = vi.fn();
    const result = await initializeProviders({
      httpClient,
      providers: { grok: { options: { allowedXHandles: ['xai'] } } },
    });

    expect(result.warnings.join('\n')).toContain('Invalid options for grok');
    await expect(
      getProvider('grok')?.execute('must not run', { timeout: 5 }),
    ).resolves.toMatchObject({ error: 'Invalid options for grok' });
    expect(getProvider('grok-x-only')).toBeDefined();
    expect(httpClient).not.toHaveBeenCalled();
  });

  it('rejects unsupported or contradictory OpenRouter policies before dispatch', () => {
    const grounded = BUILTIN_PROVIDER_DESCRIPTORS.find(
      ({ id }) => id === 'openrouter-online',
    )?.optionsSchema;
    const chat = BUILTIN_PROVIDER_DESCRIPTORS.find(
      ({ id }) => id === 'openrouter-chat',
    )?.optionsSchema;

    expect(grounded?.safeParse({ webSearch: false }).success).toBe(false);
    expect(
      chat?.safeParse({ reasoningEffort: 'high', reasoningMaxTokens: 100 })
        .success,
    ).toBe(false);
    expect(grounded?.safeParse({ zdr: true }).success).toBe(false);
    expect(chat?.safeParse({ zdr: true }).success).toBe(false);
    expect(chat?.safeParse({ zdr: true, webSearch: false }).success).toBe(true);
    expect(chat?.safeParse({ profile: 'grounded' }).success).toBe(false);
  });

  it('wires documented OpenRouter policies through its factory', async () => {
    const httpClient = vi.fn(async () => ({
      status: 200,
      headers: {},
      data: { choices: [{ message: { content: 'Configured answer.' } }] },
    }));
    const result = await initializeProviders({
      credentials: { env: { OPENROUTER_API_KEY: 'synthetic-key' } },
      httpClient,
      providers: {
        'openrouter-chat': {
          options: {
            webSearch: false,
            providerOrder: ['openai', 'azure'],
            allowFallbacks: false,
            requireParameters: true,
            dataCollection: 'deny',
            zdr: true,
            reasoningMaxTokens: 256,
            reasoningExclude: true,
          },
        },
      },
    });

    expect(result.warnings).toEqual([]);
    await expect(
      getProvider('openrouter-chat')?.execute('factory policy check', {
        timeout: 5,
      }),
    ).resolves.toMatchObject({ content: 'Configured answer.' });
    expect(httpClient).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        body: {
          model: 'openai/gpt-5.6-terra',
          messages: [{ role: 'user', content: 'factory policy check' }],
          provider: {
            order: ['openai', 'azure'],
            allow_fallbacks: false,
            require_parameters: true,
            data_collection: 'deny',
            zdr: true,
          },
          reasoning: { max_tokens: 256, exclude: true },
        },
      }),
    );
  });

  it('fails closed on invalid SearchAPI zeroRetention options', async () => {
    const httpClient = vi.fn();
    const result = await initializeProviders({
      httpClient,
      providers: {
        'searchapi-chatgpt': { options: { zeroRetention: 'yes' } },
      },
    });

    expect(result.warnings.join('\n')).toContain(
      'Invalid options for searchapi-chatgpt',
    );
    await expect(
      getProvider('searchapi-chatgpt')?.execute('must not run', { timeout: 5 }),
    ).resolves.toMatchObject({
      error: 'Invalid options for searchapi-chatgpt',
      preventFallback: true,
    });
    expect(httpClient).not.toHaveBeenCalled();
  });

  it('wires valid zeroRetention through every new SearchAPI factory', async () => {
    const ids = [
      'searchapi-chatgpt',
      'searchapi-gemini',
      'searchapi-perplexity',
      'searchapi-google-ai-mode',
      'searchapi-bing-copilot',
      'searchapi-google-ai-overview',
    ];
    const urls: string[] = [];
    const httpClient = vi.fn(async <T>(url: string) => {
      urls.push(url);
      return {
        status: 200,
        headers: {},
        data: {} as T,
      };
    });
    await initializeProviders({
      credentials: { env: { SEARCHAPI_API_KEY: 'synthetic-key' } },
      httpClient,
      providers: Object.fromEntries(
        ids.map((id) => [id, { options: { zeroRetention: true } }]),
      ),
    });

    for (const id of ids) {
      await getProvider(id)?.execute('factory privacy check', { timeout: 5 });
    }
    expect(urls).toHaveLength(ids.length);
    for (const url of urls) {
      expect(new URL(url).searchParams.get('zero_retention')).toBe('true');
    }
  });

  it('wires only documented Perplexity Search options through its factory', async () => {
    const httpClient = vi.fn(async () => ({
      status: 200,
      headers: {},
      data: { id: 'synthetic', results: [] },
    }));
    const result = await initializeProviders({
      credentials: { env: { PERPLEXITY_API_KEY: 'synthetic-key' } },
      httpClient,
      providers: {
        'perplexity-search': {
          options: {
            maxResults: 3,
            country: 'ca',
            searchLanguageFilter: ['en'],
            searchDomainDenylist: ['example.test'],
            maxTokens: 400,
            maxTokensPerPage: 100,
            additionalQueries: ['second query'],
          },
        },
      },
    });

    expect(result.warnings).toEqual([]);
    await getProvider('perplexity-search')?.execute('base query', {
      timeout: 5,
    });
    expect(httpClient).toHaveBeenCalledWith(
      'https://api.perplexity.ai/search',
      expect.objectContaining({
        body: {
          query: ['base query', 'second query'],
          max_results: 3,
          country: 'CA',
          search_language_filter: ['en'],
          search_domain_filter: ['-example.test'],
          max_tokens: 400,
          max_tokens_per_page: 100,
        },
      }),
    );
  });

  it('rejects unknown Perplexity Search options before HTTP', async () => {
    const httpClient = vi.fn();
    const result = await initializeProviders({
      httpClient,
      providers: {
        'perplexity-search': { options: { undocumented: true } },
      },
    });

    expect(result.warnings.join('\n')).toContain(
      'Invalid options for perplexity-search',
    );
    await expect(
      getProvider('perplexity-search')?.execute('must not run', { timeout: 5 }),
    ).resolves.toMatchObject({
      error: 'Invalid options for perplexity-search',
    });
    expect(httpClient).not.toHaveBeenCalled();
  });

  it('applies the OpenAI research defaults through provider initialization', async () => {
    const httpClient = vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      data: { id: 'response-1', status: 'queued' },
    }));
    await initializeProviders({
      credentials: { env: { OPENAI_API_KEY: 'openai-key' } },
      httpClient,
      providers: { 'openai-research': { enabled: true } },
    });

    const openai = getProvider('openai-research');
    expect(openai?.execution).toBe('background');
    if (openai?.execution !== 'background') return;

    await openai.submit('What changed?', { timeout: 10 });
    expect(httpClient).toHaveBeenCalledWith(
      'https://api.openai.com/v1/responses',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          reasoning: { effort: 'high' },
          tools: [{ type: 'web_search', return_token_budget: 'default' }],
        }),
      }),
    );
    const request = httpClient.mock.calls[0]?.[1];
    expect(request?.body).not.toHaveProperty('max_tool_calls');
  });

  it('passes parsed background factory options through unchanged', async () => {
    const httpClient = vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      data: { id: 'response-1', status: 'queued' },
    }));
    const result = await initializeProviders({
      credentials: { env: { OPENAI_API_KEY: 'openai-key' } },
      httpClient,
      providers: {
        'openai-research': {
          options: {
            maxToolCalls: 3,
            reasoningEffort: 'medium',
            returnTokenBudget: 'unlimited',
          },
        },
      },
    });

    expect(result.warnings).toEqual([]);
    const openai = getProvider('openai-research');
    expect(openai?.execution).toBe('background');
    if (openai?.execution !== 'background') return;

    await openai.submit('typed factory options', { timeout: 10 });
    expect(httpClient).toHaveBeenCalledWith(
      'https://api.openai.com/v1/responses',
      expect.objectContaining({
        body: expect.objectContaining({
          reasoning: { effort: 'medium' },
          tools: [{ type: 'web_search', return_token_budget: 'unlimited' }],
          max_tool_calls: 3,
        }),
      }),
    );
  });

  it('isolates an invalid provider option schema from other adapters', async () => {
    const httpClient = vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      data: { id: 'response-1', status: 'completed', output: [] },
    }));
    const result = await initializeProviders({
      credentials: { env: { OPENAI_API_KEY: 'openai-key' } },
      httpClient,
      providers: {
        'openai-research': {
          options: { returnTokenBudget: 'bottomless' },
        },
      },
    });

    expect(getProvider('openai-research')).toBeDefined();
    expect(getProvider('gemini-deep')).toBeDefined();
    expect(result.warnings).toEqual([
      expect.stringContaining('Invalid options for openai-research'),
    ]);

    const openai = getProvider('openai-research');
    expect(openai?.execution).toBe('background');
    if (openai?.execution !== 'background') return;

    await expect(
      openai.submit('new paid work', { timeout: 10 }),
    ).rejects.toThrow('Invalid options for openai-research');
    expect(httpClient).not.toHaveBeenCalled();

    await openai.retrieve({
      provider: 'openai-research',
      taskId: 'response-1',
      query: 'existing work',
      submittedAt: Date.now(),
      status: 'completed',
    });
    expect(httpClient).toHaveBeenCalledOnce();
  });

  it('blocks invalid LLM controls before HTTP without unregistering adapters', async () => {
    const httpClient = vi.fn();
    const ids = ['claude', 'openai-chat', 'gemini-chat', 'openrouter-chat'];
    await initializeProviders({
      httpClient,
      providers: Object.fromEntries(
        ids.map((id) => [id, { options: { webSearch: 'false' } }]),
      ),
    });

    for (const id of ids) {
      const provider = getProvider(id);
      expect(provider).toBeDefined();
      await expect(
        provider?.execute('must not run', { timeout: 10 }),
      ).resolves.toMatchObject({
        error: `Invalid options for ${id}`,
      });
      await expect(provider?.test?.()).resolves.toEqual({
        ok: false,
        error: `Invalid options for ${id}`,
      });
    }
    expect(httpClient).not.toHaveBeenCalled();
  });

  it('distinguishes remote tasks from process-local lifecycle wrappers', () => {
    const persistence = Object.fromEntries(
      BUILTIN_PROVIDER_DESCRIPTORS.filter(
        (descriptor) => descriptor.capabilities.execution === 'background',
      ).map((descriptor) => [
        descriptor.id,
        descriptor.capabilities.execution === 'background'
          ? descriptor.capabilities.taskPersistence
          : undefined,
      ]),
    );

    expect(persistence).toEqual({
      'openai-research': 'remote',
      'gemini-deep': 'remote',
      'parallel-research': 'remote',
      'perplexity-sonar-deep': 'remote',
      'perplexity-deep-research': 'remote',
      'valyu-research': 'remote',
    });
  });

  it('validates explicit default-group policy against descriptors', () => {
    expect(() => validateDefaultGroups()).not.toThrow();
    expect(() =>
      validateDefaultGroups({
        ...DEFAULT_GROUPS,
        quick: [...DEFAULT_GROUPS.quick, 'not-a-provider'],
      }),
    ).toThrow('unknown provider');
    expect(() =>
      validateDefaultGroups({
        ...DEFAULT_GROUPS,
        raw: [...DEFAULT_GROUPS.raw, DEFAULT_GROUPS.raw[0]],
      }),
    ).toThrow('repeats provider');
    expect(() =>
      validateDefaultGroups({
        ...DEFAULT_GROUPS,
        all: DEFAULT_GROUPS.all.slice(1),
      }),
    ).toThrow('must contain every non-LLM built-in provider');
  });
});
