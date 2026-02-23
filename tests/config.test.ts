import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hasApiKey,
  loadConfig,
  mergeConfigs,
  resolveEnvVar,
  validateFallbacks,
} from '../src/core/config.js';
import type { Config, ProjectConfig } from '../src/types.js';

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
    expect(config.defaults.asyncPollInterval).toBe(10);
    expect(config.defaults.mode).toBe('mixed');
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
    expect(config.providers['perplexity-sonar-pro']).toBeDefined();
    expect(config.providers['perplexity-sonar-pro'].enabled).toBe(true);
    // Default groups should be merged in
    expect(config.groups).toHaveProperty('deep');
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
    },
    providers: {
      'perplexity-sonar-pro': {
        apiKey: '$PERPLEXITY_API_KEY',
        enabled: true,
      },
    },
    groups: {
      deep: ['perplexity-sonar-deep', 'openai-deep', 'gemini-deep'],
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
      },
    };
    const merged = mergeConfigs(baseGlobal, project, {
      timeout: 120,
    });
    // CLI overrides project
    expect(merged.defaults.timeout).toBe(120);
    // Project overrides global
    expect(merged.defaults.outputDir).toBe('./research');
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
    },
    providers,
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
