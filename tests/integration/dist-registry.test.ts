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
});
