import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  CONFIG_FILE_MODE,
  DEFAULT_GROUPS,
  PROJECT_CONFIG_FILE,
  resolveProviderId,
  resolveProviderIds,
} from '../constants.js';
import type { Config, Defaults, ProjectConfig } from '../types.js';
import { ConfigSchema, ProjectConfigSchema } from '../types.js';
import type { EnvRecord } from './credentials.js';
import { hasCredential, resolveCredential } from './credentials.js';
import { safeWriteFile } from './fs-utils.js';

export const CONFIG_DIR = resolve(homedir(), '.config', 'librarium');
export const CONFIG_FILE = resolve(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: Config = {
  version: 1,
  defaults: {
    outputDir: './agents/librarium',
    maxParallel: 6,
    timeout: 30,
    asyncTimeout: 1800,
    asyncPollInterval: 30,
    mode: 'mixed',
    llmWebSearch: true,
  },
  providers: {},
  customProviders: {},
  trustedProviderIds: [],
  groups: { ...DEFAULT_GROUPS },
};

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
    return {
      ...DEFAULT_CONFIG,
      providers: {},
      customProviders: {},
      trustedProviderIds: [],
      groups: { ...DEFAULT_GROUPS },
    };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    throw new Error(
      `Invalid JSON in ${path}: ${e instanceof Error ? e.message : e}`,
    );
  }
  const config = ConfigSchema.parse(raw);
  const storedDefaultGroupRosters = captureStoredDefaultGroupRosters(
    config.groups,
  );
  const migrationWarnings = migrateLegacyProviderIds(config);
  migratePriorCanonicalDefaultGroups(config, storedDefaultGroupRosters);
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

  return config;
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

  return merged;
}

/**
 * Save config to disk
 */
export function saveConfig(config: Config, path?: string): void {
  const filePath = path ?? CONFIG_FILE;
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
  const openAiResearchConfigs = [
    'openai-deep',
    'openai-deep-o3',
    'openai-research',
  ].filter((id) => config.providers[id] !== undefined);
  const selectedOpenAiResearchId = openAiResearchConfigs.includes(
    'openai-research',
  )
    ? 'openai-research'
    : openAiResearchConfigs.includes('openai-deep-o3')
      ? 'openai-deep-o3'
      : openAiResearchConfigs.includes('openai-deep')
        ? 'openai-deep'
        : undefined;

  for (const [id, providerConfig] of Object.entries(config.providers)) {
    const canonicalId = resolveProviderId(id);
    const normalizedFallback = providerConfig.fallback
      ? resolveProviderId(providerConfig.fallback)
      : undefined;

    if (canonicalId !== id) {
      warnings.push(
        `Provider ID "${id}" is deprecated; using "${canonicalId}"`,
      );
    }
    if (
      providerConfig.fallback &&
      normalizedFallback &&
      normalizedFallback !== providerConfig.fallback
    ) {
      warnings.push(
        `Provider "${canonicalId}" fallback "${providerConfig.fallback}" is deprecated; using "${normalizedFallback}"`,
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
    for (const member of members) {
      const canonicalMember = resolveProviderId(member);
      if (canonicalMember !== member) {
        warnings.push(
          `Group "${groupName}" member "${member}" is deprecated; using "${canonicalMember}"`,
        );
      }
    }
    config.groups[groupName] = resolveProviderIds(members);
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
      'perplexity-advanced-deep',
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
      'perplexity-advanced-deep',
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
      // Canonicalize aliases without deduplication so additions and duplicate
      // members cannot accidentally collapse into a recognized snapshot.
      captured[groupName] = storedMembers.map(resolveProviderId);
    }
  }
  return captured;
}

function migratePriorCanonicalDefaultGroups(
  config: Config,
  storedRosters: StoredDefaultGroupRosters,
): void {
  for (const groupName of ['comprehensive', 'all'] as const) {
    const storedMembers = storedRosters[groupName];
    if (!storedMembers) continue;
    const matchesPriorSnapshot = PRIOR_CANONICAL_GROUP_SNAPSHOTS[
      groupName
    ].some((snapshot) => orderedExactMatch(storedMembers, snapshot));
    if (matchesPriorSnapshot) {
      config.groups[groupName] = [...DEFAULT_GROUPS[groupName]];
    }
  }
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
