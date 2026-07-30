import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Provider,
  ProviderOptions,
  ProviderResult,
} from '../src/types.js';

// We need to re-import the module fresh for each test to avoid
// shared state between tests. We use dynamic imports and module invalidation.

// Create a minimal mock provider for testing
function createMockProvider(
  id: string,
  tier: 'deep-research' | 'ai-grounded' | 'raw-search' = 'raw-search',
): Provider {
  return {
    id,
    displayName: `Mock ${id}`,
    tier,
    envVar: `MOCK_${id.toUpperCase().replace(/-/g, '_')}_KEY`,
    execute: async (
      _query: string,
      _options: ProviderOptions,
    ): Promise<ProviderResult> => ({
      provider: id,
      tier,
      content: 'mock content',
      citations: [],
      durationMs: 100,
    }),
  };
}

describe('registry', () => {
  // We need to isolate the module state between tests
  let registerProvider: typeof import('../src/adapters/index.js').registerProvider;
  let getProvider: typeof import('../src/adapters/index.js').getProvider;
  let getAllProviders: typeof import('../src/adapters/index.js').getAllProviders;
  let getProvidersByTier: typeof import('../src/adapters/index.js').getProvidersByTier;
  let getProviderMeta: typeof import('../src/adapters/index.js').getProviderMeta;
  let initializeProviders: typeof import('../src/adapters/index.js').initializeProviders;

  beforeEach(async () => {
    // Use dynamic import with cache busting by resetting module state
    // Since the Map is module-level, we import fresh
    vi.resetModules();
    const mod = await import('../src/adapters/index.js');
    registerProvider = mod.registerProvider;
    getProvider = mod.getProvider;
    getAllProviders = mod.getAllProviders;
    getProvidersByTier = mod.getProvidersByTier;
    getProviderMeta = mod.getProviderMeta;
    initializeProviders = mod.initializeProviders;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registerProvider adds to registry', () => {
    const provider = createMockProvider('test-provider');
    registerProvider(provider);
    expect(getProvider('test-provider')).toBe(provider);
  });

  it('getProvider returns registered provider', () => {
    const provider = createMockProvider('my-provider');
    registerProvider(provider);
    const result = getProvider('my-provider');
    expect(result).toBeDefined();
    expect(result!.id).toBe('my-provider');
  });

  it('getProvider returns undefined for unknown', () => {
    expect(getProvider('nonexistent-provider')).toBeUndefined();
  });

  it('getAllProviders returns all registered', () => {
    registerProvider(createMockProvider('provider-a'));
    registerProvider(createMockProvider('provider-b'));
    registerProvider(createMockProvider('provider-c'));
    const all = getAllProviders();
    expect(all).toHaveLength(3);
    const ids = all.map((p) => p.id);
    expect(ids).toContain('provider-a');
    expect(ids).toContain('provider-b');
    expect(ids).toContain('provider-c');
  });

  it('getProvidersByTier filters correctly', () => {
    registerProvider(createMockProvider('deep-1', 'deep-research'));
    registerProvider(createMockProvider('ai-1', 'ai-grounded'));
    registerProvider(createMockProvider('raw-1', 'raw-search'));
    registerProvider(createMockProvider('raw-2', 'raw-search'));

    const deepProviders = getProvidersByTier('deep-research');
    expect(deepProviders).toHaveLength(1);
    expect(deepProviders[0].id).toBe('deep-1');

    const rawProviders = getProvidersByTier('raw-search');
    expect(rawProviders).toHaveLength(2);
  });

  it('getProviderMeta returns correct metadata', () => {
    registerProvider(createMockProvider('test-meta', 'ai-grounded'));

    const config = {
      'test-meta': {
        apiKey: 'literal-key',
        enabled: true,
      },
    };

    const meta = getProviderMeta(config);
    expect(meta).toHaveLength(1);
    expect(meta[0].id).toBe('test-meta');
    expect(meta[0].tier).toBe('ai-grounded');
    expect(meta[0].source).toBe('builtin');
    expect(meta[0].enabled).toBe(true);
    expect(meta[0].hasApiKey).toBe(true);
  });

  it('initializeProviders registers all 24 providers', async () => {
    await initializeProviders();
    const all = getAllProviders();
    expect(all).toHaveLength(24);

    const ids = all.map((p) => p.id);
    expect(ids).toContain('perplexity-sonar-deep');
    expect(ids).toContain('perplexity-deep-research');
    expect(ids).toContain('perplexity-advanced-deep');
    expect(ids).toContain('openai-research');
    expect(ids).not.toContain('openai-deep');
    expect(ids).not.toContain('openai-deep-o3');
    expect(ids).toContain('gemini-deep');
    expect(ids).toContain('gemini-grounded');
    expect(ids).toContain('grok');
    expect(ids).toContain('openrouter-online');
    expect(ids).toContain('perplexity-sonar-pro');
    expect(ids).toContain('brave-answers');
    expect(ids).toContain('exa');
    expect(ids).toContain('you-research');
    expect(ids).toContain('kagi-fastgpt');
    expect(ids).toContain('perplexity-search');
    expect(ids).toContain('brave-search');
    expect(ids).toContain('jina-search');
    expect(ids).toContain('firecrawl-search');
    expect(ids).toContain('searchapi');
    expect(ids).toContain('serpapi');
    expect(ids).toContain('tavily');
    expect(ids).toContain('claude');
    expect(ids).toContain('openai-chat');
    expect(ids).toContain('gemini-chat');
    expect(ids).toContain('openrouter-chat');
  });

  it('registers llm-tier providers with the llm tier', async () => {
    await initializeProviders();
    for (const id of [
      'claude',
      'openai-chat',
      'gemini-chat',
      'openrouter-chat',
    ]) {
      expect(getProvider(id)?.tier).toBe('llm');
    }
    expect(getProvider('gemini-chat')).toMatchObject({
      model: 'gemini-3.6-flash',
    });
    expect(getProvider('openrouter-chat')).toMatchObject({
      model: 'openai/gpt-5.6-terra',
    });
  });

  it('applies model config override to llm-tier providers', async () => {
    await initializeProviders({
      providers: {
        claude: { model: 'claude-opus-4-8' },
        'openai-chat': { model: 'gpt-4o' },
        'gemini-chat': { model: 'gemini-2.0-flash' },
        'openrouter-chat': { model: 'anthropic/claude-3.5-haiku' },
        grok: { model: 'grok-4.3' },
      },
    });
    expect((getProvider('claude') as { model?: string }).model).toBe(
      'claude-opus-4-8',
    );
    expect((getProvider('openai-chat') as { model?: string }).model).toBe(
      'gpt-4o',
    );
    expect((getProvider('gemini-chat') as { model?: string }).model).toBe(
      'gemini-2.0-flash',
    );
    expect((getProvider('openrouter-chat') as { model?: string }).model).toBe(
      'anthropic/claude-3.5-haiku',
    );
    expect((getProvider('grok') as { model?: string }).model).toBe('grok-4.3');
  });

  it('enables llm web search by default and allows global/provider overrides', async () => {
    await initializeProviders();
    expect((getProvider('claude') as { webSearch?: boolean }).webSearch).toBe(
      true,
    );
    expect(
      (getProvider('openai-chat') as { webSearch?: boolean }).webSearch,
    ).toBe(true);

    await initializeProviders({
      defaults: {
        outputDir: './agents/librarium',
        maxParallel: 6,
        timeout: 30,
        asyncTimeout: 1800,
        asyncPollInterval: 10,
        mode: 'mixed',
        llmWebSearch: false,
      },
      providers: {
        'openai-chat': { options: { webSearch: true } },
      },
    });
    expect((getProvider('claude') as { webSearch?: boolean }).webSearch).toBe(
      false,
    );
    expect(
      (getProvider('openai-chat') as { webSearch?: boolean }).webSearch,
    ).toBe(true);
  });

  it('initializeProviders applies gemini model config override', async () => {
    await initializeProviders({
      providers: {
        'gemini-deep': {
          model: 'gemini-2.5-pro',
        },
      },
    });

    const gemini = getProvider('gemini-deep');
    expect(gemini).toBeDefined();
    expect((gemini as { model?: string }).model).toBe('gemini-2.5-pro');
  });

  it('applies OpenAI research model and research options config', async () => {
    await initializeProviders({
      providers: {
        'openai-research': {
          model: 'gpt-5.6-sol-custom',
          options: { maxToolCalls: 4, returnTokenBudget: 'unlimited' },
        },
      },
    });
    expect(getProvider('openai-research')).toMatchObject({
      id: 'openai-research',
      model: 'gpt-5.6-sol-custom',
      maxToolCalls: 4,
      returnTokenBudget: 'unlimited',
    });
  });

  it('getProvider resolves legacy provider ID aliases', async () => {
    await initializeProviders();
    expect(getProvider('perplexity-sonar')?.id).toBe('perplexity-sonar-pro');
    expect(getProvider('perplexity-deep')?.id).toBe('perplexity-sonar-deep');
    expect(getProvider('openai-deep')?.id).toBe('openai-research');
    expect(getProvider('openai-deep-o3')?.id).toBe('openai-research');
  });
});
