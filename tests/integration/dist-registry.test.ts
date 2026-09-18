import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const DIST_ROOT = pathToFileURL(
  resolve(import.meta.dirname, '../../dist/index.js'),
).href;
const DIST_CORE = pathToFileURL(
  resolve(import.meta.dirname, '../../dist/core.js'),
).href;
const DIST_NODE = pathToFileURL(
  resolve(import.meta.dirname, '../../dist/node.js'),
).href;

describe('built package boundaries', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `librarium-dist-entry-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeNpmProvider(id: string): void {
    const packageDirectory = join(tmpDir, 'node_modules', id);
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'tmp-project', private: true }),
    );
    writeFileSync(
      join(packageDirectory, 'package.json'),
      JSON.stringify({
        name: id,
        version: '1.0.0',
        type: 'module',
        exports: './index.mjs',
      }),
    );
    writeFileSync(
      join(packageDirectory, 'index.mjs'),
      [
        'export default {',
        `  id: '${id}',`,
        "  displayName: 'Dist Provider',",
        "  tier: 'ai-grounded',",
        "  execution: 'inline',",
        "  envVar: '',",
        '  requiresApiKey: false,',
        '  async execute(query) {',
        '    return {',
        `      provider: '${id}',`,
        "      tier: 'ai-grounded',",
        '      content: `dist:${query}`,',
        '      citations: [],',
        '      durationMs: 1,',
        '    };',
        '  },',
        '};',
      ].join('\n'),
    );
  }

  it('keeps root and core free of concrete adapters and global registries', async () => {
    const root = await import(DIST_ROOT);
    const core = await import(DIST_CORE);

    expect(root.ResearchRequestSchema).toBeDefined();
    expect(core.buildProviderCatalog).toBeTypeOf('function');
    expect(core).not.toHaveProperty('initializeProviders');
    expect(core).not.toHaveProperty('registerProvider');
    expect(core).not.toHaveProperty('SearchApiProvider');
    expect(core).not.toHaveProperty('dispatch');
  });

  it('loads a trusted custom provider through the Node entry without globals', async () => {
    const node = await import(DIST_NODE);
    writeNpmProvider('dist-provider');

    const result = await node.loadCustomProviders({
      providers: { 'dist-provider': { enabled: true } },
      customProviders: {
        'dist-provider': { type: 'npm', module: 'dist-provider' },
      },
      trustedProviderIds: ['dist-provider'],
    });

    expect(result.loadedIds).toEqual(['dist-provider']);
    await expect(
      result.providers[0]?.execute('hello', { timeout: 5 }),
    ).resolves.toMatchObject({ content: 'dist:hello' });
    expect(node).not.toHaveProperty('registerCustomProviders');
  });

  it('composes built loadConfigV2 output with custom-provider loading', async () => {
    const node = await import(DIST_NODE);
    const providerId = 'dist-native-provider';
    const configPath = join(tmpDir, 'config.v2.json');
    writeNpmProvider(providerId);
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 2,
        execution_defaults: {
          mode: 'sync',
          max_concurrency: 1,
          inline_attempt_deadline_ms: 30_000,
          background_attempt_deadline_ms: 1_800_000,
          poll_interval_ms: 10_000,
        },
        providers: { [providerId]: { enabled: true } },
        custom_providers: {
          [providerId]: {
            type: 'npm',
            module: providerId,
            execution_profile: {
              binding_id: `${providerId}.search.v1`,
              profile: {
                identity: {
                  provider_id: `${providerId}-public`,
                  profile_id: 'search',
                  target: {
                    primary: { model_selection: 'not_applicable' },
                  },
                },
                result_kind: 'search_results',
                observation_mode: 'api_output',
                corpora: ['web'],
                retrieval_method: 'search_endpoint',
                access_mode: 'direct',
                operator_id: `${providerId}-public`,
                invocation: 'inline',
                resumability: 'none',
              },
            },
          },
        },
        trusted_provider_ids: [providerId],
        groups: {},
        runtime: { output_dir: './runs', llm_web_search: true },
      }),
    );

    const loadedConfig = node.loadConfigV2({ global_path: configPath });
    expect(loadedConfig.ok).toBe(true);
    if (!loadedConfig.ok) return;
    const result = await node.loadCustomProviders(loadedConfig.config);

    expect(result).toMatchObject({
      loadedIds: [providerId],
      skippedIds: [],
      warnings: [],
    });
    await expect(
      result.providers[0]?.execute('hello', { timeout: 5 }),
    ).resolves.toMatchObject({ content: 'dist:hello' });
  });
});
