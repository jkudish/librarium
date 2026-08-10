import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LibrariumConfigV2 } from '../src/core/config-v2.js';
import { safeWriteFile } from '../src/core/fs-utils.js';
import {
  ConfigV2FileError,
  loadConfigV2,
  projectConfigV2Path,
  saveConfigV2,
} from '../src/node-config-v2.js';

function config(): LibrariumConfigV2 {
  return {
    version: 2,
    execution_defaults: {
      mode: 'sync',
      max_concurrency: 2,
      inline_attempt_deadline_ms: 30_000,
      background_attempt_deadline_ms: 60_000,
      poll_interval_ms: 5_000,
    },
    providers: { exa: { enabled: true } },
    custom_providers: {},
    trusted_provider_ids: [],
    groups: { 'custom:team': ['exa/search'] },
    runtime: {
      output_dir: './agents/librarium',
      llm_web_search: true,
    },
  };
}

describe('explicit Node v2 config files', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'librarium-config-v2-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('loads and migrates without rewriting either source file', () => {
    const globalPath = join(directory, 'config.json');
    const projectPath = join(directory, '.librarium.json');
    const global = JSON.stringify(config(), null, 2);
    const project = JSON.stringify({
      version: 2,
      execution_defaults: { max_concurrency: 5 },
    });
    writeFileSync(globalPath, global);
    writeFileSync(projectPath, project);

    const result = loadConfigV2({
      global_path: globalPath,
      project_path: projectPath,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.execution_defaults.max_concurrency).toBe(5);
    }
    expect(readFileSync(globalPath, 'utf8')).toBe(global);
    expect(readFileSync(projectPath, 'utf8')).toBe(project);
  });

  it('returns safe path-addressed JSON diagnostics', () => {
    const globalPath = join(directory, 'config.json');
    const secret = 'supersecret-api-key';
    writeFileSync(globalPath, `{"api_key":${secret}}`);
    const result = loadConfigV2({ global_path: globalPath });
    expect(result).toMatchObject({
      ok: false,
      issues: [
        {
          code: 'config_json_invalid',
          path: '/global',
          message: 'Invalid JSON.',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('distinguishes file-read failures from malformed JSON without leaking paths', () => {
    const missingPath = join(directory, 'missing-config.json');
    const result = loadConfigV2({ global_path: missingPath });
    expect(result).toMatchObject({
      ok: false,
      issues: [
        {
          code: 'config_file_read_failed',
          path: '/global',
          message: 'Unable to read configuration file.',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(missingPath);
  });

  it('validates before an atomic owner-only save', () => {
    if (process.platform === 'win32') return;
    const path = join(directory, 'nested', 'config.json');
    saveConfigV2(config(), { path });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(config());
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(join(directory, 'nested'))).toEqual(['config.json']);
  });

  it('verifies owner-only mode after a restrictive umask before rename', () => {
    if (process.platform === 'win32') return;
    const path = join(directory, 'umask', 'config.json');
    mkdirSync(dirname(path), { recursive: true });
    const previousUmask = process.umask(0o400);
    try {
      saveConfigV2(config(), { path });
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  it('rejects owner-only saves on Windows before creating directories', () => {
    if (process.platform !== 'win32') return;
    const path = join(directory, 'windows', 'config.json');
    expect(() => saveConfigV2(config(), { path })).toThrow(ConfigV2FileError);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
  });

  it('preserves ordinary mode-only atomic writes on every platform', () => {
    const path = join(directory, 'ordinary-write.txt');
    safeWriteFile(path, 'legacy-compatible', { mode: 0o600 });
    expect(readFileSync(path, 'utf8')).toBe('legacy-compatible');
  });

  it('atomically replaces an existing config without leaving temp files', () => {
    if (process.platform === 'win32') return;
    const path = join(directory, 'config.json');
    saveConfigV2(config(), { path });
    const replacement: LibrariumConfigV2 = {
      ...config(),
      runtime: {
        output_dir: './replacement-runs',
        llm_web_search: false,
      },
    };

    saveConfigV2(replacement, { path });

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(replacement);
    expect(readdirSync(directory)).toEqual(['config.json']);
  });

  it('does not write an invalid v2 config', () => {
    const path = join(directory, 'config.json');
    expect(() =>
      saveConfigV2(
        {
          ...config(),
          groups: { team: ['exa/search'] },
        } as LibrariumConfigV2,
        { path },
      ),
    ).toThrow(ConfigV2FileError);
    expect(existsSync(path)).toBe(false);
  });

  it('saves and reloads the same materialized chat defaults', () => {
    if (process.platform === 'win32') return;
    const path = join(directory, 'config.json');
    const source: LibrariumConfigV2 = {
      ...config(),
      providers: { claude: { enabled: true } },
      runtime: {
        output_dir: './agents/librarium',
        llm_web_search: false,
      },
    };

    saveConfigV2(source, { path });
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.providers.claude.options).toEqual({ webSearch: false });

    const loaded = loadConfigV2({ global_path: path });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.config).toEqual(saved);
  });

  it('resolves the conventional project path without reading it', () => {
    expect(projectConfigV2Path(directory)).toBe(
      join(directory, '.librarium.json'),
    );
  });
});
