import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  CONFIG_FILE_MODE,
  DEFAULT_GROUPS,
  PROJECT_CONFIG_FILE,
  resolveProviderId,
} from '../constants.js';
import type { Config, Defaults, ProjectConfig } from '../types.js';
import { ConfigSchema, ProjectConfigSchema } from '../types.js';
import { validateConfigV2 } from './config-v2.js';
import type { EnvRecord } from './credentials.js';
import { hasCredential, resolveCredential } from './credentials.js';
import { safeWriteFile } from './fs-utils.js';
import {
  migrateRetiredProviderId,
  migrateRetiredProviderToken,
  retiredProviderGuidance,
  retiredProviderMigrationPriority,
} from './retired-provider-ids.js';

export const CONFIG_DIR = resolve(homedir(), '.config', 'librarium');
export const CONFIG_FILE = resolve(CONFIG_DIR, 'config.json');

/**
 * Only authored groups are meaningful to the v2 catalog. `loadConfig` still
 * injects DEFAULT_GROUPS for legacy config compatibility, so retain the two
 * authored layers out-of-band instead of making injected defaults look like
 * custom user workflows.
 */
export interface ConfigGroupProvenance {
  readonly global: Readonly<Record<string, readonly string[]>>;
  readonly project: Readonly<Record<string, readonly string[]>>;
}

const groupProvenanceByConfig = new WeakMap<Config, ConfigGroupProvenance>();

function cloneGroups(
  groups: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(groups).map(([name, members]) => [name, [...members]]),
  );
}

function setConfigGroupProvenance(
  config: Config,
  provenance: ConfigGroupProvenance,
): Config {
  groupProvenanceByConfig.set(config, {
    global: cloneGroups(provenance.global),
    project: cloneGroups(provenance.project),
  });
  return config;
}

/**
 * Returns authored global/project group layers for a config loaded or merged
 * by this module. Hand-built Config values are treated as authored global
 * config, which keeps this helper useful in library callers and tests.
 */
export function configGroupProvenance(config: Config): ConfigGroupProvenance {
  const known = groupProvenanceByConfig.get(config);
  return known ?? { global: config.groups, project: {} };
}

const DEFAULT_CONFIG: Config = {
  version: 1,
  defaults: {
    outputDir: './agents/librarium',
    maxParallel: 6,
    timeout: 30,
    asyncTimeout: 1800,
    asyncPollInterval: 30,
    mode: 'sync',
    llmWebSearch: true,
  },
  providers: {},
  customProviders: {},
  trustedProviderIds: [],
  groups: { ...DEFAULT_GROUPS },
};

function exactMicrousdToUsd(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const microusd = BigInt(value);
  if (microusd > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      'Native v2 cost limits exceed the compatibility CLI numeric range.',
    );
  }
  const usd = Number(microusd) / 1_000_000;
  const [whole, fraction = ''] = String(usd).split('.');
  if (
    fraction.length > 6 ||
    whole.includes('e') ||
    whole.includes('E') ||
    BigInt(`${whole}${fraction.padEnd(6, '0')}`) !== microusd
  ) {
    throw new Error(
      'Native v2 cost limits cannot be represented exactly by the compatibility CLI.',
    );
  }
  return usd;
}

function compatibilityConfigFromV2(raw: unknown, path: string): Config {
  const validated = validateConfigV2(raw);
  if (!validated.ok) {
    const diagnostics = validated.issues
      .map(
        ({ code, path: issuePath, message }) =>
          `${code} ${issuePath}: ${message}`,
      )
      .join('; ');
    throw new Error(`Invalid Librarium v2 config in ${path}: ${diagnostics}`);
  }
  const native = validated.config;
  return ConfigSchema.parse({
    version: 1,
    defaults: {
      outputDir: native.runtime.output_dir,
      maxParallel: native.execution_defaults.max_concurrency,
      timeout: native.execution_defaults.inline_attempt_deadline_ms / 1_000,
      asyncTimeout:
        native.execution_defaults.background_attempt_deadline_ms / 1_000,
      asyncPollInterval: native.execution_defaults.poll_interval_ms / 1_000,
      ...(native.execution_defaults.request_deadline_ms !== undefined && {
        requestDeadlineMs: native.execution_defaults.request_deadline_ms,
      }),
      mode: native.execution_defaults.mode,
      llmWebSearch: native.runtime.llm_web_search,
      ...(native.execution_defaults.max_actual_cost_microusd !== undefined && {
        maxCostUsd: exactMicrousdToUsd(
          native.execution_defaults.max_actual_cost_microusd,
        ),
      }),
      ...(native.execution_defaults.max_estimated_cost_microusd !==
        undefined && {
        maxEstimatedCostUsd: exactMicrousdToUsd(
          native.execution_defaults.max_estimated_cost_microusd,
        ),
      }),
    },
    providers: Object.fromEntries(
      Object.entries(native.providers).map(([id, provider]) => [
        id,
        {
          enabled: provider.enabled,
          ...(provider.api_key !== undefined && { apiKey: provider.api_key }),
          ...(provider.model !== undefined && { model: provider.model }),
          ...(provider.options !== undefined && { options: provider.options }),
          ...(provider.fallback !== undefined && {
            fallback: provider.fallback,
          }),
        },
      ]),
    ),
    customProviders: Object.fromEntries(
      Object.entries(native.custom_providers).map(([id, source]) => {
        const { execution_profile: executionProfile, ...rest } = source;
        return [
          id,
          {
            ...rest,
            ...(executionProfile !== undefined && {
              executionProfile: {
                bindingId: executionProfile.binding_id,
                profile: executionProfile.profile,
                ...(executionProfile.credential !== undefined && {
                  credential: {
                    envVar: executionProfile.credential.env_var,
                  },
                }),
              },
            }),
          },
        ];
      }),
    ),
    trustedProviderIds: native.trusted_provider_ids,
    groups: native.groups,
    ...(native.runtime.refine !== undefined && {
      refine: native.runtime.refine,
    }),
    ...(native.runtime.answer !== undefined && {
      answer: native.runtime.answer,
    }),
  });
}

/**
 * Resolve $ENV_VAR references in a string.
 * Returns the resolved value or undefined if the env var is not set.
 */
export function resolveEnvVar(
  value: string,
  env: EnvRecord = process.env,
): string | undefined {
  return resolveCredential(value, { env });
}

/**
 * Validate fallback references in provider config.
 * Returns an array of warning messages (non-fatal).
 */
export function validateFallbacks(config: Config): string[] {
  const warnings: string[] = [];
  const providerIds = Object.keys(config.providers);
  for (const [id, providerConfig] of Object.entries(config.providers)) {
    const fallbackId = providerConfig.fallback;
    if (!fallbackId) continue;

    if (fallbackId === id) {
      warnings.push(`Provider "${id}" has a self-referencing fallback`);
      continue;
    }

    if (!providerIds.includes(fallbackId)) {
      warnings.push(
        `Provider "${id}" references unknown fallback provider "${fallbackId}"`,
      );
      continue;
    }

    // Check for chains (fallback's fallback)
    const fallbackConfig = config.providers[fallbackId];
    if (fallbackConfig?.fallback) {
      warnings.push(
        `Provider "${id}" → "${fallbackId}" → "${fallbackConfig.fallback}": only single-level fallback is supported, chain will be ignored`,
      );
    }
  }

  return warnings;
}

/**
 * Load global config from ~/.config/librarium/config.json
 */
export function loadConfig(globalPath?: string): Config {
  const path = globalPath ?? CONFIG_FILE;
  if (!existsSync(path))
    return setConfigGroupProvenance(
      {
        ...DEFAULT_CONFIG,
        providers: {},
        customProviders: {},
        trustedProviderIds: [],
        groups: { ...DEFAULT_GROUPS },
      },
      { global: {}, project: {} },
    );

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    throw new Error(
      `Invalid JSON in ${path}: ${e instanceof Error ? e.message : e}`,
    );
  }
  const config =
    typeof raw === 'object' &&
    raw !== null &&
    Object.hasOwn(raw, 'version') &&
    (raw as { version?: unknown }).version === 2
      ? compatibilityConfigFromV2(raw, path)
      : ConfigSchema.parse(raw);
  // Keep the authored spelling for the pure v2 mapper. v1 still mutates
  // config.groups below, but doing that here would erase alias provenance
  // before the mapper can issue its structured migration diagnostic.
  const explicitGlobalGroups = cloneGroups(config.groups);
  const storedDefaultGroupRosters = captureStoredDefaultGroupRosters(
    config.groups,
  );
  const migrationWarnings = migrateLegacyProviderIds(config);
  const migratedDefaultGroups = migratePriorCanonicalDefaultGroups(
    config,
    storedDefaultGroupRosters,
  );
  // The two exact historical shipped rosters are a narrow exception: preserve
  // their approved replacement rather than making the retired roster a custom
  // group in v2. No other authored member is rewritten in provenance.
  for (const name of migratedDefaultGroups) {
    explicitGlobalGroups[name] = [...(config.groups[name] ?? [])];
  }
  // Merge defaults only after inspecting explicitly stored global groups.
  // User groups, including customized comprehensive/all rosters, win.
  config.groups = { ...DEFAULT_GROUPS, ...config.groups };

  // Validate fallback references (non-fatal warnings)
  for (const warning of migrationWarnings) {
    console.error(`[librarium] warning: ${warning}`);
  }
  const warnings = validateFallbacks(config);
  for (const warning of warnings) {
    console.error(`[librarium] warning: ${warning}`);
  }

  return setConfigGroupProvenance(config, {
    global: explicitGlobalGroups,
    project: {},
  });
}

/**
 * Load project-level config from .librarium.json in the current directory
 */
export function loadProjectConfig(cwd: string): ProjectConfig | null {
  const path = resolve(cwd, PROJECT_CONFIG_FILE);
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    throw new Error(
      `Invalid JSON in ${path}: ${e instanceof Error ? e.message : e}`,
    );
  }
  return ProjectConfigSchema.parse(raw);
}

/**
 * Merge global -> project -> CLI flags (each layer overrides previous)
 */
export function mergeConfigs(
  global: Config,
  project: ProjectConfig | null,
  cliFlags?: Partial<Defaults>,
): Config {
  const merged: Config = {
    version: 1,
    defaults: { ...global.defaults },
    providers: { ...global.providers },
    customProviders: { ...global.customProviders },
    trustedProviderIds: [...global.trustedProviderIds],
    groups: { ...global.groups },
    refine: global.refine ? { ...global.refine } : undefined,
    answer: global.answer ? { ...global.answer } : undefined,
  };

  if (project?.defaults) {
    merged.defaults = {
      ...merged.defaults,
      ...stripUndefined(project.defaults),
    };
  }

  if (project?.providers) {
    merged.providers = mergeProviderConfigs(
      merged.providers,
      normalizeProjectProviderConfigs(project.providers),
    );
  }

  if (project?.customProviders) {
    // A project definition replaces the global code associated with the same
    // ID, so it must receive its own explicit trust decision. Keep trust for
    // global providers the project did not replace.
    const overriddenProviderIds = new Set(Object.keys(project.customProviders));
    merged.trustedProviderIds = merged.trustedProviderIds.filter(
      (providerId) => !overriddenProviderIds.has(providerId),
    );
    merged.customProviders = {
      ...merged.customProviders,
      ...project.customProviders,
    };
  }

  if (project?.trustedProviderIds) {
    merged.trustedProviderIds = Array.from(
      new Set([...merged.trustedProviderIds, ...project.trustedProviderIds]),
    );
  }

  if (project?.groups) {
    merged.groups = { ...merged.groups, ...project.groups };
  }

  if (project?.refine) {
    merged.refine = { ...merged.refine, ...stripUndefined(project.refine) };
  }

  if (project?.answer) {
    merged.answer = { ...merged.answer, ...stripUndefined(project.answer) };
  }

  if (cliFlags) {
    merged.defaults = { ...merged.defaults, ...stripUndefined(cliFlags) };
  }

  migrateLegacyProviderIds(merged);

  const globalGroups = configGroupProvenance(global).global;
  const projectGroups = project?.groups ?? {};
  setConfigGroupProvenance(merged, {
    global: globalGroups,
    project: projectGroups,
  });

  return merged;
}

/**
 * Save config to disk
 */
export function saveConfig(config: Config, path?: string): void {
  const filePath = path ?? CONFIG_FILE;
  if (existsSync(filePath)) {
    let existing: unknown;
    try {
      existing = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      // Preserve the legacy writer's existing replacement behavior for files
      // that are not readable JSON configurations.
    }
    if (
      typeof existing === 'object' &&
      existing !== null &&
      Object.hasOwn(existing, 'version') &&
      (existing as { version?: unknown }).version === 2
    ) {
      throw new Error(
        'Refusing to overwrite native v2 configuration through the legacy config writer.',
      );
    }
  }
  mkdirSync(dirname(filePath), { recursive: true });
  safeWriteFile(filePath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: CONFIG_FILE_MODE,
  });
}

/**
 * Check if a provider has a valid API key available
 */
export function hasApiKey(
  apiKeyRef?: string,
  env: EnvRecord = process.env,
): boolean {
  return hasCredential(apiKeyRef, { env });
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

function mergeProviderConfigs(
  base: Config['providers'],
  overrides: NonNullable<ProjectConfig['providers']>,
): Config['providers'] {
  const merged: Config['providers'] = { ...base };

  for (const [id, override] of Object.entries(overrides)) {
    const existing = merged[id];
    const next = {
      ...(existing ?? {}),
      ...stripUndefined(override),
    } as Config['providers'][string];
    merged[id] =
      next.enabled === undefined
        ? { ...next, enabled: true }
        : { ...next, enabled: next.enabled };
  }

  return merged;
}

/**
 * Canonicalize one project-config layer before it is merged with global
 * config. This preserves global -> project precedence even when either layer
 * uses a retired provider id that maps to the same canonical provider.
 */
function normalizeProjectProviderConfigs(
  providers: NonNullable<ProjectConfig['providers']>,
): NonNullable<ProjectConfig['providers']> {
  const layer: Config = {
    ...DEFAULT_CONFIG,
    defaults: { ...DEFAULT_CONFIG.defaults },
    // Preserve omitted fields in this layer. mergeProviderConfigs applies the
    // default enabled=true only when there is no inherited canonical entry.
    providers: Object.fromEntries(
      Object.entries(providers).map(([id, provider]) => [id, { ...provider }]),
    ) as Config['providers'],
    customProviders: {},
    trustedProviderIds: [],
    groups: {},
  };
  migrateLegacyProviderIds(layer);
  return layer.providers;
}

function migrateLegacyProviderIds(config: Config): string[] {
  const warnings: string[] = [];
  const migratedProviders: Config['providers'] = {};

  // Both retired OpenAI deep-research entries map to one canonical provider.
  // A canonical entry wins over either alias; when only aliases exist, the
  // former o3 entry wins deterministically regardless of JSON key order.
  const selectedOpenAiResearchId = [
    'openai-research',
    'openai-deep-o3',
    'openai-deep',
  ].find((id) => config.providers[id] !== undefined);

  const entries = Object.entries(config.providers).sort(([left], [right]) => {
    const leftCanonical = migrateRetiredProviderId(resolveProviderId(left));
    const rightCanonical = migrateRetiredProviderId(resolveProviderId(right));
    return (
      leftCanonical.localeCompare(rightCanonical) ||
      retiredProviderMigrationPriority(left, leftCanonical) -
        retiredProviderMigrationPriority(right, rightCanonical) ||
      left.localeCompare(right)
    );
  });

  for (const [id, providerConfig] of entries) {
    const canonicalId = migrateRetiredProviderId(resolveProviderId(id));
    const normalizedFallback = providerConfig.fallback
      ? migrateRetiredProviderId(resolveProviderId(providerConfig.fallback))
      : undefined;

    if (canonicalId !== id) {
      warnings.push(
        id === 'perplexity-pro-search'
          ? retiredProviderGuidance(id)!
          : `Provider ID "${id}" is deprecated; using "${canonicalId}"`,
      );
    }
    if (
      providerConfig.fallback &&
      normalizedFallback &&
      normalizedFallback !== providerConfig.fallback
    ) {
      warnings.push(
        providerConfig.fallback === 'perplexity-pro-search'
          ? retiredProviderGuidance(providerConfig.fallback)!
          : `Provider "${canonicalId}" fallback "${providerConfig.fallback}" is deprecated; using "${normalizedFallback}"`,
      );
    }

    const normalizedConfig = {
      ...providerConfig,
      fallback: normalizedFallback,
    };

    if (canonicalId === 'openai-research' && id !== selectedOpenAiResearchId) {
      if (selectedOpenAiResearchId) {
        warnings.push(
          `Provider "${id}" maps to "openai-research"; keeping "${selectedOpenAiResearchId}"`,
        );
      }
      continue;
    }

    if (!migratedProviders[canonicalId] || id === canonicalId) {
      migratedProviders[canonicalId] = normalizedConfig;
      continue;
    }

    warnings.push(
      `Provider "${id}" maps to "${canonicalId}", but "${canonicalId}" is also configured; keeping "${canonicalId}"`,
    );
  }

  config.providers = migratedProviders;

  for (const [groupName, members] of Object.entries(config.groups)) {
    const canonicalMembers = members.map((member) => {
      const migrated = migrateRetiredProviderToken(member);
      const [providerId, ...suffix] = migrated.split('/');
      const canonicalMember = [
        migrateRetiredProviderId(resolveProviderId(providerId ?? '')),
        ...suffix,
      ].join('/');
      if (canonicalMember !== member) {
        warnings.push(
          member.split('/')[0] === 'perplexity-pro-search'
            ? retiredProviderGuidance(member)!
            : `Group "${groupName}" member "${member}" is deprecated; using "${canonicalMember}"`,
        );
      }
      return canonicalMember;
    });
    config.groups[groupName] = [...new Set(canonicalMembers)];
  }

  return warnings;
}

/**
 * Ordered canonical rosters shipped immediately before the visibility/provider
 * expansion. These are intentionally enumerated rather than inferred from git
 * history or subset membership: only an exact stored default is safe to move.
 */
const PRIOR_CANONICAL_GROUP_SNAPSHOTS: Readonly<
  Record<'comprehensive' | 'all', readonly (readonly string[])[]>
> = {
  comprehensive: [
    [
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
    ],
  ],
  all: [
    [
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
      'jina-search',
      'firecrawl-search',
      'perplexity-search',
      'brave-search',
      'searchapi',
      'serpapi',
      'tavily',
    ],
  ],
};

type StoredDefaultGroupRosters = Partial<
  Record<'comprehensive' | 'all', readonly string[]>
>;

function captureStoredDefaultGroupRosters(
  groups: Config['groups'],
): StoredDefaultGroupRosters {
  const captured: StoredDefaultGroupRosters = {};
  for (const groupName of ['comprehensive', 'all'] as const) {
    const storedMembers = groups[groupName];
    if (storedMembers) {
      // Canonicalize aliases and deduplicate them before snapshot matching.
      captured[groupName] = [
        ...new Set(
          storedMembers.map((id) => {
            const migrated = migrateRetiredProviderToken(id);
            const [providerId, ...suffix] = migrated.split('/');
            return [
              migrateRetiredProviderId(resolveProviderId(providerId ?? '')),
              ...suffix,
            ].join('/');
          }),
        ),
      ];
    }
  }
  return captured;
}

function migratePriorCanonicalDefaultGroups(
  config: Config,
  storedRosters: StoredDefaultGroupRosters,
): Array<'comprehensive' | 'all'> {
  const migrated: Array<'comprehensive' | 'all'> = [];
  for (const groupName of ['comprehensive', 'all'] as const) {
    const storedMembers = storedRosters[groupName];
    if (!storedMembers) continue;
    const matchesPriorSnapshot = PRIOR_CANONICAL_GROUP_SNAPSHOTS[
      groupName
    ].some((snapshot) => orderedExactMatch(storedMembers, snapshot));
    if (matchesPriorSnapshot) {
      config.groups[groupName] = [...DEFAULT_GROUPS[groupName]];
      migrated.push(groupName);
    }
  }
  return migrated;
}

function orderedExactMatch(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((member, index) => member === expected[index])
  );
}
