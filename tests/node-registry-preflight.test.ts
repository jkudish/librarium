import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  registerCalls: 0,
  loadCalls: [] as unknown[],
  loadedIds: undefined as string[] | undefined,
  omitProviders: false,
  descriptorOverride: {} as Partial<{
    tier: string;
    execution: string;
    requiresApiKey: boolean;
    envVar: string;
  }>,
}));

vi.mock('../src/node-entry.js', () => ({
  loadCustomProviders: vi.fn(async (options) => {
    state.loadCalls.push(options);
    const providers = Object.entries(options.customProviders).map(
      ([id, source]) => {
        const tier =
          source.executionProfile?.profile.result_kind === 'surface_observation'
            ? 'ai-grounded'
            : 'raw-search';
        const credential = source.executionProfile?.credential?.envVar;
        return {
          id,
          displayName: `Custom ${id}`,
          tier: state.descriptorOverride.tier ?? tier,
          execution:
            state.descriptorOverride.execution ??
            source.executionProfile?.profile.invocation ??
            'inline',
          envVar: state.descriptorOverride.envVar ?? credential ?? '',
          requiresApiKey:
            state.descriptorOverride.requiresApiKey ?? credential !== undefined,
          execute: async () => ({
            provider: id,
            tier,
            content: '',
            citations: [],
            durationMs: 0,
          }),
        };
      },
    );
    return {
      providers: state.omitProviders ? [] : providers,
      loadedIds: state.loadedIds ?? providers.map((provider) => provider.id),
      skippedIds: [],
      warnings: [],
    };
  }),
}));

vi.mock('../src/adapters/index.js', () => ({
  getAllProviders: () => [],
  getExactProvider: () => undefined,
  getProvider: () => undefined,
  getProviderMeta: () => [],
  getProvidersByTier: () => [],
  initializeProviders: async () => ({
    warnings: [],
    loadedCustomProviders: [],
    skippedCustomProviders: [],
  }),
  registerProvider: () => {
    state.registerCalls += 1;
  },
}));

function source(
  overrides: Partial<{
    resultKind: 'search_results' | 'surface_observation';
    invocation: 'inline' | 'background';
    credential: string;
  }> = {},
) {
  const resultKind = overrides.resultKind ?? 'search_results';
  return {
    type: 'npm' as const,
    module: 'trusted-custom-module',
    executionProfile: {
      bindingId: 'custom.search.v1',
      profile: {
        identity: {
          provider_id: 'custom',
          profile_id: 'search',
          target: { primary: { model_selection: 'not_applicable' as const } },
        },
        result_kind: resultKind,
        observation_mode:
          resultKind === 'surface_observation'
            ? ('surface_snapshot' as const)
            : ('api_output' as const),
        ...(resultKind === 'surface_observation' && {
          grounding_policy: 'required' as const,
          collector_id: 'custom',
          surface_id: 'search',
          surface_context: {
            account_context: 'anonymous' as const,
            personalization: 'absent' as const,
          },
        }),
        corpora: ['web' as const],
        retrieval_method:
          resultKind === 'surface_observation'
            ? ('surface_collector' as const)
            : ('search_endpoint' as const),
        access_mode:
          resultKind === 'surface_observation'
            ? ('collected' as const)
            : ('direct' as const),
        operator_id: 'custom',
        invocation: overrides.invocation ?? 'inline',
        resumability: 'none' as const,
      },
      ...(overrides.credential && {
        credential: { envVar: overrides.credential },
      }),
    },
  };
}

function config(
  customProviders: Record<string, ReturnType<typeof source>>,
  trustedProviderIds = Object.keys(customProviders),
) {
  return {
    providers: Object.fromEntries(
      Object.keys(customProviders).map((id) => [id, { enabled: true }]),
    ),
    customProviders,
    trustedProviderIds,
  };
}

describe('admitted custom-provider runtime guard', () => {
  beforeEach(() => {
    state.registerCalls = 0;
    state.loadCalls.length = 0;
    state.loadedIds = undefined;
    state.omitProviders = false;
    state.descriptorOverride = {};
  });

  it.each(['exa-research', 'tavily-research', 'you-research-background'])(
    'rejects custom collision %s before loading custom code',
    async (id) => {
      const { initializeProviders } = await import(
        '../src/adapters/node-registry.js'
      );
      await expect(
        initializeProviders(config({ [id]: source() }), {
          customProviderIds: [id],
        }),
      ).rejects.toThrow(/internal adapter id/);
      expect(state.loadCalls).toEqual([]);
      expect(state.registerCalls).toBe(0);
    },
  );

  it('rejects a loaded descriptor whose tier disagrees with its declaration before registration', async () => {
    state.descriptorOverride = { tier: 'deep-research' };
    const { initializeProviders } = await import(
      '../src/adapters/node-registry.js'
    );

    await expect(
      initializeProviders(
        {
          providers: { 'custom-search': { enabled: true } },
          customProviders: {
            'custom-search': {
              type: 'npm',
              module: 'trusted-but-mismatched',
              executionProfile: {
                bindingId: 'custom.search.v1',
                profile: {
                  identity: {
                    provider_id: 'custom',
                    profile_id: 'search',
                    target: {
                      primary: { model_selection: 'not_applicable' },
                    },
                  },
                  result_kind: 'search_results',
                  observation_mode: 'api_output',
                  corpora: ['web'],
                  retrieval_method: 'search_endpoint',
                  access_mode: 'direct',
                  operator_id: 'custom',
                  invocation: 'inline',
                  resumability: 'none',
                },
              },
            },
          },
          trustedProviderIds: ['custom-search'],
        },
        { customProviderIds: ['custom-search'] },
      ),
    ).rejects.toThrow(/tier that does not match/);

    expect(state.registerCalls).toBe(0);
  });

  it('treats surface observations as grounded runtime work', async () => {
    const { initializeProviders } = await import(
      '../src/adapters/node-registry.js'
    );

    await expect(
      initializeProviders(
        {
          providers: { 'custom-search': { enabled: true } },
          customProviders: {
            'custom-search': {
              type: 'npm',
              module: 'trusted-but-mismatched',
              executionProfile: {
                bindingId: 'custom.surface.v1',
                profile: {
                  identity: {
                    provider_id: 'custom',
                    profile_id: 'surface',
                    target: {
                      primary: { model_selection: 'not_applicable' },
                    },
                  },
                  result_kind: 'surface_observation',
                  grounding_policy: 'required',
                  observation_mode: 'surface_snapshot',
                  corpora: ['web'],
                  retrieval_method: 'surface_collector',
                  access_mode: 'collected',
                  operator_id: 'custom',
                  collector_id: 'custom',
                  surface_id: 'search',
                  surface_context: {
                    account_context: 'anonymous',
                    personalization: 'absent',
                  },
                  invocation: 'inline',
                  resumability: 'none',
                },
              },
            },
          },
          trustedProviderIds: ['custom-search'],
        },
        { customProviderIds: ['custom-search'] },
      ),
    ).resolves.toMatchObject({ loadedCustomProviders: ['custom-search'] });
  });

  it('loads and registers only the admitted trusted custom provider', async () => {
    const { initializeProviders } = await import(
      '../src/adapters/node-registry.js'
    );
    const customProviders = {
      'custom-search': source(),
      'custom-reserve': source(),
    };

    await initializeProviders(config(customProviders), {
      customProviderIds: ['custom-search'],
    });

    expect(state.loadCalls).toHaveLength(1);
    expect(state.loadCalls[0]).toMatchObject({
      customProviders: { 'custom-search': customProviders['custom-search'] },
      trustedProviderIds: ['custom-search'],
    });
    expect(state.registerCalls).toBe(1);
  });

  it('fails closed without registration when an admitted provider is missing from the loaded descriptor set', async () => {
    state.omitProviders = true;
    const { initializeProviders } = await import(
      '../src/adapters/node-registry.js'
    );

    await expect(
      initializeProviders(config({ 'custom-search': source() }), {
        customProviderIds: ['custom-search'],
      }),
    ).rejects.toThrow(/did not load/);

    expect(state.registerCalls).toBe(0);
  });

  it.each([
    ['invocation', { execution: 'background' }, /execution mode/],
    [
      'credential required flag',
      { requiresApiKey: false },
      /credential requirements/,
    ],
    [
      'credential environment variable',
      { requiresApiKey: true, envVar: 'WRONG_KEY' },
      /credential requirements/,
    ],
  ])(
    'fails closed for a %s mismatch before registration',
    async (_name, descriptorOverride, expected) => {
      state.descriptorOverride = descriptorOverride;
      const { initializeProviders } = await import(
        '../src/adapters/node-registry.js'
      );

      await expect(
        initializeProviders(
          config({
            'custom-search': source({ credential: 'CUSTOM_SEARCH_KEY' }),
          }),
          { customProviderIds: ['custom-search'] },
        ),
      ).rejects.toThrow(expected);

      expect(state.registerCalls).toBe(0);
    },
  );
});
