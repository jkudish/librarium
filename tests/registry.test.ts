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
    expect(meta[0].enabled).toBe(true);
    expect(meta[0].hasApiKey).toBe(true);
  });

  it('initializeProviders registers all 10 providers', async () => {
    await initializeProviders();
    const all = getAllProviders();
    expect(all).toHaveLength(10);

    const ids = all.map((p) => p.id);
    expect(ids).toContain('perplexity-deep');
    expect(ids).toContain('openai-deep');
    expect(ids).toContain('gemini-deep');
    expect(ids).toContain('perplexity-sonar');
    expect(ids).toContain('brave-answers');
    expect(ids).toContain('exa');
    expect(ids).toContain('brave-search');
    expect(ids).toContain('searchapi');
    expect(ids).toContain('serpapi');
    expect(ids).toContain('tavily');
  });

  it('initializeProviders applies gemini model config override', async () => {
    await initializeProviders({
      'gemini-deep': {
        model: 'gemini-2.5-pro',
      },
    });

    const gemini = getProvider('gemini-deep');
    expect(gemini).toBeDefined();
    expect((gemini as { model?: string }).model).toBe('gemini-2.5-pro');
  });
});
