import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  CONFIG_FILE,
  CONFIG_FILE_MODE,
  DEFAULT_GROUPS,
  PROJECT_CONFIG_FILE,
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
