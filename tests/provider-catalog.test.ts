import { describe, expect, it } from 'vitest';
import {
  type ExecutionProfile,
  ExecutionProfileSchema,
} from '../src/contracts/domain/index.js';
import { fallbackCompatibilityIssues } from '../src/contracts/interchange/compatibility.js';
import type { CredentialContext } from '../src/core/credentials.js';
import {
  type FrozenPlanningCatalog,
  prepareResearchExecution,
} from '../src/core/execution-plan.js';
import {
  BUILTIN_PROFILE_BINDING_SPECS,
  buildProfileBindings,
  ProfileBindingError,
} from '../src/core/profile-bindings.js';
import {
  buildProviderCatalog,
  type CustomCatalogProfile,
  type ProviderCatalog,
  type ProviderCatalogOptions,
} from '../src/core/profile-catalog.js';
import {
  BUILTIN_PROVIDER_CATALOG,
  catalogProfileRefs,
  type ExecutableProfileDeclaration,
} from '../src/core/provider-profiles.js';
import type { ProviderConfig } from '../src/types.js';

const ADAPTER_IDS = [
  ...new Set(BUILTIN_PROFILE_BINDING_SPECS.map((spec) => spec.adapter_id)),
];

function enabledConfigs(
  overrides: Readonly<Record<string, Partial<ProviderConfig>>> = {},
): Record<string, ProviderConfig> {
  const configs: Record<string, ProviderConfig> = {};
  for (const adapterId of ADAPTER_IDS) {
    configs[adapterId] = { enabled: true, ...overrides[adapterId] };
  }
  return configs;
}

function allCredentials(): CredentialContext {
  const env: Record<string, string> = {};
  for (const entry of BUILTIN_PROVIDER_CATALOG) {
    env[entry.credential.env_var] = 'test-credential';
  }
  return { env };
}

function catalog(options: ProviderCatalogOptions = {}): ProviderCatalog {
  return buildProviderCatalog({
    providerConfigs: enabledConfigs(),
    credentials: allCredentials(),
    ...options,
  });
}

function customProfile(
  overrides: Partial<CustomCatalogProfile> & {
    profile?: Partial<ExecutionProfile>;
  } = {},
): CustomCatalogProfile {
  const profile: ExecutionProfile = {
    identity: {
      provider_id: 'acme',
      profile_id: 'search',
      target: { primary: { model_selection: 'not_applicable' } },
    },
    result_kind: 'search_results',
    observation_mode: 'api_output',
    corpora: ['web'],
    retrieval_method: 'search_endpoint',
    access_mode: 'direct',
    operator_id: 'acme',
    invocation: 'inline',
    resumability: 'none',
    ...overrides.profile,
  };
  return {
    adapter_id: 'acme-adapter',
    binding_id: 'acme.search.v1',
    ...overrides,
    profile,
  };
}

function keysOf(
  identities: readonly { provider_id: string; profile_id: string }[],
) {
  return identities.map((id) => `${id.provider_id}/${id.profile_id}`);
}

function refKey(providerId: string, profileId: string): string {
  return `${providerId}/${profileId}`;
}

const IMPLEMENTED_MATRIX = [
  ['perplexity-sonar-deep', 'research'],
  ['perplexity-deep-research', 'research'],
  ['perplexity-advanced-deep', 'research'],
  ['openai-research', 'research'],
  ['gemini-deep', 'research'],
  ['perplexity-sonar-pro', 'grounded'],
  ['perplexity-pro-search', 'grounded'],
  ['gemini-grounded', 'grounded'],
  ['grok', 'web'],
  ['openrouter', 'grounded'],
  ['brave-answers', 'grounded'],
  ['you-research', 'grounded'],
  ['kagi-fastgpt', 'grounded'],
  ['exa', 'search'],
  ['perplexity-search', 'search'],
  ['brave-search', 'search'],
  ['jina-search', 'search'],
  ['firecrawl-search', 'search'],
  ['searchapi', 'search'],
  ['serpapi', 'search'],
  ['tavily', 'search'],
  ['searchapi-chatgpt', 'surface'],
  ['searchapi-gemini', 'surface'],
  ['searchapi-perplexity', 'surface'],
  ['searchapi-google-ai-mode', 'surface'],
  ['searchapi-bing-copilot', 'surface'],
  ['searchapi-google-ai-overview', 'surface'],
  ['claude', 'chat'],
  ['openai-chat', 'chat'],
  ['gemini-chat', 'chat'],
  ['openrouter', 'chat'],
] as const;

const PLANNED_MATRIX = [
  ['grok-x-only', 'x'],
  ['grok-combined', 'combined'],
  ['parallel', 'search'],
  ['parallel', 'chat'],
  ['parallel', 'research'],
  ['valyu', 'search'],
  ['valyu', 'research'],
] as const;

const PLANNED_PROVIDER_IDS = [
  ...new Set(PLANNED_MATRIX.map(([providerId]) => providerId)),
];

const SURFACE_PROFILES = [
  'searchapi-chatgpt/surface',
  'searchapi-gemini/surface',
  'searchapi-perplexity/surface',
  'searchapi-google-ai-mode/surface',
  'searchapi-bing-copilot/surface',
  'searchapi-google-ai-overview/surface',
];

const API_COMPARISON_BASELINES = [
  'perplexity-sonar-pro/grounded',
  'gemini-grounded/grounded',
  'grok/web',
];

// ---------------------------------------------------------------------------
// AC-1: one truthful declaration per profile, one binding per implemented one
// ---------------------------------------------------------------------------

describe('provider catalog -- declarations', () => {
  const refs = catalogProfileRefs();

  it('declares every existing and planned profile exactly once', () => {
    const keys = refs.map((ref) =>
      refKey(ref.entry.provider_id, ref.declaration.profile_id),
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(
      [...IMPLEMENTED_MATRIX, ...PLANNED_MATRIX]
        .map(([provider, profile]) => refKey(provider, profile))
        .sort(),
    );
  });

  it('declares unique provider ids', () => {
    const ids = BUILTIN_PROVIDER_CATALOG.map((entry) => entry.provider_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks exactly the implemented and planned profiles', () => {
    const byStatus = (status: 'implemented' | 'planned') =>
      refs
        .filter((ref) => ref.declaration.status === status)
        .map((ref) => refKey(ref.entry.provider_id, ref.declaration.profile_id))
        .sort();

    expect(byStatus('implemented')).toEqual(
      IMPLEMENTED_MATRIX.map(([p, f]) => refKey(p, f)).sort(),
    );
    expect(byStatus('planned')).toEqual(
      PLANNED_MATRIX.map(([p, f]) => refKey(p, f)).sort(),
    );
  });

  it('resolves each declaration to a valid contract execution profile', () => {
    for (const resolved of catalog().resolved) {
      const parsed = ExecutionProfileSchema.safeParse(resolved.profile);
      expect(
        parsed.success ? [] : parsed.error.issues.map((i) => i.message),
      ).toEqual([]);
    }
  });

  it('gives every profile a unique selection order', () => {
    const orders = refs.map((ref) => ref.declaration.selection_order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('omits grounding policy for search results and requires it elsewhere', () => {
    for (const { declaration } of refs) {
      if (declaration.result_kind === 'search_results') {
        expect(declaration.grounding_policy).toBeUndefined();
      } else {
        expect(declaration.grounding_policy).toBeDefined();
      }
    }
  });

  it('omits collector and surface context on ordinary API profiles', () => {
    for (const { entry, declaration } of refs) {
      const key = refKey(entry.provider_id, declaration.profile_id);
      if (SURFACE_PROFILES.includes(key)) continue;
      expect(declaration.collector_id).toBeUndefined();
      expect(declaration.surface_id).toBeUndefined();
      expect(declaration.surface_context).toBeUndefined();
    }
  });

  it('never declares runtime or result facts on a catalog entry', () => {
    const allowed = new Set([
      'profile_id',
      'target',
      'selection_order',
      'status',
      'workflows',
      'features',
      'result_kind',
      'grounding_policy',
      'observation_mode',
      'corpora',
      'retrieval_method',
      'access_mode',
      'operator_id',
      'collector_id',
      'surface_id',
      'surface_context',
      'invocation',
      'resumability',
    ]);
    for (const { declaration } of refs) {
      for (const key of Object.keys(declaration)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });

  it('exposes no universal citations, independent, or verified capability', () => {
    const serialized = JSON.stringify(BUILTIN_PROVIDER_CATALOG);
    for (const banned of ['"independent"', '"verified"', '"citations"']) {
      expect(serialized).not.toContain(banned);
    }
  });

  it('advertises optional features only where an adapter proves them', () => {
    for (const { declaration } of refs) {
      if (declaration.status === 'planned') {
        expect(declaration.features).toBeUndefined();
        continue;
      }
      // No public adapter implements remote cancellation or JSON-schema output
      // today, so nothing may advertise them.
      expect(declaration.features?.remote_cancellation).toBeUndefined();
      expect(declaration.features?.json_schema_output).toBeUndefined();
    }
  });

  it('advertises configurable web search only on the four chat profiles', () => {
    const configurable = refs
      .filter(
        (ref) =>
          ref.declaration.features?.web_search === 'configurable_default_on',
      )
      .map((ref) => refKey(ref.entry.provider_id, ref.declaration.profile_id))
      .sort();
    expect(configurable).toEqual([
      'claude/chat',
      'gemini-chat/chat',
      'openai-chat/chat',
      'openrouter/chat',
    ]);
  });
});

describe('provider catalog -- bindings', () => {
  it('binds every implemented profile exactly once and no planned profile', () => {
    const built = catalog();
    const implemented = built.resolved.filter(
      (item) => item.declaration.status === 'implemented',
    );
    const planned = built.resolved.filter(
      (item) => item.declaration.status === 'planned',
    );

    expect(implemented).toHaveLength(IMPLEMENTED_MATRIX.length);
    expect(planned).toHaveLength(PLANNED_MATRIX.length);
    for (const item of implemented) expect(item.binding).toBeDefined();
    for (const item of planned) expect(item.binding).toBeUndefined();

    const bindingIds = implemented.map((item) => item.binding?.binding_id);
    expect(new Set(bindingIds).size).toBe(bindingIds.length);
  });

  it('keeps planned profiles discoverable but never selectable', () => {
    const built = catalog();
    for (const [providerId, profileId] of PLANNED_MATRIX) {
      const resolved = built.get(providerId, profileId);
      expect(resolved).toBeDefined();
      expect(resolved?.availability.selectable).toBe(false);
      expect(resolved?.availability.reasons).toContain(
        'profile_not_implemented',
      );
    }
    const planningKeys = keysOf(
      built.profiles.map((profile) => profile.profile.identity),
    );
    for (const [providerId, profileId] of PLANNED_MATRIX) {
      expect(planningKeys).not.toContain(refKey(providerId, profileId));
    }
  });

  it('fails deterministically on a missing binding', () => {
    const trimmed = BUILTIN_PROVIDER_CATALOG.filter(
      (entry) => entry.provider_id !== 'exa',
    ).concat({
      ...BUILTIN_PROVIDER_CATALOG.find((e) => e.provider_id === 'exa')!,
      profiles: [
        {
          ...(BUILTIN_PROVIDER_CATALOG.find((e) => e.provider_id === 'exa')
            ?.profiles[0] as ExecutableProfileDeclaration),
          profile_id: 'unbound-search',
        },
      ],
    });
    expect(() => buildProviderCatalog({ catalog: trimmed })).toThrow(
      ProfileBindingError,
    );
  });

  it('fails deterministically on an orphan binding', () => {
    const declarations = new Map<string, ExecutableProfileDeclaration>();
    expect(() =>
      buildProfileBindings(declarations, [
        { provider_id: 'ghost', profile_id: 'search', adapter_id: 'exa' },
      ]),
    ).toThrow(/no catalog declaration/i);
  });

  it('fails deterministically on a duplicate binding', () => {
    const exa = BUILTIN_PROVIDER_CATALOG.find((e) => e.provider_id === 'exa');
    const declarations = new Map([
      ['exa/search', exa?.profiles[0] as ExecutableProfileDeclaration],
    ]);
    const spec = {
      provider_id: 'exa',
      profile_id: 'search',
      adapter_id: 'exa',
    };
    expect(() => buildProfileBindings(declarations, [spec, spec])).toThrow(
      /more than one binding/i,
    );
  });

  it('refuses to bind a planned declaration', () => {
    const exa = BUILTIN_PROVIDER_CATALOG.find((e) => e.provider_id === 'exa');
    const declarations = new Map([
      [
        'exa/search',
        {
          ...(exa?.profiles[0] as ExecutableProfileDeclaration),
          status: 'planned',
        } as ExecutableProfileDeclaration,
      ],
    ]);
    expect(() =>
      buildProfileBindings(declarations, [
        { provider_id: 'exa', profile_id: 'search', adapter_id: 'exa' },
      ]),
    ).toThrow(/must not be bound/i);
  });
});

// ---------------------------------------------------------------------------
// AC-1/AC-2: determinism and immutability
// ---------------------------------------------------------------------------

describe('provider catalog -- determinism and immutability', () => {
  it('produces a stable revision and digest for identical inputs', () => {
    const first = catalog();
    const second = catalog();
    expect(first.revision).toBe(second.revision);
    expect(first.digest).toBe(second.digest);
    expect(first.revision).toMatch(/^fnv1a64\.1:[0-9a-f]{16}$/);
    expect(first.digest).toMatch(/^fnv1a64\.1:[0-9a-f]{16}$/);
  });

  it('keeps the revision fixed while the digest tracks resolution', () => {
    const enabled = catalog();
    const disabled = buildProviderCatalog({
      providerConfigs: enabledConfigs({ exa: { enabled: false } }),
      credentials: allCredentials(),
    });
    expect(disabled.revision).toBe(enabled.revision);
    expect(disabled.digest).not.toBe(enabled.digest);
  });

  it('orders every profile by selection order, provider id, then profile id', () => {
    const built = catalog();
    const sorted = [...built.resolved].sort((left, right) => {
      const leftKey = [
        left.declaration.selection_order,
        left.profile.identity.provider_id,
        left.declaration.profile_id,
      ];
      const rightKey = [
        right.declaration.selection_order,
        right.profile.identity.provider_id,
        right.declaration.profile_id,
      ];
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    expect(built.resolved.map((r) => r.declaration.selection_order)).toEqual(
      sorted.map((r) => r.declaration.selection_order),
    );
  });

  it('is deeply immutable after construction', () => {
    const built = catalog();
    const first = built.resolved[0];
    const planning = built.profiles[0];
    if (!first || !planning) throw new Error('empty catalog');

    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.resolved)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.declaration)).toBe(true);
    expect(Object.isFrozen(first.profile)).toBe(true);
    expect(Object.isFrozen(first.profile.identity)).toBe(true);
    expect(Object.isFrozen(first.profile.identity.target.primary)).toBe(true);
    expect(Object.isFrozen(first.profile.corpora)).toBe(true);
    expect(Object.isFrozen(first.availability)).toBe(true);
    expect(Object.isFrozen(first.availability.reasons)).toBe(true);
    expect(Object.isFrozen(built.entries)).toBe(true);
    expect(Object.isFrozen(built.entries[0]?.profiles)).toBe(true);
    expect(Object.isFrozen(planning.profile)).toBe(true);

    expect(() => {
      (planning.profile.corpora as string[]).push('news');
    }).toThrow(TypeError);
    expect(() => {
      (first.availability as { selectable: boolean }).selectable = false;
    }).toThrow(TypeError);
    expect(() => {
      (first.declaration as { status: string }).status = 'planned';
    }).toThrow(TypeError);
  });

  it('clones caller-owned input instead of freezing it in place', () => {
    const entries = structuredClone(BUILTIN_PROVIDER_CATALOG) as ReturnType<
      typeof structuredClone<typeof BUILTIN_PROVIDER_CATALOG>
    >;
    const built = buildProviderCatalog({
      catalog: entries,
      providerConfigs: enabledConfigs(),
      credentials: allCredentials(),
    });
    expect(Object.isFrozen(entries)).toBe(false);
    expect(Object.isFrozen(entries[0])).toBe(false);
    expect(built.entries).not.toBe(entries);
    expect(built.entries).toEqual(entries);
  });
});

describe('provider catalog -- trusted custom planning profiles', () => {
  it('derives keyless, env, literal, and keychain credential availability', () => {
    const keyless = buildProviderCatalog({
      providerConfigs: { 'acme-adapter': { enabled: true } },
      customProfiles: [customProfile()],
    });
    expect(keyless.get('acme', 'search')?.availability.selectable).toBe(true);

    const credentialed = customProfile({ credential_env_var: 'ACME_API_KEY' });
    const missing = buildProviderCatalog({
      providerConfigs: { 'acme-adapter': { enabled: true } },
      customProfiles: [credentialed],
      credentials: { env: {} },
    });
    expect(missing.get('acme', 'search')?.availability.reasons).toContain(
      'credential_missing',
    );
    const fromEnv = buildProviderCatalog({
      providerConfigs: { 'acme-adapter': { enabled: true } },
      customProfiles: [credentialed],
      credentials: { env: { ACME_API_KEY: 'env-key' } },
    });
    expect(fromEnv.get('acme', 'search')?.availability.selectable).toBe(true);
    const literal = buildProviderCatalog({
      providerConfigs: {
        'acme-adapter': { enabled: true, apiKey: 'literal-key' },
      },
      customProfiles: [credentialed],
    });
    expect(literal.get('acme', 'search')?.availability.selectable).toBe(true);
    const keychain = buildProviderCatalog({
      providerConfigs: {
        'acme-adapter': { enabled: true, apiKey: 'keychain:acme' },
      },
      customProfiles: [credentialed],
      credentials: {
        resolveCredential: (reference) =>
          reference === 'keychain:acme' ? 'keychain-key' : undefined,
      },
    });
    expect(keychain.get('acme', 'search')?.availability.selectable).toBe(true);
  });

  it('keeps custom bindings closure-free, immutable, and in the digest', () => {
    const input = customProfile();
    const built = buildProviderCatalog({
      providerConfigs: { 'acme-adapter': { enabled: true } },
      customProfiles: [input],
    });
    const resolved = built.get('acme', 'search');
    expect(resolved?.binding).toEqual({
      provider_id: 'acme',
      profile_id: 'search',
      adapter_id: 'acme-adapter',
      binding_id: 'acme.search.v1',
    });
    expect(resolved?.binding).not.toHaveProperty('resolve');
    const digest = built.digest;
    input.profile.identity.provider_id = 'mutated';
    expect(built.get('acme', 'search')).toBe(resolved);
    expect(built.digest).toBe(digest);

    const changed = buildProviderCatalog({
      providerConfigs: { 'acme-adapter': { enabled: true } },
      customProfiles: [customProfile({ binding_id: 'acme.search.v2' })],
    });
    expect(changed.revision).toBe(built.revision);
    expect(changed.digest).not.toBe(built.digest);
  });

  it('selects custom profiles through capabilities and the all workflow', () => {
    const built = buildProviderCatalog({
      providerConfigs: { 'acme-adapter': { enabled: true } },
      customProfiles: [customProfile()],
    });
    expect(keysOf(built.workflow('all').members)).toContain('acme/search');
    const result = prepare(
      {
        selector: {
          kind: 'capabilities',
          requirements: { result_kind: 'search_results', corpora: ['web'] },
        },
      },
      built,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      keysOf(
        result.prepared.request.slots.map((slot) => slot.primary.identity),
      ),
    ).toEqual(['acme/search']);
  });

  it('rejects reserved ids, duplicate identities/bindings, and process-local profiles', () => {
    expect(() =>
      buildProviderCatalog({
        providerConfigs: { exa: { enabled: true } },
        customProfiles: [customProfile({ adapter_id: 'exa' })],
      }),
    ).toThrow(/reserved/i);
    expect(() =>
      buildProviderCatalog({
        providerConfigs: { 'openai-deep': { enabled: true } },
        customProfiles: [customProfile({ adapter_id: 'openai-deep' })],
      }),
    ).toThrow(/reserved/i);
    expect(() =>
      buildProviderCatalog({
        providerConfigs: {
          'acme-adapter': { enabled: true },
          'acme-other': { enabled: true },
        },
        customProfiles: [
          customProfile(),
          customProfile({ adapter_id: 'acme-other' }),
        ],
      }),
    ).toThrow(/duplicate provider profile/i);
    expect(() =>
      buildProviderCatalog({
        providerConfigs: { 'acme-adapter': { enabled: true } },
        customProfiles: [
          customProfile(),
          customProfile({
            profile: {
              identity: {
                provider_id: 'acme-two',
                profile_id: 'search',
                target: {
                  primary: { model_selection: 'not_applicable' },
                },
              },
            },
          }),
        ],
      }),
    ).toThrow(/duplicate adapter binding/i);
    expect(() =>
      buildProviderCatalog({
        providerConfigs: { 'acme-adapter': { enabled: true } },
        customProfiles: [
          customProfile({
            profile: {
              invocation: 'background',
              resumability: 'process_local',
            },
          }),
        ],
      }),
    ).toThrow(/process_local/i);
  });

  it.each([...PLANNED_PROVIDER_IDS, 'openai-deep'])(
    'reserves the adapter and declared provider identity %s',
    (reservedId) => {
      expect(() =>
        buildProviderCatalog({
          providerConfigs: { [reservedId]: { enabled: true } },
          customProfiles: [customProfile({ adapter_id: reservedId })],
        }),
      ).toThrow(/reserved/i);
      expect(() =>
        buildProviderCatalog({
          providerConfigs: { 'acme-adapter': { enabled: true } },
          customProfiles: [
            customProfile({
              profile: {
                identity: {
                  provider_id: reservedId,
                  profile_id: 'novel',
                  target: {
                    primary: { model_selection: 'not_applicable' },
                  },
                },
              },
            }),
          ],
        }),
      ).toThrow(/provider id is reserved/i);
    },
  );

  it('excludes ordinary disabled declarations but preserves reserve-only availability', () => {
    const declaration = customProfile();
    const disabled = buildProviderCatalog({
      providerConfigs: { 'acme-adapter': { enabled: false } },
      customProfiles: [declaration],
    });
    expect(disabled.get('acme', 'search')).toBeUndefined();
    expect(keysOf(disabled.workflow('all').members)).not.toContain(
      'acme/search',
    );

    const reserveOnly = buildProviderCatalog({
      providerConfigs: { 'acme-adapter': { enabled: false } },
      customProfiles: [declaration],
      reserveOnlyAdapterIds: ['acme-adapter'],
      reserve: [{ provider_id: 'acme', profile_id: 'search' }],
    });
    expect(reserveOnly.get('acme', 'search')?.availability).toMatchObject({
      enabled: false,
      reserve_only: true,
      selectable: false,
    });
    expect(reserveOnly.resolveDefault()).toEqual([]);
    expect(keysOf(reserveOnly.workflow('all').members)).not.toContain(
      'acme/search',
    );
    expect(keysOf(reserveOnly.resolveConfiguredReserve([]))).toEqual([
      'acme/search',
    ]);
  });

  it('keeps slash-capable binding ids opaque without global false collisions', () => {
    const built = buildProviderCatalog({
      providerConfigs: {
        'acme-adapter': { enabled: true },
        'other-adapter': { enabled: true },
      },
      customProfiles: [
        customProfile({ binding_id: 'binding/with/slashes' }),
        customProfile({
          adapter_id: 'other-adapter',
          binding_id: 'binding/with/slashes',
          profile: {
            identity: {
              provider_id: 'other-provider',
              profile_id: 'search',
              target: { primary: { model_selection: 'not_applicable' } },
            },
          },
        }),
      ],
    });
    expect(built.get('acme', 'search')?.binding?.binding_id).toBe(
      'binding/with/slashes',
    );
    expect(built.get('other-provider', 'search')?.binding?.binding_id).toBe(
      'binding/with/slashes',
    );
  });

  it.each([
    customProfile({ adapter_id: '' }),
    customProfile({ adapter_id: ' acme-adapter' }),
    customProfile({ adapter_id: 'acme\u0001adapter' }),
    customProfile({ binding_id: ' invalid ' }),
  ])('rejects invalid direct adapter/binding identity %#', (declaration) => {
    expect(() =>
      buildProviderCatalog({
        providerConfigs: { [declaration.adapter_id]: { enabled: true } },
        customProfiles: [declaration],
      }),
    ).toThrow(/canonical opaque identifier/i);
  });

  it.each([
    customProfile({ adapter_id: 'acme/adapter' }),
    customProfile({
      profile: {
        identity: {
          provider_id: 'acme/provider',
          profile_id: 'search',
          target: { primary: { model_selection: 'not_applicable' } },
        },
      },
    }),
    customProfile({
      profile: {
        identity: {
          provider_id: 'acme',
          profile_id: 'search/v2',
          target: { primary: { model_selection: 'not_applicable' } },
        },
      },
    }),
  ])(
    'rejects direct custom identities containing selector delimiters %#',
    (declaration) => {
      expect(() =>
        buildProviderCatalog({
          providerConfigs: { [declaration.adapter_id]: { enabled: true } },
          customProfiles: [declaration],
        }),
      ).toThrow(/selector delimiter/i);
    },
  );

  it('rejects a custom profile with unknown cost under a hard budget', () => {
    const built = buildProviderCatalog({
      providerConfigs: { 'acme-adapter': { enabled: true } },
      customProfiles: [customProfile()],
      defaults: [{ provider_id: 'acme', profile_id: 'search' }],
    });
    const result = prepare(
      { budgets: { max_estimated_cost_microusd: '1000000' } },
      built,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'budget_estimate_required',
        profile_key: expect.stringContaining('acme'),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// AC-3/AC-4: built-in workflows
// ---------------------------------------------------------------------------

describe('provider catalog -- built-in workflows', () => {
  it('resolves quick in the curated order', () => {
    expect(keysOf(catalog().workflow('quick').members)).toEqual([
      'gemini-grounded/grounded',
      'openrouter/grounded',
      'brave-answers/grounded',
      'exa/search',
      'kagi-fastgpt/grounded',
    ]);
  });

  it('resolves visibility in the curated order', () => {
    expect(keysOf(catalog().workflow('visibility').members)).toEqual([
      'searchapi-chatgpt/surface',
      'searchapi-gemini/surface',
      'searchapi-perplexity/surface',
      'searchapi-google-ai-mode/surface',
      'searchapi-bing-copilot/surface',
      'searchapi-google-ai-overview/surface',
      'perplexity-sonar-pro/grounded',
      'gemini-grounded/grounded',
      'grok/web',
    ]);
  });

  it('derives deep from every selectable research-report profile', () => {
    expect(keysOf(catalog().workflow('deep').members)).toEqual([
      'perplexity-sonar-deep/research',
      'perplexity-deep-research/research',
      'perplexity-advanced-deep/research',
      'openai-research/research',
      'gemini-deep/research',
    ]);
  });

  it('keeps declared workflow membership in step with the resolved rosters', () => {
    for (const { entry, declaration } of catalogProfileRefs()) {
      const key = refKey(entry.provider_id, declaration.profile_id);
      const declaresDeep = declaration.workflows.includes('deep');
      expect(declaresDeep).toBe(
        declaration.result_kind === 'research_report' &&
          declaration.status === 'implemented',
      );
      expect(declaration.workflows.includes('quick')).toBe(
        keysOf(catalog().workflow('quick').members).includes(key),
      );
      expect(declaration.workflows.includes('visibility')).toBe(
        keysOf(catalog().workflow('visibility').members).includes(key),
      );
    }
  });

  it('resolves all as every selectable enabled built-in profile, in order', () => {
    expect(keysOf(catalog().workflow('all').members)).toEqual(
      IMPLEMENTED_MATRIX.map(([p, f]) => refKey(p, f)),
    );
  });

  it('excludes disabled, uncredentialed, misconfigured, and unbound profiles from all', () => {
    const built = buildProviderCatalog({
      providerConfigs: enabledConfigs({
        exa: { enabled: false },
        'perplexity-pro-search': { options: { unexpected: true } },
      }),
      credentials: {
        env: Object.fromEntries(
          Object.entries(allCredentials().env ?? {}).filter(
            ([name]) => name !== 'KAGI_API_KEY',
          ),
        ),
      },
    });

    const members = keysOf(built.workflow('all').members);
    expect(members).not.toContain('exa/search');
    expect(members).not.toContain('kagi-fastgpt/grounded');
    expect(members).not.toContain('perplexity-pro-search/grounded');
    for (const [providerId, profileId] of PLANNED_MATRIX) {
      expect(members).not.toContain(refKey(providerId, profileId));
    }
    expect(members).toHaveLength(IMPLEMENTED_MATRIX.length - 3);

    const omitted = built.workflow('all').omitted;
    expect(omitted).toContainEqual({
      profile_key: 'exa/search',
      reason: 'profile_disabled',
    });
    expect(omitted).toContainEqual({
      profile_key: 'kagi-fastgpt/grounded',
      reason: 'credential_missing',
    });
    expect(omitted).toContainEqual({
      profile_key: 'perplexity-pro-search/grounded',
      reason: 'configuration_invalid',
    });
    expect(omitted).toContainEqual({
      profile_key: 'parallel/research',
      reason: 'profile_not_implemented',
    });
  });

  it('never lets a custom group widen all', () => {
    const built = catalog({ groups: { team: ['exa/search'] } });
    expect(keysOf(built.workflow('all').members)).toEqual(
      IMPLEMENTED_MATRIX.map(([p, f]) => refKey(p, f)),
    );
    expect(built.custom_group_ids).toEqual(['custom:team']);
    expect(keysOf(built.resolveGroup('custom:team') ?? [])).toEqual([
      'exa/search',
    ]);
    expect(built.resolveGroup('team')).toBeUndefined();
  });

  it('reports a reserved-name collision instead of overwriting a group', () => {
    const built = catalog({
      groups: { quick: ['exa/search'], 'custom:quick': ['tavily/search'] },
    });
    expect(built.issues).toEqual([
      expect.objectContaining({ code: 'reserved_workflow_name_collision' }),
    ]);
    // The reserved name still resolves to the built-in workflow, and the user's
    // pre-existing custom group is untouched.
    expect(keysOf(built.resolveGroup('quick') ?? [])).toHaveLength(5);
    expect(keysOf(built.resolveGroup('custom:quick') ?? [])).toEqual([
      'tavily/search',
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC-5/AC-7: surface snapshots versus first-party API baselines
// ---------------------------------------------------------------------------

describe('provider catalog -- surface versus API proxy semantics', () => {
  const built = catalog();

  it('models the six SearchAPI surfaces as collected snapshots', () => {
    for (const key of SURFACE_PROFILES) {
      const [providerId, profileId] = key.split('/');
      const profile = built.get(providerId ?? '', profileId ?? '')?.profile;
      expect(profile?.result_kind).toBe('surface_observation');
      expect(profile?.observation_mode).toBe('surface_snapshot');
      expect(profile?.retrieval_method).toBe('surface_collector');
      expect(profile?.access_mode).toBe('collected');
      expect(profile?.collector_id).toBe('searchapi');
      expect(profile?.surface_id).toBeDefined();
      expect(profile?.surface_context).toEqual({
        account_context: 'unknown',
        personalization: 'unknown',
      });
    }
  });

  it('models the three comparison baselines as direct API answers', () => {
    for (const key of API_COMPARISON_BASELINES) {
      const [providerId, profileId] = key.split('/');
      const profile = built.get(providerId ?? '', profileId ?? '')?.profile;
      expect(profile?.result_kind).toBe('grounded_answer');
      expect(profile?.observation_mode).toBe('api_output');
      expect(profile?.access_mode).toBe('direct');
      expect(profile?.collector_id).toBeUndefined();
      expect(profile?.surface_id).toBeUndefined();
      expect(profile?.surface_context).toBeUndefined();
    }
  });

  it('never treats an API baseline as a substitute for a surface snapshot', () => {
    const surface = built.get('searchapi-chatgpt', 'surface')?.profile;
    const baseline = built.get('perplexity-sonar-pro', 'grounded')?.profile;
    if (!surface || !baseline) throw new Error('missing fixture profiles');

    const slot = {
      slot_id: 'slot-surface',
      position: 0,
      requirements: {
        result_kind: 'surface_observation' as const,
        grounding_policy: 'optional' as const,
        observation_mode: 'surface_snapshot' as const,
        corpora: ['web' as const],
        surface_id: surface.surface_id,
      },
      primary: surface,
    };
    expect(fallbackCompatibilityIssues(slot, baseline).length).toBeGreaterThan(
      0,
    );
    expect(fallbackCompatibilityIssues(slot, surface)).toEqual([]);
  });

  it('keeps each surface a distinct measured surface', () => {
    const surfaceIds = SURFACE_PROFILES.map((key) => {
      const [providerId, profileId] = key.split('/');
      return built.get(providerId ?? '', profileId ?? '')?.profile.surface_id;
    });
    expect(new Set(surfaceIds).size).toBe(SURFACE_PROFILES.length);
  });
});

// ---------------------------------------------------------------------------
// Target selection and configuration-driven resolution
// ---------------------------------------------------------------------------

describe('provider catalog -- target selection', () => {
  const built = catalog();

  it('declares fixed targets for dedicated product endpoints', () => {
    expect(
      built.get('brave-answers', 'grounded')?.profile.identity.target,
    ).toEqual({
      primary: {
        model_selection: 'fixed',
        kind: 'model',
        target_id: 'brave',
      },
    });
    expect(
      built.get('kagi-fastgpt', 'grounded')?.profile.identity.target,
    ).toEqual({
      primary: {
        model_selection: 'fixed',
        kind: 'preset',
        target_id: 'fastgpt',
      },
    });
    expect(
      built.get('perplexity-deep-research', 'research')?.profile.identity
        .target,
    ).toEqual({
      primary: {
        model_selection: 'fixed',
        kind: 'preset',
        target_id: 'deep-research',
      },
    });
  });

  it('declares configurable targets only where the adapter threads a model', () => {
    for (const [providerId, profileId] of [
      ['openai-research', 'research'],
      ['gemini-deep', 'research'],
      ['grok', 'web'],
      ['claude', 'chat'],
      ['openai-chat', 'chat'],
      ['gemini-chat', 'chat'],
      ['openrouter', 'chat'],
    ] as const) {
      expect(
        built.get(providerId, profileId)?.profile.identity.target.primary
          .model_selection,
      ).toBe('configurable');
    }
  });

  it('declares provider-managed targets without inventing a target id', () => {
    for (const [providerId, profileId] of [
      ['you-research', 'grounded'],
      ['searchapi-chatgpt', 'surface'],
      ['parallel', 'research'],
      ['valyu', 'research'],
    ] as const) {
      const primary = built.get(providerId, profileId)?.profile.identity.target
        .primary;
      expect(primary?.model_selection).toBe('provider_managed');
      expect(primary?.target_id).toBeUndefined();
    }
  });

  it('declares not-applicable targets for raw retrieval endpoints', () => {
    for (const [providerId, profileId] of [
      ['exa', 'search'],
      ['tavily', 'search'],
      ['searchapi', 'search'],
      ['serpapi', 'search'],
      ['parallel', 'search'],
      ['valyu', 'search'],
    ] as const) {
      expect(built.get(providerId, profileId)?.profile.identity.target).toEqual(
        { primary: { model_selection: 'not_applicable' } },
      );
    }
  });
});

describe('provider catalog -- configuration-driven resolution', () => {
  it('resolves a chat profile with web search off to a distinct model-only profile', () => {
    const grounded = catalog().get('claude', 'chat')?.profile;
    expect(grounded?.result_kind).toBe('grounded_answer');
    expect(grounded?.grounding_policy).toBe('optional');
    expect(grounded?.retrieval_method).toBe('model_search_tool');

    const offline = buildProviderCatalog({
      providerConfigs: enabledConfigs({
        claude: { options: { webSearch: false } },
      }),
      credentials: allCredentials(),
    }).get('claude', 'chat')?.profile;

    expect(offline?.result_kind).toBe('model_answer');
    expect(offline?.grounding_policy).toBe('none');
    expect(offline?.corpora).toEqual([]);
    expect(offline?.retrieval_method).toBe('model_only');
    // The grounded declaration is untouched; a different strategy resolved.
    expect(grounded?.result_kind).toBe('grounded_answer');
  });

  it('widens Firecrawl corpora only when the configuration proves it', () => {
    expect(
      catalog().get('firecrawl-search', 'search')?.profile.corpora,
    ).toEqual(['web']);
    const widened = buildProviderCatalog({
      providerConfigs: enabledConfigs({
        'firecrawl-search': { options: { sources: ['web', 'news'] } },
      }),
      credentials: allCredentials(),
    }).get('firecrawl-search', 'search')?.profile;
    expect(widened?.corpora).toEqual(['web', 'news']);
  });

  it('marks an invalid provider configuration as unselectable', () => {
    const resolved = buildProviderCatalog({
      providerConfigs: enabledConfigs({
        'perplexity-pro-search': { options: { nope: 1 } },
      }),
      credentials: allCredentials(),
    }).get('perplexity-pro-search', 'grounded');
    expect(resolved?.availability.configuration_valid).toBe(false);
    expect(resolved?.availability.selectable).toBe(false);
    expect(resolved?.availability.reasons).toContain('configuration_invalid');
  });
});

// ---------------------------------------------------------------------------
// Network-free estimates
// ---------------------------------------------------------------------------

describe('provider catalog -- network-free estimates', () => {
  const built = catalog();

  it('records exact plan prices as microusd integers', () => {
    expect(built.get('brave-search', 'search')?.estimate).toEqual({
      estimated_cost_microusd: '5000',
      billable_units: [{ unit: 'request', quantity: '1' }],
    });
    expect(
      built.get('searchapi-google-ai-overview', 'surface')?.estimate,
    ).toEqual({
      estimated_cost_microusd: '4000',
      billable_units: [{ unit: 'request', quantity: '2' }],
    });
  });

  it('records credit units without inventing a dollar value', () => {
    expect(built.get('tavily', 'search')?.estimate).toEqual({
      billable_units: [{ unit: 'credit', quantity: '2' }],
    });
    expect(
      built.get('tavily', 'search')?.estimate?.estimated_cost_microusd,
    ).toBeUndefined();
  });

  it('omits volatile token and native prices entirely', () => {
    for (const [providerId, profileId] of [
      ['perplexity-sonar-pro', 'grounded'],
      ['gemini-deep', 'research'],
      ['grok', 'web'],
      ['exa', 'search'],
      ['brave-answers', 'grounded'],
      ['claude', 'chat'],
    ] as const) {
      expect(
        built.get(providerId, profileId)?.estimate?.estimated_cost_microusd,
      ).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-2/AC-6: selection, defaults, reserve, and budget admission
// ---------------------------------------------------------------------------

function dependencies() {
  let counter = 0;
  return {
    clock: { now: () => Date.parse('2026-08-09T00:00:00Z') },
    ids: {
      next: (scope: 'request' | 'slot' | 'fallback_candidate') => {
        counter += 1;
        return `${scope}-${counter}`;
      },
    },
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    query: 'catalog integration query',
    mode: 'sync',
    selector: { kind: 'default' },
    fallback: { kind: 'disabled' },
    limits: {
      max_concurrency: 4,
      request_deadline_ms: 600_000,
      inline_attempt_deadline_ms: 60_000,
      background_attempt_deadline_ms: 600_000,
      poll_interval_ms: 1_000,
    },
    ...overrides,
  };
}

function prepare(
  overrides: Record<string, unknown> = {},
  built: FrozenPlanningCatalog = catalog(),
) {
  return prepareResearchExecution(request(overrides), built, dependencies());
}

describe('provider catalog -- explicit and capability selection', () => {
  it('selects a profile-qualified explicit target', () => {
    const result = prepare({
      selector: {
        kind: 'targets',
        targets: [{ provider_id: 'openrouter', profile_id: 'chat' }],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.request.slots).toHaveLength(1);
    expect(result.prepared.request.slots[0]?.primary.identity).toMatchObject({
      provider_id: 'openrouter',
      profile_id: 'chat',
    });
  });

  it('rejects an ambiguous bare provider target', () => {
    const result = prepare({
      selector: { kind: 'targets', targets: [{ provider_id: 'openrouter' }] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'ambiguous_profile_target',
        path: '/selector/targets/0',
      }),
    );
  });

  it('rejects a missing explicit target', () => {
    const result = prepare({
      selector: {
        kind: 'targets',
        targets: [{ provider_id: 'exa', profile_id: 'nope' }],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'profile_not_found' }),
    );
  });

  it('rejects an unavailable explicit target', () => {
    const built = buildProviderCatalog({
      providerConfigs: enabledConfigs({ exa: { enabled: false } }),
      credentials: allCredentials(),
    });
    const result = prepare(
      {
        selector: {
          kind: 'targets',
          targets: [{ provider_id: 'exa', profile_id: 'search' }],
        },
      },
      built,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'profile_disabled' }),
    );
  });

  it('rejects selecting and excluding the same target', () => {
    const result = prepare({
      selector: {
        kind: 'targets',
        targets: [{ provider_id: 'exa', profile_id: 'search' }],
      },
      exclusions: [{ provider_id: 'exa', profile_id: 'search' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'explicit_profile_excluded' }),
    );
  });

  it('returns every matching authenticated profile in deterministic order', () => {
    const result = prepare({
      selector: {
        kind: 'capabilities',
        requirements: { result_kind: 'search_results', corpora: ['web'] },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      keysOf(
        result.prepared.request.slots.map((slot) => slot.primary.identity),
      ),
    ).toEqual([
      'exa/search',
      'perplexity-search/search',
      'brave-search/search',
      'jina-search/search',
      'firecrawl-search/search',
      'searchapi/search',
      'serpapi/search',
      'tavily/search',
    ]);
  });

  it('silently removes excluded capability matches', () => {
    const result = prepare({
      selector: {
        kind: 'capabilities',
        requirements: { result_kind: 'search_results', corpora: ['web'] },
      },
      exclusions: [{ provider_id: 'serpapi' }, { provider_id: 'tavily' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issues ?? []).toEqual([]);
    const selected = keysOf(
      result.prepared.request.slots.map((slot) => slot.primary.identity),
    );
    expect(selected).not.toContain('serpapi/search');
    expect(selected).not.toContain('tavily/search');
    expect(selected).toHaveLength(6);
  });

  it('never selects an unauthenticated profile by capability', () => {
    const built = buildProviderCatalog({
      providerConfigs: enabledConfigs(),
      credentials: {
        env: Object.fromEntries(
          Object.entries(allCredentials().env ?? {}).filter(
            ([name]) => name !== 'EXA_API_KEY',
          ),
        ),
      },
    });
    const result = prepare(
      {
        selector: {
          kind: 'capabilities',
          requirements: { result_kind: 'search_results', corpora: ['web'] },
        },
      },
      built,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      keysOf(
        result.prepared.request.slots.map((slot) => slot.primary.identity),
      ),
    ).not.toContain('exa/search');
  });

  it('requires durable resumability for async selection', () => {
    const result = prepare({
      mode: 'async',
      selector: {
        kind: 'targets',
        targets: [
          { provider_id: 'perplexity-deep-research', profile_id: 'research' },
        ],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'async_requires_durable_profile' }),
    );
  });

  it('accepts a durable profile for async selection', () => {
    const result = prepare({
      mode: 'async',
      selector: {
        kind: 'targets',
        targets: [{ provider_id: 'openai-research', profile_id: 'research' }],
      },
    });
    expect(result.ok).toBe(true);
  });
});

describe('provider catalog -- defaults and reserve', () => {
  it('defaults to the ordered enabled profile set when no roster is configured', () => {
    expect(keysOf(catalog().resolveDefault())).toEqual(
      IMPLEMENTED_MATRIX.map(([p, f]) => refKey(p, f)),
    );
  });

  it('uses the configured default roster in its declared order', () => {
    const built = catalog({
      defaults: [
        { provider_id: 'tavily', profile_id: 'search' },
        { provider_id: 'exa', profile_id: 'search' },
      ],
    });
    expect(keysOf(built.resolveDefault())).toEqual([
      'tavily/search',
      'exa/search',
    ]);
  });

  it('omits an unavailable configured default', () => {
    const built = buildProviderCatalog({
      providerConfigs: enabledConfigs({ tavily: { enabled: false } }),
      credentials: allCredentials(),
      defaults: [
        { provider_id: 'tavily', profile_id: 'search' },
        { provider_id: 'exa', profile_id: 'search' },
      ],
    });
    expect(keysOf(built.resolveDefault())).toEqual(['exa/search']);
  });

  it('lists each reserve identity at most once and never a primary', () => {
    const built = catalog({
      reserve: [
        { provider_id: 'brave-search', profile_id: 'search' },
        { provider_id: 'brave-search', profile_id: 'search' },
        { provider_id: 'exa', profile_id: 'search' },
      ],
    });
    const exa = built.get('exa', 'search');
    if (!exa) throw new Error('missing exa profile');
    expect(
      keysOf(built.resolveConfiguredReserve([exa.profile.identity])),
    ).toEqual(['brave-search/search']);
  });

  it('omits an unavailable configured reserve member with a notice', () => {
    const built = buildProviderCatalog({
      providerConfigs: enabledConfigs({ 'brave-search': { enabled: false } }),
      credentials: allCredentials(),
      reserve: [{ provider_id: 'brave-search', profile_id: 'search' }],
    });
    const result = prepare(
      {
        selector: {
          kind: 'targets',
          targets: [{ provider_id: 'exa', profile_id: 'search' }],
        },
        fallback: { kind: 'configured' },
      },
      built,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notices).toContainEqual(
      expect.objectContaining({ code: 'configured_fallback_unavailable' }),
    );
    expect(result.prepared.request.fallback_reserve).toEqual([]);
  });

  it('omits an incompatible configured reserve member with a notice', () => {
    const built = catalog({
      reserve: [
        { provider_id: 'perplexity-sonar-pro', profile_id: 'grounded' },
      ],
    });
    const result = prepare(
      {
        selector: {
          kind: 'targets',
          targets: [{ provider_id: 'exa', profile_id: 'search' }],
        },
        fallback: { kind: 'configured' },
      },
      built,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notices).toContainEqual(
      expect.objectContaining({ code: 'configured_fallback_incompatible' }),
    );
  });

  it('fails an explicit incompatible reserve before any provider call', () => {
    const result = prepare({
      selector: {
        kind: 'targets',
        targets: [{ provider_id: 'exa', profile_id: 'search' }],
      },
      fallback: {
        kind: 'explicit',
        reserve: [
          { provider_id: 'perplexity-sonar-pro', profile_id: 'grounded' },
        ],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'fallback_profile_incompatible' }),
    );
  });

  it('keeps a compatible reserve and preserves the evidence lane', () => {
    const result = prepare({
      selector: {
        kind: 'targets',
        targets: [{ provider_id: 'exa', profile_id: 'search' }],
      },
      fallback: {
        kind: 'explicit',
        reserve: [{ provider_id: 'brave-search', profile_id: 'search' }],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const candidate = result.prepared.request.fallback_reserve[0];
    expect(candidate?.profile.result_kind).toBe('search_results');
    expect(candidate?.eligible_slot_ids).toHaveLength(1);
  });

  it('rejects an explicit reserve that repeats a primary', () => {
    const result = prepare({
      selector: {
        kind: 'targets',
        targets: [{ provider_id: 'exa', profile_id: 'search' }],
      },
      fallback: {
        kind: 'explicit',
        reserve: [{ provider_id: 'exa', profile_id: 'search' }],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'profile_reused_in_fallback' }),
    );
  });
});

describe('provider catalog -- hard budget admission', () => {
  it('rejects an unknown estimate before any provider call', () => {
    const result = prepare({
      selector: {
        kind: 'targets',
        targets: [
          { provider_id: 'perplexity-sonar-pro', profile_id: 'grounded' },
        ],
      },
      budgets: { max_estimated_cost_microusd: '1000000' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'budget_estimate_required',
        phase: 'validation',
      }),
    );
  });

  it('never treats an unknown estimate as zero', () => {
    const result = prepare({
      selector: {
        kind: 'targets',
        targets: [{ provider_id: 'exa', profile_id: 'search' }],
      },
      budgets: { max_estimated_cost_microusd: '0' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain(
      'budget_estimate_required',
    );
  });

  it('admits an exactly estimated plan within its budget', () => {
    const result = prepare({
      selector: {
        kind: 'targets',
        targets: [{ provider_id: 'brave-search', profile_id: 'search' }],
      },
      budgets: { max_estimated_cost_microusd: '5000' },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an exactly estimated plan over its budget', () => {
    const result = prepare({
      selector: {
        kind: 'targets',
        targets: [{ provider_id: 'brave-search', profile_id: 'search' }],
      },
      budgets: { max_estimated_cost_microusd: '4999' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'primary_plan_budget_exceeded' }),
    );
  });
});

// ---------------------------------------------------------------------------
// AC-8: ProviderTier stays out of the v2 semantic contract
// ---------------------------------------------------------------------------

function collectKeys(
  value: unknown,
  into: Set<string> = new Set(),
): Set<string> {
  if (value === null || typeof value !== 'object') return into;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return into;
  }
  for (const [key, item] of Object.entries(value)) {
    into.add(key);
    collectKeys(item, into);
  }
  return into;
}

describe('provider catalog -- legacy tier boundary', () => {
  it('never carries a tier field anywhere in the v2 catalog', () => {
    expect([...collectKeys(BUILTIN_PROVIDER_CATALOG)]).not.toContain('tier');
  });

  it('never carries a tier field in a resolved planning profile', () => {
    const built = catalog();
    expect([...collectKeys(built.profiles)]).not.toContain('tier');
    expect([
      ...collectKeys(built.resolved.map((r) => r.profile)),
    ]).not.toContain('tier');
  });

  it('never assigns a legacy tier value to any catalog field', () => {
    const tiers = new Set([
      'deep-research',
      'ai-grounded',
      'raw-search',
      'llm',
    ]);
    const scan = (value: unknown, path: string): void => {
      if (value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) {
          scan(item, `${path}/${index}`);
        }
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        // A Perplexity preset genuinely named `deep-research` is a target id,
        // not a tier: only a tier-shaped field would be a contract leak.
        if (typeof item === 'string' && tiers.has(item)) {
          expect(['target_id', 'profile_id']).toContain(key);
        }
        scan(item, `${path}/${key}`);
      }
    };
    scan(BUILTIN_PROVIDER_CATALOG, '');
  });
});

// ---------------------------------------------------------------------------
// #2556 corrections: target fidelity, catalog-owned selection policy, and
// deterministic diagnostics for configured references.
// ---------------------------------------------------------------------------

/** Every profile whose adapter factory threads top-level `ProviderConfig.model`. */
const CONFIGURABLE_TARGET_MATRIX = [
  ['openai-research', 'research', 'openai-research', 'model', 'gpt-5.6-sol'],
  [
    'gemini-deep',
    'research',
    'gemini-deep',
    'agent',
    'deep-research-preview-04-2026',
  ],
  ['grok', 'web', 'grok', 'model', 'grok-4.5'],
  ['claude', 'chat', 'claude', 'model', 'claude-sonnet-5'],
  ['openai-chat', 'chat', 'openai-chat', 'model', 'gpt-5-mini'],
  ['gemini-chat', 'chat', 'gemini-chat', 'model', 'gemini-3.6-flash'],
  ['openrouter', 'chat', 'openrouter-chat', 'model', 'openai/gpt-5.6-terra'],
] as const;

describe('provider catalog -- configured target fidelity', () => {
  it('exposes exactly the seven adapter-backed configurable targets', () => {
    const configurable = catalog()
      .resolved.filter(
        (item) =>
          item.profile.identity.target.primary.model_selection ===
          'configurable',
      )
      .map(
        (item) =>
          `${item.profile.identity.provider_id}/${item.declaration.profile_id}`,
      );

    expect(configurable).toEqual(
      CONFIGURABLE_TARGET_MATRIX.map(
        ([providerId, profileId]) => `${providerId}/${profileId}`,
      ),
    );
    expect(configurable).toHaveLength(7);
  });

  it('resolves every configurable target to the configured identifier', () => {
    for (const [
      providerId,
      profileId,
      adapterId,
      kind,
      declared,
    ] of CONFIGURABLE_TARGET_MATRIX) {
      const configured = `${adapterId}-configured-target`;
      const built = buildProviderCatalog({
        providerConfigs: enabledConfigs({ [adapterId]: { model: configured } }),
        credentials: allCredentials(),
      });
      const resolvedProfile = built.get(providerId, profileId);

      expect(resolvedProfile?.profile.identity.target).toEqual({
        primary: {
          model_selection: 'configurable',
          kind,
          target_id: configured,
        },
      });
      expect(resolvedProfile?.availability.selectable).toBe(true);
      // The declaration still records today's default; only the resolved
      // profile follows the configuration.
      expect(resolvedProfile?.declaration.target.primary.target_id).toBe(
        declared,
      );
    }
  });

  it('declares Gemini Deep as a configurable agent with no invented model', () => {
    const target = catalog().get('gemini-deep', 'research')?.profile.identity
      .target;
    expect(target).toEqual({
      primary: {
        model_selection: 'configurable',
        kind: 'agent',
        target_id: 'deep-research-preview-04-2026',
      },
    });
    expect(target?.underlying).toBeUndefined();
  });

  it('keeps the declared default for a missing or blank configured model', () => {
    for (const model of [undefined, '', '   ']) {
      const built = buildProviderCatalog({
        providerConfigs: enabledConfigs({
          claude: model === undefined ? {} : { model },
        }),
        credentials: allCredentials(),
      });
      expect(
        built.get('claude', 'chat')?.profile.identity.target.primary.target_id,
      ).toBe('claude-sonnet-5');
    }
  });

  it('keeps a configured target when an option changes the strategy', () => {
    const offline = buildProviderCatalog({
      providerConfigs: enabledConfigs({
        claude: { model: 'claude-opus-custom', options: { webSearch: false } },
      }),
      credentials: allCredentials(),
    }).get('claude', 'chat')?.profile;

    expect(offline?.result_kind).toBe('model_answer');
    expect(offline?.identity.target.primary.target_id).toBe(
      'claude-opus-custom',
    );
  });

  it('never makes a fixed, provider-managed, or not-applicable target configurable', () => {
    const built = buildProviderCatalog({
      providerConfigs: enabledConfigs({
        'brave-answers': { model: 'ignored-model' },
        'openrouter-online': { model: 'ignored-model' },
        'kagi-fastgpt': { model: 'ignored-preset' },
        'you-research': { model: 'ignored-model' },
        'searchapi-chatgpt': { model: 'ignored-model' },
        exa: { model: 'ignored-model' },
      }),
      credentials: allCredentials(),
    });

    expect(
      built.get('brave-answers', 'grounded')?.profile.identity.target.primary,
    ).toEqual({ model_selection: 'fixed', kind: 'model', target_id: 'brave' });
    expect(
      built.get('openrouter', 'grounded')?.profile.identity.target.primary,
    ).toEqual({
      model_selection: 'fixed',
      kind: 'model',
      target_id: 'openai/gpt-4o-mini',
    });
    expect(
      built.get('kagi-fastgpt', 'grounded')?.profile.identity.target.primary,
    ).toEqual({
      model_selection: 'fixed',
      kind: 'preset',
      target_id: 'fastgpt',
    });
    expect(
      built.get('you-research', 'grounded')?.profile.identity.target.primary,
    ).toEqual({ model_selection: 'provider_managed' });
    expect(
      built.get('searchapi-chatgpt', 'surface')?.profile.identity.target
        .primary,
    ).toEqual({ model_selection: 'provider_managed' });
    expect(built.get('exa', 'search')?.profile.identity.target.primary).toEqual(
      { model_selection: 'not_applicable' },
    );
  });

  it('rejects a configured identifier the contract cannot carry', () => {
    const resolvedProfile = buildProviderCatalog({
      providerConfigs: enabledConfigs({ claude: { model: 'badmodel' } }),
      credentials: allCredentials(),
    }).get('claude', 'chat');

    expect(resolvedProfile?.availability.configuration_valid).toBe(false);
    expect(resolvedProfile?.availability.selectable).toBe(false);
    expect(resolvedProfile?.availability.reasons).toContain(
      'configuration_invalid',
    );
  });
});

describe('provider catalog -- catalog-owned selection policy', () => {
  it('ignores caller mutations of groups, defaults, and reserve', () => {
    const groups: Record<string, string[]> = { team: ['exa/search'] };
    const defaults = [{ provider_id: 'exa', profile_id: 'search' }];
    const reserve = [{ provider_id: 'brave-search', profile_id: 'search' }];
    const built = buildProviderCatalog({
      providerConfigs: enabledConfigs(),
      credentials: allCredentials(),
      groups,
      defaults,
      reserve,
    });
    const digest = built.digest;

    groups.team = ['tavily/search'];
    groups.extra = ['serpapi/search'];
    defaults[0] = { provider_id: 'tavily', profile_id: 'search' };
    reserve[0] = { provider_id: 'exa', profile_id: 'search' };

    expect(keysOf(built.resolveGroup('custom:team') ?? [])).toEqual([
      'exa/search',
    ]);
    expect(built.resolveGroup('custom:extra')).toBeUndefined();
    expect(built.custom_group_ids).toEqual(['custom:team']);
    expect(keysOf(built.resolveDefault())).toEqual(['exa/search']);
    expect(keysOf(built.resolveConfiguredReserve([]))).toEqual([
      'brave-search/search',
    ]);
    // The digest kept describing the behaviour the catalog actually has.
    expect(built.digest).toBe(digest);
  });

  it('leaves caller-owned selection input unfrozen', () => {
    const groups: Record<string, string[]> = { team: ['exa/search'] };
    const defaults = [{ provider_id: 'exa', profile_id: 'search' }];
    buildProviderCatalog({
      providerConfigs: enabledConfigs(),
      credentials: allCredentials(),
      groups,
      defaults,
    });
    expect(Object.isFrozen(groups)).toBe(false);
    expect(Object.isFrozen(groups.team)).toBe(false);
    expect(Object.isFrozen(defaults)).toBe(false);
  });

  it('rejects mutation of an exposed binding record', () => {
    const bound = catalog().get('exa', 'search');
    const binding = bound?.binding;
    if (!binding) throw new Error('expected a bound profile');

    expect(Object.isFrozen(binding)).toBe(true);
    expect(() => {
      (binding as { adapter_id: string }).adapter_id = 'changed';
    }).toThrow(TypeError);
    expect(() => {
      (binding as { binding_id: string }).binding_id = 'changed';
    }).toThrow(TypeError);
    expect(() => {
      (binding as { provider_id: string }).provider_id = 'changed';
    }).toThrow(TypeError);
    expect(() => {
      (binding as { profile_id: string }).profile_id = 'changed';
    }).toThrow(TypeError);
    expect(() => {
      (binding as { options_schema: unknown }).options_schema = undefined;
    }).toThrow(TypeError);
    expect(() => {
      (binding as { resolve: unknown }).resolve = () => undefined;
    }).toThrow(TypeError);
    expect(() => {
      (bound as { binding?: unknown }).binding = undefined;
    }).toThrow(TypeError);

    expect(catalog().get('exa', 'search')?.binding?.adapter_id).toBe('exa');
    // Shallow only: the shared schema and resolver keep working.
    expect(binding.options_schema).toBeDefined();
    expect(binding.resolve({}).profile.identity.provider_id).toBe('exa');
  });
});

describe('provider catalog -- custom group name collisions', () => {
  const collisionCases = [
    [
      'raw first',
      { team: ['brave-search/search'], 'custom:team': ['exa/search'] },
    ],
    [
      'canonical first',
      { 'custom:team': ['exa/search'], team: ['brave-search/search'] },
    ],
  ] as const;

  for (const [label, groups] of collisionCases) {
    it(`preserves the explicit custom group when declared ${label}`, () => {
      const built = catalog({ groups });

      expect(keysOf(built.resolveGroup('custom:team') ?? [])).toEqual([
        'exa/search',
      ]);
      expect(built.custom_group_ids).toEqual(['custom:team']);
      expect(built.issues).toEqual([
        expect.objectContaining({
          code: 'custom_group_name_collision',
          phase: 'migration',
          path: '/groups/team',
        }),
      ]);
      expect(built.issues[0]?.message).toContain('custom:team');
    });
  }

  it('does not mutate the caller-owned group record', () => {
    const groups: Record<string, string[]> = {
      team: ['brave-search/search'],
      'custom:team': ['exa/search'],
    };
    catalog({ groups });
    expect(groups).toEqual({
      team: ['brave-search/search'],
      'custom:team': ['exa/search'],
    });
  });
});

describe('provider catalog -- configured reference diagnostics', () => {
  it('reports unknown default, reserve, and group references at stable paths', () => {
    const built = catalog({
      groups: { broken: ['nope/search', 'exa/nope', 'nope'] },
      defaults: [{ provider_id: 'nope', profile_id: 'search' }],
      reserve: [{ provider_id: 'exa', profile_id: 'nope' }],
    });

    expect(
      built.issues.map((issue) => [issue.code, issue.path, issue.profile_key]),
    ).toEqual([
      ['configured_default_unknown_profile', '/defaults/0', 'nope/search'],
      [
        'custom_group_member_unknown_profile',
        '/groups/broken/0',
        'nope/search',
      ],
      ['custom_group_member_unknown_profile', '/groups/broken/1', 'exa/nope'],
      ['custom_group_member_unknown_profile', '/groups/broken/2', 'nope'],
      ['configured_reserve_unknown_profile', '/reserve/0', 'exa/nope'],
    ]);
    // Behaviour is unchanged: the invalid references still resolve to nothing.
    expect(keysOf(built.resolveGroup('custom:broken') ?? [])).toEqual([]);
    expect(keysOf(built.resolveDefault())).toEqual([]);
    expect(keysOf(built.resolveConfiguredReserve([]))).toEqual([]);
  });

  it('reports planned, unbound references separately from unknown ones', () => {
    const built = catalog({
      groups: { future: ['parallel/research', 'valyu'] },
      defaults: [{ provider_id: 'parallel', profile_id: 'research' }],
      reserve: [{ provider_id: 'grok-x-only', profile_id: 'x' }],
    });

    expect(built.issues.map((issue) => [issue.code, issue.path])).toEqual([
      ['configured_default_unbound_profile', '/defaults/0'],
      ['custom_group_member_unbound_profile', '/groups/future/0'],
      ['custom_group_member_unbound_profile', '/groups/future/1'],
      ['configured_reserve_unbound_profile', '/reserve/0'],
    ]);
    expect(keysOf(built.resolveDefault())).toEqual([]);
    expect(keysOf(built.resolveConfiguredReserve([]))).toEqual([]);
  });

  it('reports a malformed group member instead of silently truncating it', () => {
    const built = catalog({
      groups: { odd: ['exa/search/extra', '', 'exa/'] },
    });

    expect(built.issues.map((issue) => [issue.code, issue.path])).toEqual([
      ['custom_group_member_malformed', '/groups/odd/0'],
      ['custom_group_member_malformed', '/groups/odd/1'],
      ['custom_group_member_malformed', '/groups/odd/2'],
    ]);
    expect(keysOf(built.resolveGroup('custom:odd') ?? [])).toEqual([]);
  });

  it('diagnoses only the invalid members of a mixed roster', () => {
    const built = catalog({
      groups: { mixed: ['exa/search', 'nope/search', 'tavily/search'] },
      defaults: [
        { provider_id: 'exa', profile_id: 'search' },
        { provider_id: 'nope', profile_id: 'search' },
      ],
      reserve: [
        { provider_id: 'nope', profile_id: 'search' },
        { provider_id: 'brave-search', profile_id: 'search' },
      ],
    });

    expect(built.issues.map((issue) => issue.path)).toEqual([
      '/defaults/1',
      '/groups/mixed/1',
      '/reserve/0',
    ]);
    expect(keysOf(built.resolveGroup('custom:mixed') ?? [])).toEqual([
      'exa/search',
      'tavily/search',
    ]);
    expect(keysOf(built.resolveDefault())).toEqual(['exa/search']);
    expect(keysOf(built.resolveConfiguredReserve([]))).toEqual([
      'brave-search/search',
    ]);
  });

  it('never reports a known but unavailable profile as a reference error', () => {
    const built = buildProviderCatalog({
      providerConfigs: enabledConfigs({ exa: { enabled: false } }),
      credentials: allCredentials(),
      groups: { team: ['exa/search'] },
      defaults: [{ provider_id: 'exa', profile_id: 'search' }],
      reserve: [{ provider_id: 'exa', profile_id: 'search' }],
    });

    expect(built.issues).toEqual([]);
    expect(keysOf(built.resolveGroup('custom:team') ?? [])).toEqual([]);
    expect(keysOf(built.resolveDefault())).toEqual([]);
    // The planner still owns the availability notice for a reserve member.
    expect(keysOf(built.resolveConfiguredReserve([]))).toEqual(['exa/search']);
  });

  it('keeps a bare provider group member fanning out to its selectable profiles', () => {
    const built = catalog({ groups: { team: ['openrouter'] } });

    expect(built.issues).toEqual([]);
    expect(keysOf(built.resolveGroup('custom:team') ?? [])).toEqual([
      'openrouter/grounded',
      'openrouter/chat',
    ]);
  });
});
