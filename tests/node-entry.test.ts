import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The `librarium/node` entry point is the documented Node-only bridge that lets
// library consumers (not just the CLI) load npm/script custom providers and
// register them into the core registry.

describe('librarium/node entry', () => {
  let tmpDir: string;
  let originalCwd: string;
  let loadCustomProviders: typeof import('../src/node-entry.js').loadCustomProviders;
  let registerCustomProviders: typeof import('../src/node-entry.js').registerCustomProviders;
  let getProvider: typeof import('../src/adapters/index.js').getProvider;
  let getAllProviders: typeof import('../src/adapters/index.js').getAllProviders;
  let registerProvider: typeof import('../src/adapters/index.js').registerProvider;
  let initializeProviders: typeof import('../src/adapters/index.js').initializeProviders;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `librarium-node-entry-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    vi.resetModules();
    const nodeEntry = await import('../src/node-entry.js');
    loadCustomProviders = nodeEntry.loadCustomProviders;
    registerCustomProviders = nodeEntry.registerCustomProviders;
    const registry = await import('../src/adapters/index.js');
    getProvider = registry.getProvider;
    getAllProviders = registry.getAllProviders;
    registerProvider = registry.registerProvider;
    initializeProviders = registry.initializeProviders;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('exposes the documented load/register API', () => {
    expect(typeof loadCustomProviders).toBe('function');
    expect(typeof registerCustomProviders).toBe('function');
  });

  function writeNpmProvider(id: string): void {
    const pkgDir = join(tmpDir, 'node_modules', id);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'tmp-project', private: true }, null, 2),
      'utf-8',
    );
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify(
        { name: id, version: '1.0.0', type: 'module', exports: './index.mjs' },
        null,
        2,
      ),
      'utf-8',
    );
    writeFileSync(
      join(pkgDir, 'index.mjs'),
      [
        'export default {',
        `  id: '${id}',`,
        "  displayName: 'Lib Provider',",
        "  tier: 'ai-grounded',",
        "  envVar: '',",
        '  requiresApiKey: false,',
        '  async execute(query) {',
        '    return {',
        `      provider: '${id}',`,
        "      tier: 'ai-grounded',",
        '      content: `lib:${query}`,',
        '      citations: [],',
        '      durationMs: 1,',
        '    };',
        '  },',
        '};',
        '',
      ].join('\n'),
      'utf-8',
    );
  }

  it('loadCustomProviders loads a trusted provider without registering it', async () => {
    writeNpmProvider('lib-provider');

    const result = await loadCustomProviders({
      providers: { 'lib-provider': { enabled: true } },
      customProviders: {
        'lib-provider': { type: 'npm', module: 'lib-provider' },
      },
      trustedProviderIds: ['lib-provider'],
    });

    expect(result.warnings).toEqual([]);
    expect(result.loadedIds).toContain('lib-provider');
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].source).toBe('npm');
    // load-only: registry untouched
    expect(getProvider('lib-provider')).toBeUndefined();
  });

  it('registerCustomProviders registers loaded providers into the core registry', async () => {
    writeNpmProvider('lib-provider');
    await initializeProviders();
    const builtinCount = getAllProviders().length;

    const result = await registerCustomProviders({
      providers: { 'lib-provider': { enabled: true } },
      customProviders: {
        'lib-provider': { type: 'npm', module: 'lib-provider' },
      },
      trustedProviderIds: ['lib-provider'],
    });

    expect(result.loadedIds).toContain('lib-provider');
    const registered = getProvider('lib-provider');
    expect(registered).toBeDefined();
    expect(registered?.source).toBe('npm');
    expect(getAllProviders()).toHaveLength(builtinCount + 1);

    const executed = await registered!.execute('hi', { timeout: 5 });
    expect(executed.content).toBe('lib:hi');
  });

  it('protects reserved provider IDs by default after initializeProviders', async () => {
    writeNpmProvider('exa');
    await initializeProviders();

    const result = await registerCustomProviders({
      providers: { exa: { enabled: true } },
      customProviders: { exa: { type: 'npm', module: 'exa' } },
      trustedProviderIds: ['exa'],
    });

    expect(result.loadedIds).not.toContain('exa');
    expect(result.skippedIds).toContain('exa');
    expect(result.warnings.join(' ')).toMatch(/conflicts with a built-in/);
    // The built-in exa provider is still the registered one.
    expect(getProvider('exa')?.source).toBe('builtin');
    expect(registerProvider).toBeDefined();
  });
});
