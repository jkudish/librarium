import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GROUPS } from '../src/constants.js';
import {
  hasApiKey,
  loadConfig,
  mergeConfigs,
  resolveEnvVar,
  saveConfig,
  validateFallbacks,
} from '../src/core/config.js';
import { migrateConfig } from '../src/core/config-v2.js';
import { saveConfigV2 } from '../src/node-config-v2.js';
import { type Config, ConfigSchema, type ProjectConfig } from '../src/types.js';

const CUSTOM_EXECUTION_PROFILE = {
  identity: {
    provider_id: 'acme',
    profile_id: 'search',
    target: { primary: { model_selection: 'not_applicable' as const } },
  },
  result_kind: 'search_results' as const,
  observation_mode: 'api_output' as const,
  corpora: ['web' as const],
  retrieval_method: 'search_endpoint' as const,
  access_mode: 'direct' as const,
  operator_id: 'acme',
  invocation: 'inline' as const,
  resumability: 'none' as const,
};

const PRIOR_COMPREHENSIVE = [
  'perplexity-sonar-deep',
  'perplexity-deep-research',
  'openai-research',
  'gemini-deep',
  'perplexity-sonar-pro',
  'gemini-grounded',
  'grok',
  'openrouter-online',
  'brave-answers',
  'exa',
  'you-research',
  'kagi-fastgpt',
] as const;

const PRIOR_ALL = [
  ...PRIOR_COMPREHENSIVE,
  'jina-search',
  'firecrawl-search',
  'perplexity-search',
  'brave-search',
  'searchapi',
  'serpapi',
  'tavily',
] as const;

function storedConfig(groups?: Record<string, readonly string[]>) {
  return {
    version: 1,
    defaults: {
      outputDir: './agents/librarium',
      maxParallel: 6,
      timeout: 30,
      asyncTimeout: 1800,
      asyncPollInterval: 10,
      mode: 'mixed',
      llmWebSearch: true,
    },
    providers: {},
    ...(groups
      ? {
          groups: Object.fromEntries(
            Object.entries(groups).map(([name, members]) => [
              name,
              [...members],
            ]),
          ),
        }
      : {}),
  };
}

describe('resolveEnvVar', () => {
  it('resolves $FOO from process.env', () => {
    process.env.TEST_RESOLVE_VAR = 'my-secret-key';
    expect(resolveEnvVar('$TEST_RESOLVE_VAR')).toBe('my-secret-key');
    delete process.env.TEST_RESOLVE_VAR;
  });

  it('returns raw value for non-$ strings', () => {
    expect(resolveEnvVar('plain-value')).toBe('plain-value');
  });

  it('returns undefined for missing env vars', () => {
    delete process.env.TOTALLY_MISSING_VAR_XYZ;
    expect(resolveEnvVar('$TOTALLY_MISSING_VAR_XYZ')).toBeUndefined();
  });
});

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `librarium-test-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when file does not exist', () => {
    const config = loadConfig(join(tmpDir, 'nonexistent.json'));
    expect(config.version).toBe(1);
    expect(config.defaults.outputDir).toBe('./agents/librarium');
    expect(config.defaults.maxParallel).toBe(6);
    expect(config.defaults.timeout).toBe(30);
    expect(config.defaults.asyncTimeout).toBe(1800);
    expect(config.defaults.asyncPollInterval).toBe(30);
    expect(config.defaults.requestDeadlineMs).toBeUndefined();
    expect(config.defaults.mode).toBe('mixed');
    expect(config.defaults.llmWebSearch).toBe(true);
    expect(config.customProviders).toEqual({});
    expect(config.trustedProviderIds).toEqual([]);
    expect(config.groups).toHaveProperty('deep');
    expect(config.groups).toHaveProperty('quick');
    expect(config.groups).toHaveProperty('all');
  });

  it('parses valid JSON correctly', () => {
    const configPath = join(tmpDir, 'config.json');
    const configData = {
      version: 1,
      defaults: {
        outputDir: './custom-output',
        maxParallel: 4,
        timeout: 60,
        asyncTimeout: 3600,
        asyncPollInterval: 15,
        mode: 'sync',
      },
      providers: {
        'perplexity-sonar-pro': {
          apiKey: '$PERPLEXITY_API_KEY',
          enabled: true,
        },
      },
      groups: {},
    };
    writeFileSync(configPath, JSON.stringify(configData));

    const config = loadConfig(configPath);
    expect(config.defaults.outputDir).toBe('./custom-output');
    expect(config.defaults.maxParallel).toBe(4);
    expect(config.defaults.timeout).toBe(60);
    expect(config.defaults.mode).toBe('sync');
    expect(config.defaults.llmWebSearch).toBe(true);
    expect(config.providers['perplexity-sonar-pro']).toBeDefined();
    expect(config.providers['perplexity-sonar-pro'].enabled).toBe(true);
    // Default groups should be merged in
    expect(config.groups).toHaveProperty('deep');
  });

  it('accepts a saved v1 migration through the normal compatibility loader', () => {
    const source = ConfigSchema.parse({
      ...storedConfig({ team: ['exa', 'acme'] }),
      defaults: {
        outputDir: './custom-output',
        maxParallel: 3,
        timeout: 12,
        asyncTimeout: 90,
        asyncPollInterval: 7,
        mode: 'sync',
        llmWebSearch: false,
        maxCostUsd: 0.25,
        maxEstimatedCostUsd: 0.1,
      },
      providers: {
        exa: { enabled: true, fallback: 'brave-search' },
        'brave-search': { enabled: true },
        'openai-chat': {
          enabled: true,
          apiKey: '$OPENAI_API_KEY',
          model: 'chat-model',
          options: { webSearch: true },
        },
        'gemini-chat': { enabled: true },
        acme: { enabled: true },
      },
      customProviders: {
        acme: {
          type: 'npm',
          module: '@acme/librarium-provider',
          export: 'provider',
          options: { region: 'test' },
          executionProfile: {
            bindingId: 'acme.search.v1',
            profile: CUSTOM_EXECUTION_PROFILE,
            credential: { envVar: 'ACME_API_KEY' },
          },
        },
      },
      trustedProviderIds: ['acme'],
      refine: { provider: 'openai', model: 'refine-model' },
      answer: { provider: 'gemini', model: 'answer-model' },
    });
    const migrated = migrateConfig({ global: source });
    expect(migrated.ok, JSON.stringify(migrated)).toBe(true);
    if (!migrated.ok) return;
    const configPath = join(tmpDir, 'config-v2.json');
    saveConfigV2(migrated.config, { path: configPath });

    const loaded = loadConfig(configPath);

    expect(loaded).toMatchObject({
      version: 1,
      defaults: {
        outputDir: './custom-output',
        mode: 'sync',
        maxParallel: 3,
        timeout: 12,
        asyncTimeout: 90,
        asyncPollInterval: 7,
        llmWebSearch: false,
        maxCostUsd: 0.25,
        maxEstimatedCostUsd: 0.1,
      },
      providers: {
        exa: { enabled: true, fallback: 'brave-search' },
        'brave-search': { enabled: true },
        'openai-chat': {
          enabled: true,
          apiKey: '$OPENAI_API_KEY',
          model: 'chat-model',
          options: { webSearch: true },
        },
        'gemini-chat': { enabled: true },
        acme: { enabled: true },
      },
      customProviders: {
        acme: {
          type: 'npm',
          module: '@acme/librarium-provider',
          export: 'provider',
          options: { region: 'test' },
          executionProfile: {
            bindingId: 'acme.search.v1',
            profile: CUSTOM_EXECUTION_PROFILE,
            credential: { envVar: 'ACME_API_KEY' },
          },
        },
      },
      trustedProviderIds: ['acme'],
      refine: { provider: 'openai', model: 'refine-model' },
      answer: { provider: 'gemini', model: 'answer-model' },
    });
    expect(loaded.groups['custom:team']).toEqual(['exa/search', 'acme/search']);

    expect(() => saveConfig(loaded, configPath)).toThrow(
      'Refusing to overwrite native v2 configuration through the legacy config writer.',
    );
    expect(JSON.parse(readFileSync(configPath, 'utf8')).version).toBe(2);
  });

  it('preserves a native v2 request deadline through the compatibility loader', () => {
    const migrated = migrateConfig({ global: storedConfig() });
    expect(migrated.ok, JSON.stringify(migrated)).toBe(true);
    if (!migrated.ok) return;
    const configPath = join(tmpDir, 'request-deadline-v2.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        ...migrated.config,
        execution_defaults: {
          ...migrated.config.execution_defaults,
          request_deadline_ms: 1_900_000,
        },
      }),
    );

    expect(loadConfig(configPath).defaults.requestDeadlineMs).toBe(1_900_000);
  });

  it('rejects an invalid native v2 request deadline during config loading', () => {
    const migrated = migrateConfig({ global: storedConfig() });
    expect(migrated.ok, JSON.stringify(migrated)).toBe(true);
    if (!migrated.ok) return;
    const configPath = join(tmpDir, 'invalid-request-deadline-v2.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        ...migrated.config,
        execution_defaults: {
          ...migrated.config.execution_defaults,
          request_deadline_ms: 1_799_999,
        },
      }),
    );

    expect(() => loadConfig(configPath)).toThrow(
      /Request deadline cannot be shorter than an attempt deadline/,
    );
  });

  it('refuses native v2 budgets that the compatibility number shape would change', () => {
    const migrated = migrateConfig({ global: storedConfig() });
    expect(migrated.ok, JSON.stringify(migrated)).toBe(true);
    if (!migrated.ok) return;
    const configPath = join(tmpDir, 'inexact-budget-v2.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        ...migrated.config,
        execution_defaults: {
          ...migrated.config.execution_defaults,
          max_actual_cost_microusd: '9007199254740991',
        },
      }),
    );

    expect(() => loadConfig(configPath)).toThrow(
      'cannot be represented exactly by the compatibility CLI',
    );
  });

  it('migrates legacy provider IDs in providers, groups, and fallbacks', () => {
    const configPath = join(tmpDir, 'config.json');
    const configData = {
      version: 1,
      defaults: {
        outputDir: './custom-output',
        maxParallel: 4,
        timeout: 60,
        asyncTimeout: 3600,
        asyncPollInterval: 15,
        mode: 'sync',
      },
      providers: {
        'perplexity-sonar': {
          apiKey: '$PERPLEXITY_API_KEY',
          enabled: true,
          fallback: 'perplexity-deep',
        },
        'perplexity-deep': {
          apiKey: '$PERPLEXITY_API_KEY',
          enabled: false,
        },
      },
      groups: {
        legacy: ['perplexity-sonar', 'perplexity-deep', 'perplexity-sonar-pro'],
      },
    };
    writeFileSync(configPath, JSON.stringify(configData));

    const config = loadConfig(configPath);
    expect(config.providers['perplexity-sonar']).toBeUndefined();
    expect(config.providers['perplexity-deep']).toBeUndefined();
    expect(config.providers['perplexity-sonar-pro']).toBeDefined();
    expect(config.providers['perplexity-sonar-deep']).toBeDefined();
    expect(config.providers['perplexity-sonar-pro'].fallback).toBe(
      'perplexity-sonar-deep',
    );
    expect(config.groups.legacy).toEqual([
      'perplexity-sonar-pro',
      'perplexity-sonar-deep',
    ]);
  });

  it('normalizes retired v1 fallback ids without restoring active aliases', () => {
    const configPath = join(tmpDir, 'retired-fallbacks.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        defaults: {
          outputDir: './agents/librarium',
          maxParallel: 1,
          timeout: 30,
          asyncTimeout: 1800,
          asyncPollInterval: 10,
          mode: 'sync',
        },
        providers: {
          'openai-deep': {
            enabled: true,
            fallback: 'openai-deep-o3',
          },
          'perplexity-sonar': {
            enabled: true,
            fallback: 'perplexity-deep',
          },
        },
        groups: {},
      }),
    );

    const config = loadConfig(configPath);
    expect(config.providers['openai-research']?.fallback).toBe(
      'openai-research',
    );
    expect(config.providers['perplexity-sonar-pro']?.fallback).toBe(
      'perplexity-sonar-deep',
    );
    for (const retired of [
      'perplexity-sonar',
      'perplexity-deep',
      'openai-deep',
      'openai-deep-o3',
    ]) {
      expect(config.providers[retired]).toBeUndefined();
    }
  });

  it('migrates retired Perplexity identities with canonical collision precedence', () => {
    const configPath = join(tmpDir, 'perplexity-collisions.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        defaults: {
          outputDir: './agents/librarium',
          maxParallel: 1,
          timeout: 30,
          asyncTimeout: 1800,
          asyncPollInterval: 10,
          mode: 'sync',
        },
        providers: {
          'perplexity-pro-search': {
            enabled: false,
            apiKey: '$LEGACY_PERPLEXITY_API_KEY',
            fallback: 'perplexity-pro-search',
          },
          'perplexity-sonar-pro': {
            enabled: true,
            apiKey: '$PERPLEXITY_API_KEY',
          },
          'perplexity-advanced-deep': { enabled: false },
          'perplexity-sonar-deep': { enabled: true },
        },
        groups: {
          legacy: [
            'perplexity-pro-search/grounded',
            'perplexity-sonar-pro/grounded',
            'perplexity-advanced-deep/research',
          ],
        },
      }),
    );

    const config = loadConfig(configPath);
    expect(config.providers['perplexity-sonar-pro']).toMatchObject({
      enabled: true,
      apiKey: '$PERPLEXITY_API_KEY',
    });
    expect(config.providers['perplexity-sonar-deep']).toEqual({
      enabled: true,
    });
    expect(config.providers['perplexity-pro-search']).toBeUndefined();
    expect(config.providers['perplexity-advanced-deep']).toBeUndefined();
    expect(config.groups.legacy).toEqual([
      'perplexity-sonar-pro/grounded',
      'perplexity-sonar-deep/research',
    ]);
  });

  it('migrates only exact stored prior comprehensive and all rosters', () => {
    const configPath = join(tmpDir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify(
        storedConfig({
          comprehensive: PRIOR_COMPREHENSIVE,
          all: PRIOR_ALL,
        }),
      ),
    );

    const config = loadConfig(configPath);
    expect(config.groups.comprehensive).toEqual(DEFAULT_GROUPS.comprehensive);
    expect(config.groups.all).toEqual(DEFAULT_GROUPS.all);
  });

  it('preserves reordered and added/removed stored rosters', () => {
    const cases: Array<[string, 'comprehensive' | 'all', string[]]> = [
      [
        'reordered comprehensive',
        'comprehensive',
        [
          PRIOR_COMPREHENSIVE[1],
          PRIOR_COMPREHENSIVE[0],
          ...PRIOR_COMPREHENSIVE.slice(2),
        ],
      ],
      [
        'reordered all',
        'all',
        [PRIOR_ALL[1], PRIOR_ALL[0], ...PRIOR_ALL.slice(2)],
      ],
      [
        'added comprehensive',
        'comprehensive',
        [...PRIOR_COMPREHENSIVE, 'custom-provider'],
      ],
      [
        'removed comprehensive',
        'comprehensive',
        PRIOR_COMPREHENSIVE.slice(0, -1),
      ],
      ['added all', 'all', [...PRIOR_ALL, 'custom-provider']],
      ['removed all', 'all', PRIOR_ALL.slice(0, -1)],
    ];

    for (const [name, group, roster] of cases) {
      const configPath = join(tmpDir, `${name.replaceAll(' ', '-')}.json`);
      writeFileSync(
        configPath,
        JSON.stringify(storedConfig({ [group]: roster })),
      );
      expect(loadConfig(configPath).groups[group], name).toEqual(roster);
    }
  });

  it('does not let an added alias duplicate collapse into a migratable snapshot', () => {
    const configPath = join(tmpDir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify(
        storedConfig({
          comprehensive: [...PRIOR_COMPREHENSIVE, 'openai-deep'],
        }),
      ),
    );

    expect(loadConfig(configPath).groups.comprehensive).toEqual(
      DEFAULT_GROUPS.comprehensive,
    );
  });

  it('uses current defaults when comprehensive/all are absent', () => {
    const configPath = join(tmpDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(storedConfig()));

    const config = loadConfig(configPath);
    expect(config.groups.comprehensive).toEqual(DEFAULT_GROUPS.comprehensive);
    expect(config.groups.all).toEqual(DEFAULT_GROUPS.all);
  });

  it('never applies the global roster migration to project groups', () => {
    const configPath = join(tmpDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(storedConfig()));

    const merged = mergeConfigs(loadConfig(configPath), {
      groups: {
        comprehensive: [...PRIOR_COMPREHENSIVE],
        all: [...PRIOR_ALL],
      },
    });
    expect(merged.groups.comprehensive).toEqual(PRIOR_COMPREHENSIVE);
    expect(merged.groups.all).toEqual(PRIOR_ALL);
  });

  it('leaves already migrated rosters unchanged and is idempotent on rerun', () => {
    const configPath = join(tmpDir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify(
        storedConfig({
          comprehensive: DEFAULT_GROUPS.comprehensive,
          all: DEFAULT_GROUPS.all,
        }),
      ),
    );

    const first = loadConfig(configPath);
    const second = loadConfig(configPath);
    expect(first.groups.comprehensive).toEqual(DEFAULT_GROUPS.comprehensive);
    expect(first.groups.all).toEqual(DEFAULT_GROUPS.all);
    expect(second.groups).toEqual(first.groups);
  });

  it('canonicalizes recognized historical aliases before snapshot matching', () => {
    for (const openAiAlias of ['openai-deep', 'openai-deep-o3']) {
      const configPath = join(tmpDir, `${openAiAlias}.json`);
      const withHistoricalAliases = (members: readonly string[]) =>
        members.map((id) => {
          if (id === 'openai-research') return openAiAlias;
          if (id === 'perplexity-sonar-deep') return 'perplexity-deep';
          if (id === 'perplexity-sonar-pro') return 'perplexity-sonar';
          return id;
        });
      writeFileSync(
        configPath,
        JSON.stringify(
          storedConfig({
            comprehensive: withHistoricalAliases(PRIOR_COMPREHENSIVE),
            all: withHistoricalAliases(PRIOR_ALL),
          }),
        ),
      );

      const config = loadConfig(configPath);
      expect(config.groups.comprehensive).toEqual(DEFAULT_GROUPS.comprehensive);
      expect(config.groups.all).toEqual(DEFAULT_GROUPS.all);
    }
  });
});

describe('custom-provider execution profile config', () => {
  it.each(['exa-research', 'tavily-research', 'you-research-background'])(
    'rejects private provider config key %s',
    (id) => {
      expect(
        ConfigSchema.safeParse({
          ...storedConfig(),
          providers: { [id]: { enabled: true } },
        }).success,
      ).toBe(false);
    },
  );

  it.each(['exa-research', 'tavily-research', 'you-research-background'])(
    'rejects private custom-provider and trust key %s',
    (id) => {
      expect(
        ConfigSchema.safeParse({
          ...storedConfig(),
          customProviders: {
            [id]: { type: 'npm', module: 'malicious' },
          },
          trustedProviderIds: [id],
        }).success,
      ).toBe(false);
    },
  );

  it('validates the strict canonical profile and credential declaration', () => {
    const parsed = ConfigSchema.safeParse({
      ...storedConfig(),
      customProviders: {
        acme: {
          type: 'npm',
          module: 'acme-provider',
          executionProfile: {
            bindingId: 'acme.search.v1',
            profile: CUSTOM_EXECUTION_PROFILE,
            credential: { envVar: 'ACME_API_KEY' },
          },
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects malformed metadata even when the provider is untrusted', () => {
    const unknownProfileField = ConfigSchema.safeParse({
      ...storedConfig(),
      customProviders: {
        acme: {
          type: 'npm',
          module: 'acme-provider',
          executionProfile: {
            bindingId: 'acme.search.v1',
            profile: { ...CUSTOM_EXECUTION_PROFILE, unexpected: true },
          },
        },
      },
    });
    const invalidEnv = ConfigSchema.safeParse({
      ...storedConfig(),
      customProviders: {
        acme: {
          type: 'npm',
          module: 'acme-provider',
          executionProfile: {
            bindingId: 'acme.search.v1',
            profile: CUSTOM_EXECUTION_PROFILE,
            credential: { envVar: 'not-valid!' },
          },
        },
      },
    });
    const invalidBinding = ConfigSchema.safeParse({
      ...storedConfig(),
      customProviders: {
        acme: {
          type: 'npm',
          module: 'acme-provider',
          executionProfile: {
            bindingId: ' invalid ',
            profile: CUSTOM_EXECUTION_PROFILE,
          },
        },
      },
    });
    expect(unknownProfileField.success).toBe(false);
    expect(invalidEnv.success).toBe(false);
    expect(invalidBinding.success).toBe(false);
  });
});

describe('mergeConfigs', () => {
  const baseGlobal: Config = {
    version: 1,
    defaults: {
      outputDir: './agents/librarium',
      maxParallel: 6,
      timeout: 30,
      asyncTimeout: 1800,
      asyncPollInterval: 10,
      mode: 'mixed',
      llmWebSearch: true,
    },
    providers: {
      'perplexity-sonar-pro': {
        apiKey: '$PERPLEXITY_API_KEY',
        enabled: true,
      },
    },
    customProviders: {},
    trustedProviderIds: [],
    groups: {
      deep: ['perplexity-sonar-deep', 'openai-research', 'gemini-deep'],
      quick: ['perplexity-sonar-pro', 'brave-answers', 'exa'],
    },
  };

  it('returns global config when no project or CLI flags', () => {
    const merged = mergeConfigs(baseGlobal, null);
    expect(merged.defaults.outputDir).toBe('./agents/librarium');
    expect(merged.defaults.maxParallel).toBe(6);
    expect(merged.defaults.mode).toBe('mixed');
    expect(merged.providers['perplexity-sonar-pro']).toBeDefined();
  });

  it('collapses retired OpenAI ids deterministically', () => {
    const merged = mergeConfigs(
      {
        ...baseGlobal,
        providers: {
          'openai-deep': { apiKey: '$OLD', enabled: true, model: 'old' },
          'openai-deep-o3': { apiKey: '$O3', enabled: true, model: 'o3' },
          'openai-research': {
            apiKey: '$CANONICAL',
            enabled: true,
            model: 'canonical',
          },
        },
        groups: { deep: ['openai-deep', 'openai-deep-o3', 'openai-research'] },
      },
      null,
    );
    expect(merged.providers['openai-research']?.model).toBe('canonical');
    expect(merged.groups.deep).toEqual(['openai-research']);
  });

  it('prefers the former o3 config when no canonical OpenAI config exists', () => {
    const merged = mergeConfigs(
      {
        ...baseGlobal,
        providers: {
          'openai-deep': { apiKey: '$OLD', enabled: true, model: 'old' },
          'openai-deep-o3': { apiKey: '$O3', enabled: true, model: 'o3' },
        },
      },
      null,
    );
    expect(merged.providers['openai-research']?.model).toBe('o3');
  });

  it('lets either project legacy alias override canonical global OpenAI config', () => {
    for (const legacyId of ['openai-deep', 'openai-deep-o3']) {
      const merged = mergeConfigs(
        {
          ...baseGlobal,
          providers: {
            'openai-research': {
              apiKey: '$GLOBAL_OPENAI_KEY',
              enabled: false,
              model: 'global-model',
              options: { reasoningEffort: 'low' },
            },
          },
        },
        {
          providers: {
            [legacyId]: {
              apiKey: '$PROJECT_OPENAI_KEY',
              enabled: true,
              model: 'project-model',
              options: { reasoningEffort: 'xhigh', maxToolCalls: 12 },
            },
          },
        },
      );

      expect(merged.providers['openai-research']).toEqual({
        apiKey: '$PROJECT_OPENAI_KEY',
        enabled: true,
        model: 'project-model',
        options: { reasoningEffort: 'xhigh', maxToolCalls: 12 },
        fallback: undefined,
      });
      expect(merged.providers[legacyId]).toBeUndefined();
    }
  });

  it('does not re-enable a globally disabled provider when a project alias omits enabled', () => {
    for (const legacyId of ['openai-deep', 'openai-deep-o3']) {
      const merged = mergeConfigs(
        {
          ...baseGlobal,
          providers: {
            'openai-research': {
              apiKey: '$GLOBAL_OPENAI_KEY',
              enabled: false,
              model: 'global-model',
            },
          },
        },
        {
          providers: {
            [legacyId]: {
              model: 'project-model',
              options: { reasoningEffort: 'xhigh' },
            },
          },
        },
      );

      expect(merged.providers['openai-research']).toMatchObject({
        apiKey: '$GLOBAL_OPENAI_KEY',
        enabled: false,
        model: 'project-model',
        options: { reasoningEffort: 'xhigh' },
      });
    }
  });

  it('applies project overrides', () => {
    const project: ProjectConfig = {
      defaults: {
        outputDir: './research',
        timeout: 60,
      },
    };
    const merged = mergeConfigs(baseGlobal, project);
    expect(merged.defaults.outputDir).toBe('./research');
    expect(merged.defaults.timeout).toBe(60);
    // Non-overridden fields preserved
    expect(merged.defaults.maxParallel).toBe(6);
    expect(merged.defaults.mode).toBe('mixed');
  });

  it('deep-merges project provider overrides', () => {
    const project: ProjectConfig = {
      providers: {
        'perplexity-sonar-pro': {
          enabled: false,
        },
        'custom-provider': {
          enabled: true,
          apiKey: '$CUSTOM_PROVIDER_KEY',
        },
      },
    };

    const merged = mergeConfigs(baseGlobal, project);
    expect(merged.providers['perplexity-sonar-pro'].apiKey).toBe(
      '$PERPLEXITY_API_KEY',
    );
    expect(merged.providers['perplexity-sonar-pro'].enabled).toBe(false);
    expect(merged.providers['custom-provider'].enabled).toBe(true);
    expect(merged.providers['custom-provider'].apiKey).toBe(
      '$CUSTOM_PROVIDER_KEY',
    );
  });

  it('merges custom providers and trusted provider IDs', () => {
    const globalWithCustom: Config = {
      ...baseGlobal,
      customProviders: {
        'my-custom': {
          type: 'script',
          command: 'node',
          args: ['./global-provider.js'],
        },
      },
      trustedProviderIds: ['my-custom'],
    };
    const project: ProjectConfig = {
      customProviders: {
        'my-custom': {
          type: 'script',
          command: 'node',
          args: ['./project-provider.js'],
        },
        'my-custom-2': {
          type: 'npm',
          module: 'librarium-custom-provider',
        },
      },
      trustedProviderIds: ['my-custom', 'my-custom-2'],
    };

    const merged = mergeConfigs(globalWithCustom, project);
    expect(merged.customProviders['my-custom']).toEqual({
      type: 'script',
      command: 'node',
      args: ['./project-provider.js'],
    });
    expect(merged.customProviders['my-custom-2']).toEqual({
      type: 'npm',
      module: 'librarium-custom-provider',
    });
    expect(merged.trustedProviderIds).toEqual(['my-custom', 'my-custom-2']);
  });

  it('drops inherited trust when a project overrides a custom provider', () => {
    const merged = mergeConfigs(
      {
        ...baseGlobal,
        customProviders: {
          overridden: {
            type: 'npm',
            module: 'global-provider',
            executionProfile: {
              bindingId: 'global.v1',
              profile: CUSTOM_EXECUTION_PROFILE,
            },
          },
        },
        trustedProviderIds: ['overridden'],
      },
      {
        customProviders: {
          overridden: {
            type: 'npm',
            module: 'project-provider',
            executionProfile: {
              bindingId: 'project.v1',
              profile: CUSTOM_EXECUTION_PROFILE,
            },
          },
        },
      },
    );

    expect(merged.trustedProviderIds).toEqual([]);
    expect(merged.customProviders.overridden?.executionProfile?.bindingId).toBe(
      'project.v1',
    );
  });

  it('keeps a project override trusted when the project explicitly trusts it', () => {
    const merged = mergeConfigs(
      {
        ...baseGlobal,
        customProviders: {
          overridden: { type: 'npm', module: 'global-provider' },
        },
        trustedProviderIds: ['overridden'],
      },
      {
        customProviders: {
          overridden: { type: 'npm', module: 'project-provider' },
        },
        trustedProviderIds: ['overridden'],
      },
    );

    expect(merged.trustedProviderIds).toEqual(['overridden']);
  });

  it('retains trust for unrelated global custom providers', () => {
    const merged = mergeConfigs(
      {
        ...baseGlobal,
        customProviders: {
          overridden: { type: 'npm', module: 'global-provider' },
          retained: { type: 'npm', module: 'retained-provider' },
        },
        trustedProviderIds: ['overridden', 'retained'],
      },
      {
        customProviders: {
          overridden: { type: 'npm', module: 'project-provider' },
          'project-only': { type: 'npm', module: 'project-only-provider' },
        },
      },
    );

    expect(merged.trustedProviderIds).toEqual(['retained']);
  });

  it('applies CLI flags', () => {
    const merged = mergeConfigs(baseGlobal, null, {
      timeout: 120,
      mode: 'sync',
    });
    expect(merged.defaults.timeout).toBe(120);
    expect(merged.defaults.mode).toBe('sync');
    expect(merged.defaults.maxParallel).toBe(6);
  });

  it('applies full 3-layer merge (global -> project -> CLI)', () => {
    const project: ProjectConfig = {
      defaults: {
        outputDir: './research',
        timeout: 60,
        requestDeadlineMs: 2_000_000,
      },
    };
    const merged = mergeConfigs(baseGlobal, project, {
      timeout: 120,
      requestDeadlineMs: 2_500_000,
    });
    // CLI overrides project
    expect(merged.defaults.timeout).toBe(120);
    // Project overrides global
    expect(merged.defaults.outputDir).toBe('./research');
    expect(merged.defaults.requestDeadlineMs).toBe(2_500_000);
    // Global defaults preserved
    expect(merged.defaults.maxParallel).toBe(6);
    expect(merged.defaults.mode).toBe('mixed');
  });
});

describe('hasApiKey', () => {
  it('returns true for valid env var reference', () => {
    process.env.TEST_HAS_KEY = 'sk-test-123';
    expect(hasApiKey('$TEST_HAS_KEY')).toBe(true);
    delete process.env.TEST_HAS_KEY;
  });

  it('returns false for missing env var reference', () => {
    delete process.env.TEST_MISSING_KEY_XYZ;
    expect(hasApiKey('$TEST_MISSING_KEY_XYZ')).toBe(false);
  });

  it('returns false for empty env var', () => {
    process.env.TEST_EMPTY_KEY = '';
    expect(hasApiKey('$TEST_EMPTY_KEY')).toBe(false);
    delete process.env.TEST_EMPTY_KEY;
  });

  it('returns true for non-$ string (treated as literal key)', () => {
    expect(hasApiKey('literal-api-key')).toBe(true);
  });
});

describe('validateFallbacks', () => {
  const makeConfig = (
    providers: Record<
      string,
      { apiKey: string; enabled: boolean; fallback?: string }
    >,
  ): Config => ({
    version: 1,
    defaults: {
      outputDir: './agents/librarium',
      maxParallel: 6,
      timeout: 30,
      asyncTimeout: 1800,
      asyncPollInterval: 10,
      mode: 'mixed',
      llmWebSearch: true,
    },
    providers,
    customProviders: {},
    trustedProviderIds: [],
    groups: {},
  });

  it('returns no warnings for valid fallback reference', () => {
    const config = makeConfig({
      'gemini-deep': {
        apiKey: '$GEMINI_API_KEY',
        enabled: true,
        fallback: 'gemini-flash',
      },
      'gemini-flash': {
        apiKey: '$GEMINI_API_KEY',
        enabled: false,
      },
    });
    expect(validateFallbacks(config)).toEqual([]);
  });

  it('warns on unknown fallback provider', () => {
    const config = makeConfig({
      'gemini-deep': {
        apiKey: '$GEMINI_API_KEY',
        enabled: true,
        fallback: 'nonexistent-provider',
      },
    });
    const warnings = validateFallbacks(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('unknown fallback provider');
    expect(warnings[0]).toContain('nonexistent-provider');
  });

  it('warns on self-referencing fallback', () => {
    const config = makeConfig({
      'gemini-deep': {
        apiKey: '$GEMINI_API_KEY',
        enabled: true,
        fallback: 'gemini-deep',
      },
    });
    const warnings = validateFallbacks(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('self-referencing fallback');
  });

  it('warns on fallback chain', () => {
    const config = makeConfig({
      'gemini-deep': {
        apiKey: '$GEMINI_API_KEY',
        enabled: true,
        fallback: 'gemini-flash',
      },
      'gemini-flash': {
        apiKey: '$GEMINI_API_KEY',
        enabled: false,
        fallback: 'perplexity-sonar-pro',
      },
      'perplexity-sonar-pro': {
        apiKey: '$PERPLEXITY_API_KEY',
        enabled: true,
      },
    });
    const warnings = validateFallbacks(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('only single-level fallback is supported');
  });

  it('returns no warnings when no fallbacks are configured', () => {
    const config = makeConfig({
      'perplexity-sonar-pro': {
        apiKey: '$PERPLEXITY_API_KEY',
        enabled: true,
      },
    });
    expect(validateFallbacks(config)).toEqual([]);
  });
});
