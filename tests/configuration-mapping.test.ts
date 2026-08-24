import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  configGroupProvenance,
  loadConfig,
  mergeConfigs,
} from '../src/core/config.js';
import {
  type ConfigurationMappingOptions,
  mapConfiguration as mapRawConfiguration,
  resolveConfigurationProfileToken,
} from '../src/core/configuration-mapping.js';
import { prepareResearchExecution } from '../src/core/execution-plan.js';
import {
  adapterProfileBinding,
  adapterProfileBindings,
  BUILTIN_PROFILE_BINDING_SPECS,
} from '../src/core/profile-bindings.js';
import { BUILTIN_PROVIDER_CATALOG } from '../src/core/provider-profiles.js';
import { sortPreparationDiagnostics } from '../src/core/research-request.js';
import {
  compileNormalizedTransportRequest,
  normalizeCliRequest,
  normalizeConfigurationRequest,
  normalizeMcpRequest,
} from '../src/core/transport-normalization.js';
import type { Config } from '../src/types.js';

function config(
  overrides: Partial<Config> & {
    defaults?: Partial<Config['defaults']>;
  } = {},
): Config {
  const { defaults, ...rest } = overrides;
  return {
    version: 1,
    defaults: {
      outputDir: './agents/librarium',
      maxParallel: 6,
      timeout: 30,
      asyncTimeout: 1800,
      asyncPollInterval: 10,
      mode: 'sync',
      llmWebSearch: true,
      ...defaults,
    },
    providers: {},
    customProviders: {},
    trustedProviderIds: [],
    groups: {},
    ...rest,
  };
}

function credentials() {
  return {
    env: Object.fromEntries(
      BUILTIN_PROVIDER_CATALOG.map((entry) => [
        entry.credential.env_var,
        'test-credential',
      ]),
    ),
  };
}

function dependencies() {
  const counts = new Map<string, number>();
  return {
    clock: { now: () => Date.parse('2026-08-09T12:00:00Z') },
    ids: {
      next: (scope: 'request' | 'slot' | 'fallback_candidate') => {
        const next = (counts.get(scope) ?? 0) + 1;
        counts.set(scope, next);
        return `${scope}-${next}`;
      },
    },
  };
}

function keys(values: readonly { provider_id: string; profile_id: string }[]) {
  return values.map((value) => `${value.provider_id}/${value.profile_id}`);
}

function customProviderConfig(
  overrides: Partial<Config> & { defaults?: Partial<Config['defaults']> } = {},
): Config {
  return config({
    providers: { 'acme-adapter': { enabled: true } },
    customProviders: {
      'acme-adapter': {
        type: 'npm',
        module: 'acme-provider',
        executionProfile: {
          bindingId: 'acme.search.v1',
          profile: {
            identity: {
              provider_id: 'acme-provider',
              profile_id: 'search',
              target: { primary: { model_selection: 'not_applicable' } },
            },
            result_kind: 'search_results',
            observation_mode: 'api_output',
            corpora: ['web'],
            retrieval_method: 'search_endpoint',
            access_mode: 'direct',
            operator_id: 'acme-provider',
            invocation: 'inline',
            resumability: 'none',
          },
        },
      },
    },
    trustedProviderIds: ['acme-adapter'],
    ...overrides,
  });
}

const PLANNED_PROVIDER_IDS = BUILTIN_PROVIDER_CATALOG.filter((entry) =>
  entry.profiles.some((profile) => profile.status === 'planned'),
).map((entry) => entry.provider_id);

function customIdentityConfig(
  adapterId: string,
  providerId: string,
  profileId = 'search',
  enabled = true,
): Config {
  const base = customProviderConfig();
  const metadata = base.customProviders['acme-adapter']?.executionProfile;
  if (!metadata) throw new Error('missing custom metadata fixture');
  return config({
    providers: { [adapterId]: { enabled } },
    customProviders: {
      [adapterId]: {
        type: 'npm',
        module: 'must-not-load',
        executionProfile: {
          ...metadata,
          profile: {
            ...metadata.profile,
            identity: {
              ...metadata.profile.identity,
              provider_id: providerId,
              profile_id: profileId,
            },
          },
        },
      },
    },
    trustedProviderIds: [adapterId],
  });
}

function map(
  config: Config,
  options: Omit<ConfigurationMappingOptions, 'authoredGroups'> & {
    authoredGroups?: ConfigurationMappingOptions['authoredGroups'];
  } = {},
) {
  return mapRawConfiguration(config, {
    authoredGroups: { global: config.groups, project: {} },
    ...options,
  });
}

describe('configuration mapping', () => {
  it('maps only trusted enabled custom metadata into exact groups and reserves', () => {
    const source = customProviderConfig({
      providers: {
        exa: { enabled: true, fallback: 'acme-adapter' },
        'acme-adapter': { enabled: true },
      },
      groups: { team: ['acme-adapter'] },
    });
    const mapped = map(source, {
      requestDeadlineMs: 2_000_000,
      credentials: credentials(),
    });
    expect(mapped.preflight.issues).toEqual([]);
    expect(mapped.custom_profile_bindings).toEqual([
      expect.objectContaining({
        adapter_id: 'acme-adapter',
        binding_id: 'acme.search.v1',
      }),
    ]);
    expect(mapped.groups.team).toEqual(['acme-provider/search']);
    expect(keys(mapped.reserve)).toEqual(['acme-provider/search']);
    expect(mapped.catalog.resolveGroup('custom:team')).toEqual([
      expect.objectContaining({
        provider_id: 'acme-provider',
        profile_id: 'search',
      }),
    ]);

    for (const filtered of [
      customProviderConfig({ trustedProviderIds: [] }),
      customProviderConfig({
        providers: { 'acme-adapter': { enabled: false } },
      }),
    ]) {
      const result = map(filtered, { requestDeadlineMs: 2_000_000 });
      expect(result.custom_profile_bindings).toEqual([]);
      expect(result.catalog.get('acme-provider', 'search')).toBeUndefined();
    }
  });

  it.each(PLANNED_PROVIDER_IDS)(
    'keeps planned built-in adapter id %s reserved during mapping',
    (providerId) => {
      const source = customIdentityConfig(
        providerId,
        'custom-identity',
        'search',
      );
      const mapped = map(source, { requestDeadlineMs: 2_000_000 });
      expect(mapped.custom_profile_bindings).toEqual([]);
      expect(mapped.preflight.issues).not.toContainEqual(
        expect.objectContaining({ code: 'custom_provider_profile_missing' }),
      );
    },
  );

  it.each([
    ...PLANNED_PROVIDER_IDS,
    'perplexity-sonar',
    'perplexity-deep',
    'openai-deep',
    'openai-deep-o3',
  ])(
    'rejects custom metadata claiming reserved provider identity %s',
    (providerId) => {
      const mapped = map(customIdentityConfig('acme-adapter', providerId), {
        requestDeadlineMs: 2_000_000,
      });
      expect(mapped.custom_profile_bindings).toEqual([]);
      expect(mapped.preflight.issues).toContainEqual({
        code: 'custom_provider_profile_provider_id_reserved',
        phase: 'migration',
        path: '/customProviders/acme-adapter/executionProfile/profile/identity/provider_id',
        message:
          'A custom profile cannot claim a current, planned, or retired built-in provider id.',
      });
    },
  );

  it.each([
    {
      source: customIdentityConfig('acme/adapter', 'acme-provider'),
      code: 'custom_provider_adapter_id_unaddressable',
      path: '/customProviders/acme~1adapter',
    },
    {
      source: customIdentityConfig('acme~adapter', 'acme/provider'),
      code: 'custom_provider_profile_id_unaddressable',
      path: '/customProviders/acme~0adapter/executionProfile/profile/identity/provider_id',
    },
    {
      source: customIdentityConfig('acme-adapter', 'acme/provider'),
      code: 'custom_provider_profile_id_unaddressable',
      path: '/customProviders/acme-adapter/executionProfile/profile/identity/provider_id',
    },
    {
      source: customIdentityConfig(
        'acme-adapter',
        'acme-provider',
        'search/v2',
      ),
      code: 'custom_provider_profile_id_unaddressable',
      path: '/customProviders/acme-adapter/executionProfile/profile/identity/profile_id',
    },
  ])(
    'returns a stable $code issue instead of throwing',
    ({ source, code, path }) => {
      expect(() => map(source, { requestDeadlineMs: 2_000_000 })).not.toThrow();
      const mapped = map(source, { requestDeadlineMs: 2_000_000 });
      expect(mapped.custom_profile_bindings).toEqual([]);
      expect(mapped.preflight.issues).toContainEqual(
        expect.objectContaining({ code, path }),
      );
    },
  );

  it.each(['', ' acme-adapter', 'acme\u0001adapter'])(
    'rejects invalid eligible adapter record key %j without throwing',
    (adapterId) => {
      const mapped = map(customIdentityConfig(adapterId, 'acme-provider'), {
        requestDeadlineMs: 2_000_000,
      });
      expect(mapped.custom_profile_bindings).toEqual([]);
      expect(mapped.preflight.issues).toContainEqual(
        expect.objectContaining({ code: 'custom_provider_adapter_id_invalid' }),
      );
    },
  );

  it('admits a trusted disabled custom profile only as a configured reserve', () => {
    const source = customProviderConfig({
      providers: {
        exa: { enabled: true, fallback: 'acme-adapter' },
        'acme-adapter': { enabled: false },
      },
    });
    const mapped = map(source, {
      requestDeadlineMs: 2_000_000,
      credentials: credentials(),
    });
    expect(mapped.preflight.issues).toEqual([]);
    expect(mapped.custom_profile_bindings).toHaveLength(1);
    expect(mapped.reserve_only_adapter_ids).toEqual(['acme-adapter']);
    expect(keys(mapped.reserve)).toEqual(['acme-provider/search']);
    expect(
      mapped.catalog.get('acme-provider', 'search')?.availability,
    ).toMatchObject({ enabled: false, reserve_only: true, selectable: false });
    expect(keys(mapped.catalog.resolveDefault())).toEqual(['exa/search']);
  });

  it('owns and freezes custom profile bindings independently of caller config', () => {
    const source = customProviderConfig();
    const mapped = map(source, { requestDeadlineMs: 2_000_000 });
    const digest = mapped.catalog.digest;
    expect(Object.isFrozen(mapped.custom_profile_bindings)).toBe(true);
    expect(Object.isFrozen(mapped.custom_profile_bindings[0]?.profile)).toBe(
      true,
    );
    const metadata = source.customProviders['acme-adapter']?.executionProfile;
    if (!metadata) throw new Error('missing custom metadata fixture');
    metadata.profile.identity.provider_id = 'mutated';
    expect(
      mapped.custom_profile_bindings[0]?.profile.identity.provider_id,
    ).toBe('acme-provider');
    expect(mapped.catalog.digest).toBe(digest);
  });

  it('orders preflight diagnostics by phase, path, code, and profile key', () => {
    const sorted = sortPreparationDiagnostics([
      {
        code: 'z',
        phase: 'validation',
        path: '/a',
        message: 'validation',
      },
      {
        code: 'z',
        phase: 'migration',
        path: '/z',
        message: 'migration later path',
      },
      {
        code: 'a',
        phase: 'migration',
        path: '/a',
        message: 'migration earlier path',
      },
      {
        code: 'same',
        phase: 'migration',
        path: '/same',
        message: 'later key',
        profile_key: 'z/profile',
      },
      {
        code: 'same',
        phase: 'migration',
        path: '/same',
        message: 'earlier key',
        profile_key: 'a/profile',
      },
      {
        code: 'a-code',
        phase: 'migration',
        path: '/tie',
        message: 'code first',
      },
      {
        code: 'z-code',
        phase: 'migration',
        path: '/tie',
        message: 'code last',
      },
    ]);
    expect(
      sorted.map(({ phase, path, code, profile_key }) => [
        phase,
        path,
        code,
        profile_key,
      ]),
    ).toEqual([
      ['migration', '/a', 'a', undefined],
      ['migration', '/same', 'same', 'a/profile'],
      ['migration', '/same', 'same', 'z/profile'],
      ['migration', '/tie', 'a-code', undefined],
      ['migration', '/tie', 'z-code', undefined],
      ['migration', '/z', 'z', undefined],
      ['validation', '/a', 'z', undefined],
    ]);
  });

  it('uses the validated full adapter matrix, including distinct OpenRouter identities', () => {
    const matrix = adapterProfileBindings();
    expect(matrix.size).toBe(BUILTIN_PROFILE_BINDING_SPECS.length - 2);
    expect(
      [...matrix.values()].map((binding) => binding.adapter_id).sort(),
    ).toEqual(
      BUILTIN_PROFILE_BINDING_SPECS.filter(
        (binding) =>
          ![
            'exa-research',
            'tavily-research',
            'you-research-background',
          ].includes(binding.adapter_id),
      )
        .map((binding) => binding.adapter_id)
        .sort(),
    );
    expect(adapterProfileBinding('openrouter-online')).toMatchObject({
      provider_id: 'openrouter',
      profile_id: 'grounded',
    });
    expect(adapterProfileBinding('openrouter-chat')).toMatchObject({
      provider_id: 'openrouter',
      profile_id: 'chat',
    });
  });

  it('keeps retired ids out of current token resolution while preserving private v1 migration', () => {
    expect(resolveConfigurationProfileToken('perplexity-sonar')).toEqual({
      kind: 'retired',
      token: 'perplexity-sonar',
      replacement: 'perplexity-sonar-pro',
    });
    expect(
      resolveConfigurationProfileToken('perplexity-sonar', [], {
        migrateRetired: true,
      }),
    ).toEqual({
      kind: 'exact',
      token: 'perplexity-sonar',
      target: { provider_id: 'perplexity-sonar-pro', profile_id: 'grounded' },
      alias: {
        from: 'perplexity-sonar',
        adapter_id: 'perplexity-sonar-pro',
      },
    });
  });

  it.each([
    ['perplexity-sonar/grounded', 'perplexity-sonar-pro/grounded'],
    ['perplexity-deep/research', 'perplexity-sonar-deep/research'],
    ['perplexity-pro-search/grounded', 'perplexity-sonar-pro/grounded'],
    ['perplexity-advanced-deep/research', 'perplexity-sonar-deep/research'],
    ['openai-deep/research', 'openai-research/research'],
    ['openai-deep-o3/research', 'openai-research/research'],
  ])('preserves qualified retired suffixes for %s', (token, replacement) => {
    expect(resolveConfigurationProfileToken(token)).toEqual({
      kind: 'retired',
      token,
      replacement,
    });
    expect(
      resolveConfigurationProfileToken(token, [], { migrateRetired: true }),
    ).toMatchObject({
      kind: 'exact',
      token,
      target: {
        provider_id: replacement.split('/')[0],
        profile_id: replacement.split('/')[1],
      },
      alias: { from: token },
    });
  });

  it('resolves active aliases, display names, and qualified profiles without collapsing OpenRouter', () => {
    expect(
      resolveConfigurationProfileToken('OpenRouter Online Search'),
    ).toEqual({
      kind: 'exact',
      token: 'OpenRouter Online Search',
      target: { provider_id: 'openrouter', profile_id: 'grounded' },
    });
    expect(resolveConfigurationProfileToken('openrouter/chat')).toEqual({
      kind: 'exact',
      token: 'openrouter/chat',
      target: { provider_id: 'openrouter', profile_id: 'chat' },
    });
    expect(resolveConfigurationProfileToken('openrouter')).toEqual({
      kind: 'ambiguous',
      token: 'openrouter',
      candidates: [
        { provider_id: 'openrouter', profile_id: 'chat' },
        { provider_id: 'openrouter', profile_id: 'grounded' },
      ],
    });
  });

  it.each(['exa-research', 'tavily-research', 'you-research-background'])(
    'rejects private internal adapter token %s',
    (token) => {
      expect(resolveConfigurationProfileToken(token)).toMatchObject({
        kind: 'unknown',
        token,
      });
    },
  );

  it('preserves raw aliases from the real load/merge path for mapper notices', () => {
    const directory = mkdtempSync(join(tmpdir(), 'librarium-mapping-'));
    try {
      const path = join(directory, 'config.json');
      writeFileSync(
        path,
        JSON.stringify(config({ groups: { global: ['perplexity-sonar'] } })),
      );
      const merged = mergeConfigs(loadConfig(path), {
        groups: { project: ['perplexity-sonar'] },
      });
      const provenance = configGroupProvenance(merged);
      expect(provenance).toEqual({
        global: { global: ['perplexity-sonar'] },
        project: { project: ['perplexity-sonar'] },
      });
      // v1 merged execution remains canonicalized independently.
      expect(merged.groups.global).toEqual(['perplexity-sonar-pro']);
      expect(merged.groups.project).toEqual(['perplexity-sonar-pro']);

      const mapped = map(merged, {
        requestDeadlineMs: 2_000_000,
        credentials: credentials(),
        authoredGroups: provenance,
      });
      expect(mapped.groups).toEqual({
        global: ['perplexity-sonar-pro/grounded'],
        project: ['perplexity-sonar-pro/grounded'],
      });
      expect(
        mapped.preflight.notices.filter(
          (notice) => notice.code === 'configuration_provider_alias_migrated',
        ),
      ).toHaveLength(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('leaves the default roster catalog-owned and ordered by selection order', () => {
    const mapped = map(
      config({
        // Deliberately opposite catalog order.
        providers: {
          'brave-search': { enabled: true },
          exa: { enabled: true },
        },
      }),
      { requestDeadlineMs: 2_000_000, credentials: credentials() },
    );

    expect(keys(mapped.catalog.resolveDefault())).toEqual([
      'exa/search',
      'brave-search/search',
    ]);
  });

  it('does not map injected v1 default groups as custom groups, but migrates explicit reserved groups', () => {
    const global = loadConfig('/definitely/missing/librarium-config.json');
    const direct = map(global, {
      requestDeadlineMs: 2_000_000,
      credentials: credentials(),
      authoredGroups: configGroupProvenance(global),
    });
    expect(direct.catalog.custom_group_ids).toEqual([]);
    const merged = mergeConfigs(global, {
      groups: { quick: ['exa/search'] },
    });
    const mapped = map(merged, {
      requestDeadlineMs: 2_000_000,
      credentials: credentials(),
      authoredGroups: configGroupProvenance(merged),
    });

    expect(configGroupProvenance(merged)).toEqual({
      global: {},
      project: { quick: ['exa/search'] },
    });
    expect(mapped.groups).toEqual({ quick: ['exa/search'] });
    expect(mapped.group_aliases).toEqual({ quick: 'custom:quick' });
    expect(mapped.catalog.custom_group_ids).toEqual(['custom:quick']);
    expect(mapped.preflight.notices).toContainEqual(
      expect.objectContaining({
        code: 'reserved_workflow_name_migrated',
        path: '/groups/quick',
      }),
    );
  });

  it('does not alias a colliding raw group over an explicit custom group', () => {
    for (const [groups, code] of [
      [
        { quick: ['exa'], 'custom:quick': ['tavily'] },
        'reserved_workflow_name_collision',
      ],
      [
        { team: ['exa'], 'custom:team': ['tavily'] },
        'custom_group_name_collision',
      ],
    ] as const) {
      const source = config({ groups });
      const mapped = map(source, {
        requestDeadlineMs: 2_000_000,
        credentials: credentials(),
      });
      expect(mapped.group_aliases).toEqual({});
      expect(mapped.preflight.issues).toContainEqual(
        expect.objectContaining({ code }),
      );
    }
  });

  it('preserves JSON-authored prototype-like group names as own custom groups', () => {
    const source = config({
      providers: {
        exa: { enabled: true },
        tavily: { enabled: true },
        'brave-search': { enabled: true },
      },
    });
    source.groups = JSON.parse(
      '{"__proto__":["exa"],"constructor":["tavily"],"prototype":["brave-search"]}',
    ) as Config['groups'];
    const mapped = map(source, {
      requestDeadlineMs: 2_000_000,
      credentials: credentials(),
    });

    expect(Object.getPrototypeOf(mapped.groups)).toBe(Object.prototype);
    for (const [name, member] of [
      ['__proto__', 'exa/search'],
      ['constructor', 'tavily/search'],
      ['prototype', 'brave-search/search'],
    ]) {
      expect(Object.hasOwn(mapped.groups, name)).toBe(true);
      expect(mapped.groups[name]).toEqual([member]);
      expect(mapped.group_aliases[name]).toBe(`custom:${name}`);
      expect(mapped.catalog.custom_group_ids).toContain(`custom:${name}`);
    }
    expect(keys(mapped.catalog.resolveGroup('custom:__proto__') ?? [])).toEqual(
      ['exa/search'],
    );
  });

  it('handles a JSON-authored provider prototype key without prototype lookup', () => {
    const source = config();
    source.providers = JSON.parse(
      '{"__proto__":{"enabled":true,"fallback":"exa"},"exa":{"enabled":true}}',
    ) as Config['providers'];
    const mapped = map(source, {
      requestDeadlineMs: 2_000_000,
      credentials: credentials(),
    });
    expect(mapped.preflight.issues).toContainEqual(
      expect.objectContaining({
        code: 'configuration_fallback_unbound_source',
        path: '/providers/__proto__/fallback',
      }),
    );
    expect(keys(mapped.catalog.resolveDefault())).toEqual(['exa/search']);
  });

  it('retains raw global and project authored layers with project precedence', () => {
    const global = config({
      groups: {
        shared: ['perplexity-sonar'],
        global: ['exa'],
      },
    });
    const merged = mergeConfigs(global, {
      groups: {
        shared: ['OpenRouter Online Search'],
        project: ['brave-search'],
      },
    });
    const provenance = configGroupProvenance(merged);
    expect(provenance).toEqual({
      global: {
        shared: ['perplexity-sonar'],
        global: ['exa'],
      },
      project: {
        shared: ['OpenRouter Online Search'],
        project: ['brave-search'],
      },
    });
    const mapped = map(merged, {
      requestDeadlineMs: 2_000_000,
      credentials: credentials(),
      authoredGroups: provenance,
    });
    expect(mapped.groups).toEqual({
      shared: ['openrouter/grounded'],
      global: ['exa/search'],
      project: ['brave-search/search'],
    });
  });

  it.each([true, false])(
    'does not inject llmWebSearch=%s into Parallel Chat',
    (llmWebSearch) => {
      const mapped = map(
        config({
          defaults: { llmWebSearch },
          providers: { 'parallel-chat': { enabled: true } },
        }),
        { requestDeadlineMs: 2_000_000, credentials: credentials() },
      );

      const parallelChat = mapped.catalog.get('parallel', 'chat');
      expect(parallelChat?.availability.configuration_valid).toBe(true);
      expect(parallelChat?.profile.result_kind).toBe('grounded_answer');
    },
  );

  it.each([true, false])(
    'still rejects an explicit unsupported Parallel Chat webSearch=%s option',
    (webSearch) => {
      const mapped = map(
        config({
          providers: {
            'parallel-chat': { enabled: true, options: { webSearch } },
          },
        }),
        { requestDeadlineMs: 2_000_000, credentials: credentials() },
      );

      const parallelChat = mapped.catalog.get('parallel', 'chat');
      expect(parallelChat?.availability.configuration_valid).toBe(false);
      expect(parallelChat?.availability.reasons).toContain(
        'configuration_invalid',
      );
    },
  );

  it.each([
    ['claude', 'claude'],
    ['openai-chat', 'openai-chat'],
    ['gemini-chat', 'gemini-chat'],
    ['openrouter-chat', 'openrouter'],
  ] as const)(
    'preserves llmWebSearch defaults and overrides for %s',
    (adapterId, providerId) => {
      const defaultsOff = map(
        config({
          defaults: { llmWebSearch: false },
          providers: { [adapterId]: { enabled: true } },
        }),
        { requestDeadlineMs: 2_000_000, credentials: credentials() },
      );
      expect(
        defaultsOff.catalog.get(providerId, 'chat')?.profile.result_kind,
      ).toBe('model_answer');

      const defaultsOn = map(
        config({
          defaults: { llmWebSearch: true },
          providers: { [adapterId]: { enabled: true } },
        }),
        { requestDeadlineMs: 2_000_000, credentials: credentials() },
      );
      expect(
        defaultsOn.catalog.get(providerId, 'chat')?.profile.result_kind,
      ).toBe('grounded_answer');

      const providerOverrideOn = map(
        config({
          defaults: { llmWebSearch: false },
          providers: {
            [adapterId]: { enabled: true, options: { webSearch: true } },
          },
        }),
        { requestDeadlineMs: 2_000_000, credentials: credentials() },
      );
      expect(
        providerOverrideOn.catalog.get(providerId, 'chat')?.profile.result_kind,
      ).toBe('grounded_answer');

      const providerOverrideOff = map(
        config({
          defaults: { llmWebSearch: true },
          providers: {
            [adapterId]: { enabled: true, options: { webSearch: false } },
          },
        }),
        { requestDeadlineMs: 2_000_000, credentials: credentials() },
      );
      expect(
        providerOverrideOff.catalog.get(providerId, 'chat')?.profile
          .result_kind,
      ).toBe('model_answer');
    },
  );

  it.each([true, false])(
    'does not inject built-in llmWebSearch=%s behavior into a custom chat provider',
    (llmWebSearch) => {
      const source = customProviderConfig({
        defaults: { llmWebSearch },
      });
      const custom = source.customProviders['acme-adapter'];
      if (!custom?.executionProfile) throw new Error('missing custom fixture');
      source.customProviders['acme-adapter'] = {
        ...custom,
        executionProfile: {
          ...custom.executionProfile,
          bindingId: 'acme.chat.v1',
          profile: {
            ...custom.executionProfile.profile,
            identity: {
              ...custom.executionProfile.profile.identity,
              profile_id: 'chat',
              target: {
                primary: {
                  model_selection: 'provider_managed',
                  kind: 'model',
                },
              },
            },
            result_kind: 'model_answer',
            grounding_policy: 'none',
            corpora: [],
            retrieval_method: 'model_only',
          },
        },
      };

      const mapped = map(source, { requestDeadlineMs: 2_000_000 });
      const customChat = mapped.catalog.get('acme-provider', 'chat');
      expect(customChat?.availability.configuration_valid).toBe(true);
      expect(customChat?.profile).toMatchObject({
        result_kind: 'model_answer',
        grounding_policy: 'none',
        corpora: [],
        retrieval_method: 'model_only',
      });
    },
  );

  it('flattens and deduplicates valid fallback edges in declaration order', () => {
    const mapped = map(
      config({
        providers: {
          exa: { enabled: true, fallback: 'brave-search' },
          tavily: { enabled: true, fallback: 'brave-search' },
          'brave-search': { enabled: false },
          serpapi: { enabled: true, fallback: 'tavily' },
        },
      }),
      { requestDeadlineMs: 2_000_000, credentials: credentials() },
    );

    expect(keys(mapped.reserve)).toEqual([
      'brave-search/search',
      'tavily/search',
    ]);
    expect(mapped.reserve_only_adapter_ids).toEqual(['brave-search']);
    expect(mapped.preflight.notices).toContainEqual(
      expect.objectContaining({
        code: 'configuration_fallback_chain_flattened',
        path: '/providers/serpapi/fallback',
      }),
    );
  });

  it('does not call a rejected nested edge a flattened fallback chain', () => {
    const mapped = map(
      config({
        providers: {
          exa: { enabled: true, fallback: 'brave-search' },
          'brave-search': { enabled: false, fallback: 'tavily' },
          tavily: { enabled: false },
        },
      }),
      { requestDeadlineMs: 2_000_000, credentials: credentials() },
    );
    expect(keys(mapped.reserve)).toEqual(['brave-search/search']);
    expect(mapped.reserve_only_adapter_ids).toEqual(['brave-search']);
    expect(mapped.preflight.notices).toContainEqual(
      expect.objectContaining({
        code: 'configuration_fallback_disabled_source_omitted',
        path: '/providers/brave-search/fallback',
      }),
    );
    expect(mapped.preflight.notices).not.toContainEqual(
      expect.objectContaining({
        code: 'configuration_fallback_chain_flattened',
        path: '/providers/exa/fallback',
      }),
    );
  });

  it('diagnoses malformed, self, unknown, and unbound fallback entries at stable paths', () => {
    const mapped = map(
      config({
        providers: {
          exa: { enabled: true, fallback: 'exa' },
          tavily: { enabled: true, fallback: 'missing-adapter' },
          'custom-adapter': { enabled: true, fallback: 'exa' },
          serpapi: { enabled: true, fallback: '' },
          'unbound-target': { enabled: true },
          'brave-search': { enabled: true, fallback: 'unbound-target' },
        } as Config['providers'],
      }),
      { requestDeadlineMs: 2_000_000 },
    );
    expect(
      mapped.preflight.issues.map(({ code, path }) => [code, path]),
    ).toEqual([
      [
        'configuration_fallback_unbound_target',
        '/providers/brave-search/fallback',
      ],
      [
        'configuration_fallback_unbound_source',
        '/providers/custom-adapter/fallback',
      ],
      ['configuration_fallback_self_reference', '/providers/exa/fallback'],
      ['configuration_fallback_malformed', '/providers/serpapi/fallback'],
      ['configuration_fallback_unknown_adapter', '/providers/tavily/fallback'],
    ]);
  });

  it('canonicalizes raw provider aliases and requires active configured fallback edges', () => {
    const raw = config({
      providers: {
        'openai-deep': { enabled: true, fallback: 'perplexity-sonar' },
        'openai-deep-o3': { enabled: false },
        'openai-research': { enabled: true },
        'perplexity-sonar': { enabled: false },
        exa: { enabled: false, fallback: 'brave-search' },
        tavily: { enabled: true, fallback: 'brave-search' },
        serpapi: { enabled: true, fallback: 'perplexity-sonar' },
        'brave-search': { enabled: false },
      },
    });
    const mapped = map(raw, {
      requestDeadlineMs: 2_000_000,
      credentials: credentials(),
    });
    expect(
      mapped.catalog.get('openai-research', 'research')?.availability.enabled,
    ).toBe(true);
    expect(keys(mapped.reserve)).toEqual([
      'perplexity-sonar-pro/grounded',
      'brave-search/search',
    ]);
    expect(mapped.reserve_only_adapter_ids).toEqual([
      'perplexity-sonar-pro',
      'brave-search',
    ]);
    expect(mapped.preflight.notices).toContainEqual(
      expect.objectContaining({ code: 'configuration_provider_id_migrated' }),
    );
    expect(mapped.preflight.notices).toContainEqual(
      expect.objectContaining({
        code: 'configuration_fallback_id_migrated',
        path: '/providers/serpapi/fallback',
      }),
    );
    expect(mapped.preflight.notices).toContainEqual(
      expect.objectContaining({
        code: 'configuration_provider_alias_collision',
      }),
    );
    expect(mapped.preflight.notices).toContainEqual(
      expect.objectContaining({
        code: 'configuration_fallback_disabled_source_omitted',
        path: '/providers/exa/fallback',
      }),
    );

    const missingTarget = map(
      config({
        providers: { exa: { enabled: true, fallback: 'brave-search' } },
      }),
      { requestDeadlineMs: 2_000_000 },
    );
    expect(missingTarget.preflight.issues).toContainEqual(
      expect.objectContaining({
        code: 'configuration_fallback_target_unconfigured',
        path: '/providers/exa/fallback',
      }),
    );
  });

  it('keeps disabled fallback-only profiles out of primary selection but permits the reserve', () => {
    const mapped = map(
      config({
        providers: {
          exa: { enabled: true, fallback: 'brave-search' },
          'brave-search': { enabled: false },
        },
      }),
      { requestDeadlineMs: 2_000_000, credentials: credentials() },
    );
    expect(keys(mapped.catalog.resolveDefault())).toEqual(['exa/search']);
    expect(keys(mapped.catalog.workflow('all').members)).toEqual([
      'exa/research',
      'exa/search',
    ]);
    expect(keys(mapped.catalog.resolveConfiguredReserve([]))).toEqual([
      'brave-search/search',
    ]);

    const primary = prepareResearchExecution(
      {
        query: 'not primary',
        mode: 'sync',
        selector: {
          kind: 'targets',
          targets: [{ provider_id: 'brave-search', profile_id: 'search' }],
        },
        fallback: { kind: 'disabled' },
        limits: mapped.transport_defaults?.limits,
        exclusions: [],
        refinement: { kind: 'disabled' },
      },
      mapped.catalog,
      dependencies(),
    );
    expect(primary.ok).toBe(false);
    if (primary.ok) throw new Error('reserve-only profile selected as primary');
    expect(primary.issues.map((issue) => issue.code)).toContain(
      'profile_reserve_only',
    );
    expect(primary.issues.map((issue) => issue.code)).not.toContain(
      'profile_disabled',
    );

    const capability = prepareResearchExecution(
      {
        query: 'not capability',
        mode: 'sync',
        selector: {
          kind: 'capabilities',
          requirements: { result_kind: 'search_results', corpora: ['web'] },
        },
        fallback: { kind: 'disabled' },
        limits: mapped.transport_defaults?.limits,
        exclusions: [],
        refinement: { kind: 'disabled' },
      },
      mapped.catalog,
      dependencies(),
    );
    expect(capability.ok).toBe(true);
    if (!capability.ok) return;
    expect(
      keys(
        capability.prepared.request.slots.map((slot) => slot.primary.identity),
      ),
    ).toEqual(['exa/search']);

    const prepared = prepareResearchExecution(
      {
        query: 'reserve only',
        mode: 'sync',
        selector: {
          kind: 'targets',
          targets: [{ provider_id: 'exa', profile_id: 'search' }],
        },
        fallback: { kind: 'configured' },
        limits: mapped.transport_defaults?.limits,
        exclusions: [],
        refinement: { kind: 'disabled' },
      },
      mapped.catalog,
      dependencies(),
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(
      keys(
        prepared.prepared.request.fallback_reserve.map(
          (entry) => entry.profile.identity,
        ),
      ),
    ).toEqual(['brave-search/search']);
  });

  it('uses the real v1 defaults fields and exact budgets, without inventing a request deadline', () => {
    const source = config({
      defaults: {
        mode: 'sync',
        maxParallel: 3,
        timeout: 12,
        asyncTimeout: 90,
        asyncPollInterval: 7,
        maxCostUsd: 0.25,
        maxEstimatedCostUsd: 0.1,
      },
    });
    const missingDeadline = map(source);
    expect(missingDeadline.transport_defaults).toBeUndefined();
    expect(missingDeadline.deadline_migration).toEqual({
      kind: 'v1_request_deadline_migration',
      max_parallel: 3,
      inline_attempt_deadline_ms: 12_000,
      raw_background_attempt_deadline_ms: 90_000,
      poll_interval_ms: 7_000,
      legacy_mode: 'sync',
    });
    expect(Object.isFrozen(missingDeadline.deadline_migration)).toBe(true);
    expect(missingDeadline.preflight.issues).toEqual([]);
    expect(missingDeadline.unresolved_transport_defaults).toEqual({
      mode: 'sync',
      limits: {
        max_concurrency: 3,
        inline_attempt_deadline_ms: 12_000,
        poll_interval_ms: 7_000,
      },
      fallback: { kind: 'configured' },
      refinement: { kind: 'disabled' },
      budgets: {
        max_estimated_cost_microusd: '100000',
        max_actual_cost_microusd: '250000',
      },
    });

    const mapped = map(source, { requestDeadlineMs: 300_000 });
    expect(mapped.deadline_migration).toEqual({
      kind: 'v1_request_deadline_migration',
      max_parallel: 3,
      inline_attempt_deadline_ms: 12_000,
      raw_background_attempt_deadline_ms: 90_000,
      poll_interval_ms: 7_000,
      legacy_mode: 'sync',
      explicit_request_deadline_ms: 300_000,
    });
    const normalized = normalizeConfigurationRequest(
      { query: 'v1 defaults', providers: ['exa'], ...mapped.transport_input },
      mapped.transport_defaults!,
    );
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.request.limits).toEqual({
      max_concurrency: 3,
      request_deadline_ms: 300_000,
      inline_attempt_deadline_ms: 12_000,
      background_attempt_deadline_ms: 90_000,
      poll_interval_ms: 7_000,
    });
    expect(normalized.request.budgets).toEqual({
      max_estimated_cost_microusd: '100000',
      max_actual_cost_microusd: '250000',
    });

    for (const normalize of [normalizeCliRequest, normalizeMcpRequest]) {
      const inherited = normalize(
        { query: 'inherited budget', providers: ['exa'] },
        mapped.transport_defaults!,
      );
      expect(inherited.ok).toBe(true);
      if (!inherited.ok) continue;
      expect(inherited.request.budgets).toEqual(normalized.request.budgets);
    }
  });

  it.each([
    ['fractional maxParallel', { maxParallel: 1.5 }, '/defaults/maxParallel'],
    ['negative timeout', { timeout: -1 }, '/defaults/timeout'],
    ['fractional timeout', { timeout: 1.5 }, '/defaults/timeout'],
    [
      'unsafe asyncTimeout',
      { asyncTimeout: Number.MAX_SAFE_INTEGER + 1 },
      '/defaults/asyncTimeout',
    ],
  ])(
    'withholds deadline migration context for %s',
    (_label, defaults, path) => {
      const mapped = map(config({ defaults }));
      expect(mapped.deadline_migration).toBeUndefined();
      expect(mapped.transport_defaults).toBeUndefined();
      expect(mapped.preflight.issues).toContainEqual(
        expect.objectContaining({ path }),
      );
    },
  );

  it.each([1.5, -1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid explicit request deadline %s at the config boundary',
    (requestDeadlineMs) => {
      const mapped = map(config(), { requestDeadlineMs });
      expect(mapped.deadline_migration).toBeUndefined();
      expect(mapped.transport_defaults).toBeUndefined();
      expect(mapped.preflight.issues).toContainEqual(
        expect.objectContaining({
          code: 'configuration_deadline_invalid_integer',
          path: '/defaults/requestDeadlineMs',
        }),
      );
    },
  );

  it.each([
    {
      name: 'below inline attempt',
      defaults: { timeout: 12, asyncTimeout: 10, asyncPollInterval: 5 },
      requestDeadlineMs: 11_999,
    },
    {
      name: 'below background attempt',
      defaults: { timeout: 10, asyncTimeout: 12, asyncPollInterval: 5 },
      requestDeadlineMs: 11_999,
    },
  ])('rejects an explicit deadline $name', (fixture) => {
    const mapped = map(config({ defaults: fixture.defaults }), {
      requestDeadlineMs: fixture.requestDeadlineMs,
    });
    expect(
      mapped.preflight.issues.map(({ code, path }) => ({ code, path })),
    ).toContainEqual({
      code: 'configuration_request_deadline_less_than_attempt_deadline',
      path: '/defaults/requestDeadlineMs',
    });
    expect(mapped.deadline_migration).toBeUndefined();
    expect(mapped.transport_defaults).toBeUndefined();
  });

  it('accepts an explicit deadline equal to the larger attempt deadline', () => {
    const mapped = map(
      config({
        defaults: { timeout: 10, asyncTimeout: 12, asyncPollInterval: 5 },
      }),
      { requestDeadlineMs: 12_000 },
    );
    expect(mapped.preflight.issues).toEqual([]);
    expect(mapped.transport_defaults?.limits).toEqual({
      max_concurrency: 6,
      request_deadline_ms: 12_000,
      inline_attempt_deadline_ms: 10_000,
      background_attempt_deadline_ms: 12_000,
      poll_interval_ms: 5_000,
    });
  });

  it.each([
    {
      name: 'asyncTimeout above the 7-day contract maximum',
      defaults: { asyncTimeout: 604_801 },
      code: 'configuration_deadline_contract_maximum_exceeded',
      path: '/defaults/asyncTimeout',
    },
    {
      name: 'timeout seconds-to-milliseconds safe-integer overflow',
      defaults: { timeout: Number.MAX_SAFE_INTEGER },
      code: 'configuration_deadline_arithmetic_overflow',
      path: '/defaults/timeout',
    },
    {
      name: 'poll seconds-to-milliseconds safe-integer overflow',
      defaults: { asyncPollInterval: Number.MAX_SAFE_INTEGER },
      code: 'configuration_poll_interval_arithmetic_overflow',
      path: '/defaults/asyncPollInterval',
    },
  ])('rejects $name with its exact diagnostic', (fixture) => {
    const mapped = map(config({ defaults: fixture.defaults }));
    expect(
      mapped.preflight.issues.map(({ code, path }) => ({ code, path })),
    ).toContainEqual({ code: fixture.code, path: fixture.path });
    expect(mapped.deadline_migration).toBeUndefined();
  });

  it('rejects requestDeadlineMs one millisecond above seven days', () => {
    const mapped = map(config(), { requestDeadlineMs: 604_800_001 });
    expect(
      mapped.preflight.issues.map(({ code, path }) => ({ code, path })),
    ).toContainEqual({
      code: 'configuration_deadline_contract_maximum_exceeded',
      path: '/defaults/requestDeadlineMs',
    });
    expect(mapped.transport_defaults).toBeUndefined();
  });

  it.each([
    ['fractional', 1.5, 'configuration_poll_interval_invalid_integer'],
    ['negative', -1, 'configuration_poll_interval_invalid_integer'],
    [
      'unsafe',
      Number.MAX_SAFE_INTEGER + 1,
      'configuration_poll_interval_invalid_integer',
    ],
    ['out-of-range', 301, 'configuration_poll_interval_out_of_bounds'],
  ])(
    'rejects %s asyncPollInterval before canonical defaults',
    (_label, asyncPollInterval, code) => {
      const mapped = map(config({ defaults: { asyncPollInterval } }), {
        requestDeadlineMs: 2_000_000,
      });
      expect(mapped.deadline_migration).toBeUndefined();
      expect(mapped.transport_defaults).toBeUndefined();
      expect(mapped.preflight.issues).toContainEqual(
        expect.objectContaining({
          code,
          path: '/defaults/asyncPollInterval',
        }),
      );
    },
  );

  it('rejects asyncPollInterval above the background attempt timeout', () => {
    const mapped = map(
      config({ defaults: { asyncTimeout: 2, asyncPollInterval: 3 } }),
      { requestDeadlineMs: 2_000_000 },
    );
    expect(mapped.deadline_migration).toBeUndefined();
    expect(mapped.transport_defaults).toBeUndefined();
    expect(mapped.preflight.issues).toContainEqual(
      expect.objectContaining({
        code: 'configuration_poll_interval_exceeds_background_attempt',
        path: '/defaults/asyncPollInterval',
      }),
    );
  });

  it('accepts asyncPollInterval at the 300-second contract maximum', () => {
    const mapped = map(
      config({ defaults: { asyncTimeout: 300, asyncPollInterval: 300 } }),
      { requestDeadlineMs: 300_000 },
    );
    expect(mapped.preflight.issues).toEqual([]);
    expect(mapped.deadline_migration?.poll_interval_ms).toBe(300_000);
  });

  it('withholds transport defaults when any configured budget is inexact', () => {
    const source = config({
      defaults: { maxCostUsd: 0.25, maxEstimatedCostUsd: 0.0000001 },
    });
    const mapped = map(source, { requestDeadlineMs: 2_000_000 });
    expect(mapped.transport_defaults).toBeUndefined();
    expect(mapped.preflight.issues).toContainEqual(
      expect.objectContaining({
        code: 'transport_budget_not_exact',
        path: '/defaults/maxEstimatedCostUsd',
      }),
    );
  });

  it('preserves legacy mixed defaults through normalization for the migration notice', () => {
    const mapped = map(
      config({
        defaults: { mode: 'mixed' },
        providers: { 'openai-research': { enabled: true } },
      }),
      { requestDeadlineMs: 2_000_000, credentials: credentials() },
    );
    const normalized = normalizeConfigurationRequest(
      {
        query: 'mixed default',
        providers: ['openai-research'],
        ...mapped.transport_input,
      },
      mapped.transport_defaults!,
    );
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.request.mode).toBe('mixed');
    const compiled = compileNormalizedTransportRequest(
      normalized,
      mapped.catalog,
      dependencies(),
    );
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
    expect(compiled.notices).toContainEqual(
      expect.objectContaining({ code: 'legacy_mixed_mode_migrated' }),
    );
  });

  it('canonicalizes authored group members while preserving order and diagnostics', () => {
    const mapped = map(
      config({
        groups: {
          team: [
            'perplexity-sonar',
            'OpenRouter Online Search',
            'openrouter-online',
            'missing',
            'openrouter',
          ],
        },
      }),
      { requestDeadlineMs: 2_000_000, credentials: credentials() },
    );
    expect(mapped.groups).toEqual({
      team: ['perplexity-sonar-pro/grounded', 'openrouter/grounded'],
    });
    expect(mapped.preflight.notices).toContainEqual(
      expect.objectContaining({
        code: 'configuration_provider_alias_migrated',
        path: '/groups/team/0',
      }),
    );
    expect(
      mapped.preflight.issues.map(({ code, path }) => [code, path]),
    ).toEqual([
      ['configuration_group_member_unknown', '/groups/team/3'],
      ['configuration_group_member_ambiguous', '/groups/team/4'],
    ]);
  });

  it('merges sorted catalog and mapping diagnostics into preflight', () => {
    const mapped = map(
      config({
        groups: { broken: ['nope/search'] },
        providers: { exa: { enabled: true, fallback: 'missing-adapter' } },
      }),
      { requestDeadlineMs: 2_000_000 },
    );
    expect(
      mapped.preflight.issues.map(({ code, path }) => [code, path]),
    ).toEqual([
      ['configuration_group_member_unknown', '/groups/broken/0'],
      ['configuration_fallback_unknown_adapter', '/providers/exa/fallback'],
    ]);
  });

  it('uses the shared model selection diagnostics before v1 factory construction', () => {
    const mapped = map(
      config({
        providers: {
          exa: { enabled: true, model: 'not-supported' },
          'gemini-grounded': { enabled: true, model: 'gemini-3.6-flash' },
          'openrouter-online': { enabled: true, model: 'openai/gpt-4o' },
        },
      }),
      { requestDeadlineMs: 2_000_000 },
    );
    expect(mapped.preflight.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'config_model_not_configurable',
          path: '/providers/exa/model',
        }),
        expect.objectContaining({
          code: 'config_model_not_allowed',
          path: '/providers/gemini-grounded/model',
        }),
      ]),
    );
    expect(mapped.preflight.issues).not.toContainEqual(
      expect.objectContaining({ path: '/providers/openrouter-online/model' }),
    );
  });
});
