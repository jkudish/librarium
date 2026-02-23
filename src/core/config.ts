import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  CONFIG_FILE,
  CONFIG_FILE_MODE,
  DEFAULT_GROUPS,
  PROJECT_CONFIG_FILE,
  resolveProviderId,
  resolveProviderIds,
} from '../constants.js';
import type { Config, Defaults, ProjectConfig } from '../types.js';
import { ConfigSchema, ProjectConfigSchema } from '../types.js';
import { safeWriteFile } from './fs-utils.js';

const DEFAULT_CONFIG: Config = {
  version: 1,
  defaults: {
    outputDir: './agents/librarium',
    maxParallel: 6,
    timeout: 30,
    asyncTimeout: 1800,
    asyncPollInterval: 10,
    mode: 'mixed',
  },
  providers: {},
  groups: { ...DEFAULT_GROUPS },
};

/**
 * Resolve $ENV_VAR references in a string.
 * Returns the resolved value or undefined if the env var is not set.
 */
export function resolveEnvVar(value: string): string | undefined {
  if (value.startsWith('$')) {
    const envName = value.slice(1);
    return process.env[envName];
  }
  return value;
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
    return { ...DEFAULT_CONFIG, groups: { ...DEFAULT_GROUPS } };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    throw new Error(
      `Invalid JSON in ${path}: ${e instanceof Error ? e.message : e}`,
    );
  }
  const config = ConfigSchema.parse(raw);
  // Merge default groups with user groups (user groups take priority)
  config.groups = { ...DEFAULT_GROUPS, ...config.groups };
  const migrationWarnings = migrateLegacyProviderIds(config);

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
    groups: { ...global.groups },
  };

  if (project?.defaults) {
    merged.defaults = {
      ...merged.defaults,
      ...stripUndefined(project.defaults),
    };
  }

  if (cliFlags) {
    merged.defaults = { ...merged.defaults, ...stripUndefined(cliFlags) };
  }

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
export function hasApiKey(apiKeyRef: string): boolean {
  const resolved = resolveEnvVar(apiKeyRef);
  return resolved !== undefined && resolved.length > 0;
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

function migrateLegacyProviderIds(config: Config): string[] {
  const warnings: string[] = [];
  const migratedProviders: Config['providers'] = {};

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
