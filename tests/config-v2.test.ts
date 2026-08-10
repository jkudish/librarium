import { describe, expect, it } from 'vitest';
import {
  type LibrariumConfigV2,
  migrateConfig,
  validateConfigV2,
} from '../src/core/config-v2.js';

function v1(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    defaults: {
      outputDir: './agents/librarium',
      maxParallel: 4,
      timeout: 30,
      asyncTimeout: 1800,
      asyncPollInterval: 10,
      mode: 'sync',
      llmWebSearch: true,
    },
    providers: {},
    customProviders: {},
    trustedProviderIds: [],
    groups: {},
    ...overrides,
  };
}

function v2(overrides: Partial<LibrariumConfigV2> = {}): LibrariumConfigV2 {
  return {
    version: 2,
    execution_defaults: {
      mode: 'sync',
      max_concurrency: 4,
      inline_attempt_deadline_ms: 30_000,
      background_attempt_deadline_ms: 1_800_000,
      poll_interval_ms: 10_000,
    },
    providers: {},
    custom_providers: {},
    trusted_provider_ids: [],
    groups: {},
    runtime: {
      output_dir: './agents/librarium',
      llm_web_search: true,
    },
    ...overrides,
  };
}

function customSource(
  providerId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    type: 'npm' as const,
    module: `${providerId}-module`,
    execution_profile: {
      binding_id: `${providerId}.search.v1`,
      profile: {
        identity: {
          provider_id: providerId,
          profile_id: 'search',
          target: { primary: { model_selection: 'not_applicable' as const } },
        },
        result_kind: 'search_results' as const,
        observation_mode: 'api_output' as const,
        corpora: ['web' as const],
        retrieval_method: 'search_endpoint' as const,
        access_mode: 'direct' as const,
        operator_id: providerId,
        invocation: 'inline' as const,
        resumability: 'none' as const,
        ...overrides,
      },
    },
  };
}

describe('public v2 configuration migration', () => {
  it('migrates exact v1 defaults, mixed mode, costs, and runtime fields', () => {
    const result = migrateConfig({
      global: v1({
        defaults: {
          outputDir: './research',
          maxParallel: 3,
          timeout: 12,
          asyncTimeout: 90,
          asyncPollInterval: 7,
          mode: 'mixed',
          llmWebSearch: false,
          maxCostUsd: 0.25,
          maxEstimatedCostUsd: 0.1,
        },
        refine: { provider: 'openai', model: 'refine-model' },
        answer: { provider: 'gemini' },
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.execution_defaults).toEqual({
      mode: 'async',
      max_concurrency: 3,
      inline_attempt_deadline_ms: 12_000,
      background_attempt_deadline_ms: 90_000,
      poll_interval_ms: 7_000,
      max_actual_cost_microusd: '250000',
      max_estimated_cost_microusd: '100000',
    });
    expect(result.config.execution_defaults).not.toHaveProperty(
      'request_deadline_ms',
    );
    expect(result.config).not.toHaveProperty('selector');
    expect(result.config.runtime).toEqual({
      output_dir: './research',
      llm_web_search: false,
      refine: { provider: 'openai', model: 'refine-model' },
      answer: { provider: 'gemini' },
    });
    expect(result.notices).toContainEqual(
      expect.objectContaining({ code: 'legacy_mixed_mode_migrated' }),
    );
    expect(Object.isFrozen(result.config)).toBe(true);
  });

  it('preserves the legacy 30-second omitted poll default and exact decimal budgets', () => {
    const source = v1();
    source.defaults = {
      outputDir: './agents/librarium',
      maxParallel: 2,
      timeout: 30,
      asyncTimeout: 1800,
      mode: 'sync',
      llmWebSearch: true,
      maxCostUsd: 8.03,
      maxEstimatedCostUsd: 1.005,
    } as typeof source.defaults;
    const result = migrateConfig({ global: source });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.execution_defaults).toMatchObject({
      poll_interval_ms: 30_000,
      max_actual_cost_microusd: '8030000',
      max_estimated_cost_microusd: '1005000',
    });
  });

  it('migrates every authored v1 group to custom:<name> without injecting defaults', () => {
    const result = migrateConfig({
      global: v1({
        providers: { exa: { enabled: true } },
        groups: Object.fromEntries(
          [
            'quick',
            'deep',
            'visibility',
            'all',
            'raw',
            'fast',
            'llm',
            'models',
            'comprehensive',
            'social',
            'xai',
            'team',
          ].map((name) => [name, ['exa']]),
        ),
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.config.groups)).toEqual([
      'custom:all',
      'custom:comprehensive',
      'custom:deep',
      'custom:fast',
      'custom:llm',
      'custom:models',
      'custom:quick',
      'custom:raw',
      'custom:social',
      'custom:team',
      'custom:visibility',
      'custom:xai',
    ]);
    expect(result.selection_aliases.quick).toBe('custom:quick');
    expect(result.selection_aliases.raw).toBe('custom:raw');
    expect(result.config.groups['custom:quick']).toEqual(['exa/search']);
  });

  it('rejects bare/custom group collisions deterministically', () => {
    const forward = migrateConfig({
      global: v1({
        providers: { exa: { enabled: true }, tavily: { enabled: true } },
        groups: { team: ['exa'], 'custom:team': ['tavily'] },
      }),
    });
    const reverse = migrateConfig({
      global: v1({
        providers: { exa: { enabled: true }, tavily: { enabled: true } },
        groups: { 'custom:team': ['tavily'], team: ['exa'] },
      }),
    });
    for (const result of [forward, reverse]) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: 'config_group_name_collision' }),
      );
    }
  });

  it('canonicalizes v1 provider aliases before project precedence merging', () => {
    const result = migrateConfig({
      global: v1({
        providers: {
          'openai-research': { enabled: true, model: 'global-model' },
          'perplexity-sonar': { enabled: false },
        },
      }),
      project: {
        providers: {
          'openai-deep-o3': { model: 'project-model' },
          'perplexity-sonar': { enabled: true },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.providers['openai-research']).toMatchObject({
      enabled: true,
      model: 'project-model',
    });
    expect(result.config.providers['perplexity-sonar-pro']?.enabled).toBe(true);
    expect(result.config.providers).not.toHaveProperty('openai-deep-o3');
  });

  it('makes canonical provider ids win every alias collision independent of JSON order', () => {
    for (const providers of [
      {
        'perplexity-sonar': { enabled: false },
        'perplexity-sonar-pro': { enabled: true },
      },
      {
        'perplexity-sonar-pro': { enabled: true },
        'perplexity-sonar': { enabled: false },
      },
    ]) {
      const result = migrateConfig({ global: v1({ providers }) });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.config.providers['perplexity-sonar-pro']?.enabled).toBe(
        true,
      );
      expect(result.notices).toContainEqual(
        expect.objectContaining({ code: 'config_provider_alias_collision' }),
      );
    }
  });

  it('preserves custom providers and revokes inherited trust on project replacement', () => {
    const executionProfile = {
      bindingId: 'acme.search.v1',
      profile: {
        identity: {
          provider_id: 'acme-provider',
          profile_id: 'search',
          target: { primary: { model_selection: 'not_applicable' as const } },
        },
        result_kind: 'search_results' as const,
        observation_mode: 'api_output' as const,
        corpora: ['web' as const],
        retrieval_method: 'search_endpoint' as const,
        access_mode: 'direct' as const,
        operator_id: 'acme-provider',
        invocation: 'inline' as const,
        resumability: 'none' as const,
      },
    };
    const global = v1({
      providers: { acme: { enabled: true, options: { region: 'ca' } } },
      customProviders: {
        acme: {
          type: 'npm',
          module: 'global-acme',
          executionProfile,
        },
      },
      trustedProviderIds: ['acme'],
      groups: { internal: ['acme'] },
    });
    const project = {
      customProviders: {
        acme: {
          type: 'script' as const,
          command: 'project-acme',
          executionProfile,
        },
      },
    };
    const revoked = migrateConfig({ global, project });
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) {
      expect(revoked.issues).toContainEqual(
        expect.objectContaining({ code: 'config_custom_provider_untrusted' }),
      );
    }

    const result = migrateConfig({
      global,
      project: { ...project, trustedProviderIds: ['acme'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.custom_providers.acme).toMatchObject({
      type: 'script',
      command: 'project-acme',
    });
    expect(result.config.trusted_provider_ids).toEqual(['acme']);
    expect(result.config.groups['custom:internal']).toEqual([
      'acme-provider/search',
    ]);
  });

  it('materializes llm_web_search only into missing chat webSearch options', () => {
    const result = migrateConfig({
      global: v1({
        defaults: {
          outputDir: './agents/librarium',
          maxParallel: 4,
          timeout: 30,
          asyncTimeout: 1800,
          asyncPollInterval: 10,
          mode: 'sync',
          llmWebSearch: false,
        },
        providers: {
          claude: { enabled: true },
          'openrouter-chat': {
            enabled: true,
            options: { webSearch: true },
          },
          exa: { enabled: true },
        },
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.providers.claude?.options).toEqual({
      webSearch: false,
    });
    expect(result.config.providers['openrouter-chat']?.options).toEqual({
      webSearch: true,
    });
    expect(result.config.providers.exa?.options).toBeUndefined();
  });

  it('marks disabled configured fallback targets as reserve-only', () => {
    const result = migrateConfig({
      global: v1({
        providers: {
          exa: { enabled: true, fallback: 'brave-search' },
          'brave-search': { enabled: false },
        },
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reserve_only_adapter_ids).toEqual(['brave-search']);
  });

  it('replaces project provider option bags instead of retaining global keys', () => {
    const result = migrateConfig({
      global: v1({
        providers: {
          'firecrawl-search': {
            enabled: true,
            options: { limit: 10, country: 'CA' },
          },
        },
      }),
      project: {
        providers: {
          'firecrawl-search': { options: { limit: 5 } },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.providers['firecrawl-search']?.options).toEqual({
      limit: 5,
    });
  });

  it('omits disabled-source fallbacks and rejects evidence-incompatible edges', () => {
    const disabled = validateConfigV2(
      v2({
        providers: {
          exa: { enabled: false, fallback: 'brave-search' },
          'brave-search': { enabled: false },
        },
      }),
    );
    expect(disabled.ok).toBe(true);
    if (disabled.ok) {
      expect(disabled.fallback_reserve_adapter_ids).toEqual([]);
      expect(disabled.notices).toContainEqual(
        expect.objectContaining({
          code: 'configuration_fallback_disabled_source_omitted',
        }),
      );
    }

    const incompatible = validateConfigV2(
      v2({
        providers: {
          exa: { enabled: true, fallback: 'brave-answers' },
          'brave-answers': { enabled: false },
        },
      }),
    );
    expect(incompatible.ok).toBe(false);
    if (!incompatible.ok) {
      expect(incompatible.issues).toContainEqual(
        expect.objectContaining({ code: 'config_fallback_incompatible' }),
      );
    }
  });

  it('flattens compatible fallback chains deterministically', () => {
    const result = validateConfigV2(
      v2({
        providers: {
          exa: { enabled: true, fallback: 'brave-search' },
          'brave-search': { enabled: true, fallback: 'tavily' },
          tavily: { enabled: false },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fallback_reserve_adapter_ids).toEqual([
      'brave-search',
      'tavily',
    ]);
    expect(result.reserve_only_adapter_ids).toEqual(['tavily']);
    expect(result.notices).toContainEqual(
      expect.objectContaining({
        code: 'configuration_fallback_chain_flattened',
      }),
    );
  });

  it('rejects unsupported versions and strict unknown fields at exact paths', () => {
    const unsupported = migrateConfig({ global: { version: 3 } });
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) {
      expect(unsupported.issues[0]).toMatchObject({
        code: 'config_version_unsupported',
        path: '/global/version',
      });
    }

    const unknown = migrateConfig({
      global: { ...v1(), surprise: true },
      project: { defaults: { timeout: 10, surprise: true } },
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.issues.map(({ path }) => path)).toEqual([
        '/global',
        '/project/defaults',
      ]);
    }
  });

  it('rejects native v2 bare groups and provider aliases without migrating them', () => {
    const bareGroup = validateConfigV2(
      v2({ groups: { team: ['exa/search'] } }),
    );
    expect(bareGroup.ok).toBe(false);
    const alias = validateConfigV2(
      v2({ providers: { 'perplexity-sonar': { enabled: true } } }),
    );
    expect(alias.ok).toBe(false);
    if (!alias.ok) {
      expect(alias.issues).toContainEqual(
        expect.objectContaining({
          code: 'config_provider_alias_removed',
          path: '/providers/perplexity-sonar',
        }),
      );
    }
  });

  it('normalizes native v2 groups and rejects planned or unknown members', () => {
    const normalized = validateConfigV2(
      v2({
        groups: {
          'custom:team': ['exa/search', 'exa/search', 'brave-search/search'],
        },
      }),
    );
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.config.groups['custom:team']).toEqual([
        'exa/search',
        'brave-search/search',
      ]);
    }

    const rejected = validateConfigV2(
      v2({
        groups: {
          'custom:bad': ['grok-x-only/x', 'missing/search'],
        },
      }),
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.issues.map(({ path }) => path)).toEqual([
        '/groups/custom:bad/0',
        '/groups/custom:bad/1',
      ]);
    }
  });

  it('rejects unsafe custom execution-profile declarations before loading code', () => {
    const missing = validateConfigV2(
      v2({
        providers: { acme: { enabled: true } },
        custom_providers: {
          acme: { type: 'npm', module: 'never-load' },
        },
        trusted_provider_ids: ['acme'],
      }),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.issues).toContainEqual(
        expect.objectContaining({
          code: 'config_custom_execution_profile_required',
        }),
      );
    }

    const reserved = validateConfigV2(
      v2({
        providers: { acme: { enabled: true } },
        custom_providers: { acme: customSource('exa') },
        trusted_provider_ids: ['acme'],
      }),
    );
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) {
      expect(reserved.issues).toContainEqual(
        expect.objectContaining({
          code: 'config_custom_profile_identity_invalid',
        }),
      );
    }

    const processLocal = validateConfigV2(
      v2({
        providers: { acme: { enabled: true } },
        custom_providers: {
          acme: customSource('acme-provider', {
            invocation: 'background',
            resumability: 'process_local',
          }),
        },
        trusted_provider_ids: ['acme'],
      }),
    );
    expect(processLocal.ok).toBe(false);
    if (!processLocal.ok) {
      expect(processLocal.issues).toContainEqual(
        expect.objectContaining({
          code: 'config_custom_process_local_unsupported',
        }),
      );
    }
  });

  it('rejects enabled and fallback custom code that was not explicitly trusted', () => {
    const enabled = validateConfigV2(
      v2({
        providers: { acme: { enabled: true } },
        custom_providers: { acme: customSource('acme-provider') },
      }),
    );
    expect(enabled.ok).toBe(false);
    if (!enabled.ok) {
      expect(enabled.issues).toContainEqual(
        expect.objectContaining({ code: 'config_custom_provider_untrusted' }),
      );
    }

    const fallback = validateConfigV2(
      v2({
        providers: {
          exa: { enabled: true, fallback: 'acme' },
          acme: { enabled: false },
        },
        custom_providers: { acme: customSource('acme-provider') },
      }),
    );
    expect(fallback.ok).toBe(false);
    if (!fallback.ok) {
      expect(fallback.issues).toContainEqual(
        expect.objectContaining({
          code: 'config_fallback_target_untrusted',
        }),
      );
    }
  });

  it('rejects untrusted custom profiles from native and migrated groups', () => {
    const source = customSource('acme-provider');
    const native = validateConfigV2(
      v2({
        providers: { acme: { enabled: false } },
        custom_providers: { acme: source },
        groups: { 'custom:team': ['acme-provider/search'] },
      }),
    );
    expect(native.ok).toBe(false);
    if (!native.ok) {
      expect(native.issues).toContainEqual(
        expect.objectContaining({ code: 'config_group_member_unknown' }),
      );
    }

    const migrated = migrateConfig({
      global: v1({
        providers: { acme: { enabled: false } },
        customProviders: {
          acme: {
            type: 'npm',
            module: source.module,
            executionProfile: {
              bindingId: source.execution_profile.binding_id,
              profile: source.execution_profile.profile,
            },
          },
        },
        groups: { team: ['acme'] },
      }),
    });
    expect(migrated.ok).toBe(false);
    if (!migrated.ok) {
      expect(migrated.issues).toContainEqual(
        expect.objectContaining({ code: 'config_group_member_unknown' }),
      );
    }
  });

  it('rejects inherited and accessor-backed inputs without invoking getters', () => {
    let getterCalls = 0;
    const inherited = Object.create({
      get version() {
        getterCalls += 1;
        return 2;
      },
    });
    const inheritedResult = validateConfigV2(inherited);
    expect(inheritedResult.ok).toBe(false);
    expect(getterCalls).toBe(0);

    const accessor = v2();
    Object.defineProperty(accessor, 'providers', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return {};
      },
    });
    const accessorResult = validateConfigV2(accessor);
    expect(accessorResult.ok).toBe(false);
    expect(getterCalls).toBe(0);

    const wrapper = {} as { global: unknown };
    Object.defineProperty(wrapper, 'global', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return v2();
      },
    });
    const migrationResult = migrateConfig(wrapper);
    expect(migrationResult.ok).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it('rejects whitespace and control characters in persisted group ids', () => {
    for (const name of ['custom: team', 'custom:\nteam']) {
      const native = validateConfigV2(
        v2({ groups: { [name]: ['exa/search'] } }),
      );
      expect(native.ok, name).toBe(false);
    }

    for (const name of [' team', '\nteam']) {
      const migrated = migrateConfig({
        global: v1({
          providers: { exa: { enabled: true } },
          groups: { [name]: ['exa'] },
        }),
      });
      expect(migrated.ok, name).toBe(false);
    }
  });

  it('normalizes llm_web_search identically in validation and migration', () => {
    for (const llmWebSearch of [true, false]) {
      const source = v2({
        providers: { claude: { enabled: true } },
        runtime: {
          output_dir: './agents/librarium',
          llm_web_search: llmWebSearch,
        },
      });
      const validated = validateConfigV2(source);
      const migrated = migrateConfig({ global: source });
      expect(validated.ok, String(llmWebSearch)).toBe(true);
      expect(migrated.ok, String(llmWebSearch)).toBe(true);
      if (!validated.ok || !migrated.ok) continue;
      expect(validated.config).toEqual(migrated.config);
      expect(validated.config.providers.claude?.options).toEqual({
        webSearch: llmWebSearch,
      });
    }
  });

  it('rejects prototype-like JSON dictionary keys before any inherited lookup', () => {
    const source = JSON.parse(JSON.stringify(v1())) as ReturnType<typeof v1>;
    source.providers = JSON.parse(
      '{"__proto__":{"enabled":false},"exa":{"enabled":true}}',
    );
    source.groups = JSON.parse('{"__proto__":["exa"]}');
    source.trustedProviderIds = ['constructor'];
    const result = migrateConfig({ global: source });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'config_dictionary_key_unsafe',
        path: '/global/providers/__proto__',
      }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'config_dictionary_key_unsafe',
        path: '/global/groups/__proto__',
      }),
    );
  });

  it('escapes user-authored keys in semantic JSON Pointer paths', () => {
    const result = migrateConfig({
      global: v1({
        providers: { 'foo~bar': { enabled: false } },
        groups: { 'team/west': ['missing'] },
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'config_provider_unknown',
        path: '/providers/foo~0bar',
      }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'config_group_member_unknown',
        path: '/groups/team~1west/0',
      }),
    );
    expect(result.notices).toContainEqual(
      expect.objectContaining({
        code: 'config_group_migrated',
        path: '/groups/team~1west',
      }),
    );
  });

  it('rejects every retired native alias even when disabled', () => {
    for (const alias of [
      'perplexity-sonar',
      'perplexity-deep',
      'openai-deep',
      'openai-deep-o3',
    ]) {
      const result = validateConfigV2(
        v2({ providers: { [alias]: { enabled: false } } }),
      );
      expect(result.ok, alias).toBe(false);
      if (!result.ok) {
        expect(result.issues).toContainEqual(
          expect.objectContaining({ code: 'config_provider_alias_removed' }),
        );
      }
    }
  });

  it('rejects invalid trust, fallback, built-in options, and model selection', () => {
    const result = validateConfigV2(
      v2({
        providers: {
          exa: {
            enabled: true,
            model: 'not-supported',
            fallback: 'missing',
          },
          'firecrawl-search': {
            enabled: true,
            options: { limit: 0 },
          },
        },
        trusted_provider_ids: ['missing-custom'],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(({ code }) => code)).toEqual([
      'config_fallback_target_unconfigured',
      'config_model_not_configurable',
      'config_provider_options_invalid',
      'config_trusted_provider_missing',
    ]);
  });

  it('rejects non-JSON options and invalid explicit request deadlines', () => {
    const badJson = validateConfigV2(
      v2({
        providers: {
          exa: {
            enabled: true,
            options: { callback: (() => undefined) as unknown as never },
          },
        },
      }),
    );
    expect(badJson.ok).toBe(false);

    const badDeadline = validateConfigV2(
      v2({
        execution_defaults: {
          mode: 'sync',
          max_concurrency: 1,
          inline_attempt_deadline_ms: 20_000,
          background_attempt_deadline_ms: 30_000,
          poll_interval_ms: 1_000,
          request_deadline_ms: 29_999,
        },
      }),
    );
    expect(badDeadline.ok).toBe(false);
  });

  it('is deterministic, pure, and does not mutate either input', () => {
    const global = v1({
      providers: { exa: { enabled: true } },
      groups: { team: ['exa'] },
    });
    const before = structuredClone(global);
    const first = migrateConfig({ global });
    const second = migrateConfig({ global });
    expect(first).toEqual(second);
    expect(global).toEqual(before);
  });
});
