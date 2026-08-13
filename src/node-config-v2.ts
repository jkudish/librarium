import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CONFIG_FILE_MODE, PROJECT_CONFIG_FILE } from './constants.js';
import {
  type ConfigMigrationResult,
  type LibrariumConfigV2,
  migrateConfig,
  validateConfigV2,
} from './core/config-v2.js';
import {
  assertWindowsOwnerOnlyAclSupport,
  safeWriteFile,
} from './core/fs-utils.js';
import type { PreparationIssue } from './core/research-request.js';

export interface LoadConfigV2Options {
  readonly global_path: string;
  readonly project_path?: string;
}

export interface SaveConfigV2Options {
  readonly path: string;
}

export class ConfigV2FileError extends Error {
  readonly issues: readonly PreparationIssue[];

  constructor(message: string, issues: readonly PreparationIssue[] = []) {
    super(message);
    this.name = 'ConfigV2FileError';
    this.issues = issues;
  }
}

function invalidJson(path: string): ConfigMigrationResult {
  return {
    ok: false,
    issues: [
      {
        code: 'config_json_invalid',
        phase: 'migration',
        path,
        // JSON.parse diagnostics can echo source fragments, including secrets.
        // Keep the public diagnostic fixed and safe for logs.
        message: 'Invalid JSON.',
      },
    ],
    notices: [],
  };
}

function fileReadFailed(path: string): ConfigMigrationResult {
  return {
    ok: false,
    issues: [
      {
        code: 'config_file_read_failed',
        phase: 'migration',
        path,
        message: 'Unable to read configuration file.',
      },
    ],
    notices: [],
  };
}

/**
 * Read and migrate configuration without rewriting either source file.
 * Callers must provide the global path explicitly so a library import never
 * inspects a host-specific home directory.
 */
export function loadConfigV2(
  options: LoadConfigV2Options,
): ConfigMigrationResult {
  const globalPath = resolve(options.global_path);
  let globalText: string;
  try {
    globalText = readFileSync(globalPath, 'utf8');
  } catch {
    return fileReadFailed('/global');
  }
  let global: unknown;
  try {
    global = JSON.parse(globalText);
  } catch {
    return invalidJson('/global');
  }

  let project: unknown;
  if (options.project_path !== undefined && existsSync(options.project_path)) {
    const projectPath = resolve(options.project_path);
    let projectText: string;
    try {
      projectText = readFileSync(projectPath, 'utf8');
    } catch {
      return fileReadFailed('/project');
    }
    try {
      project = JSON.parse(projectText);
    } catch {
      return invalidJson('/project');
    }
  }

  return migrateConfig({ global, ...(project !== undefined && { project }) });
}

/**
 * Explicitly persist a validated native v2 configuration.
 *
 * The write is atomic and owner-only. Unix uses a verified 0600 mode. Windows
 * establishes a protected DACL containing only the current user, verifies it
 * before writing content, and verifies it again before atomic replacement.
 * Missing Windows ACL support fails closed. Loading and ordinary execution
 * never call this function, so migration cannot silently rewrite user files.
 */
export function saveConfigV2(
  config: LibrariumConfigV2,
  options: SaveConfigV2Options,
): void {
  const validated = validateConfigV2(config);
  if (!validated.ok) {
    throw new ConfigV2FileError(
      'Refusing to save invalid Librarium v2 configuration.',
      validated.issues,
    );
  }
  try {
    assertWindowsOwnerOnlyAclSupport();
  } catch {
    throw new ConfigV2FileError(
      'Owner-only config saves require verified Windows ACL support.',
    );
  }
  const path = resolve(options.path);
  mkdirSync(dirname(path), { recursive: true });
  safeWriteFile(path, `${JSON.stringify(validated.config, null, 2)}\n`, {
    mode: CONFIG_FILE_MODE,
    ownerOnly: true,
  });
}

/** Conventional project path helper; it performs no filesystem access. */
export function projectConfigV2Path(cwd: string): string {
  return resolve(cwd, PROJECT_CONFIG_FILE);
}
