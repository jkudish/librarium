import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Dist-level integration test for the shared provider registry.
//
// This is the regression test for the bug where each tsup entry
// (dist/core.js, dist/node.js, dist/cli.js) bundled its OWN inlined copy of
// the provider registry module. In that state, `registerCustomProviders()`
// from `librarium/node` registered into the node bundle's private registry
// while `getProvider()`/`dispatch()` from `librarium/core` read the core
// bundle's separate registry -- so the documented flow (import core for
// dispatch + node for custom providers) silently did nothing.
//
// Source-level tests miss this because they import `src/` modules directly,
// giving a single shared module instance. We MUST import the BUILT dist files.
//
// Run `npm run build` before executing these tests.

const DIST_CORE = pathToFileURL(
  resolve(import.meta.dirname, '../../dist/core.js'),
).href;
const DIST_NODE = pathToFileURL(
  resolve(import.meta.dirname, '../../dist/node.js'),
).href;

type CoreModule = typeof import('../../src/core-entry.js');
type NodeModule = typeof import('../../src/node-entry.js');

describe('dist registry sharing (core + node)', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `librarium-dist-registry-${randomUUID().slice(0, 8)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
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
        "  displayName: 'Dist Lib Provider',",
        "  tier: 'ai-grounded',",
        "  execution: 'inline',",
        "  envVar: '',",
        '  requiresApiKey: false,',
        '  async execute(query) {',
        '    return {',
        `      provider: '${id}',`,
        "      tier: 'ai-grounded',",
        '      content: `dist-lib:${query}`,',
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

  it('registerCustomProviders (node) is visible to getProvider/dispatch (core)', async () => {
    const core = (await import(DIST_CORE)) as CoreModule;
    const node = (await import(DIST_NODE)) as NodeModule;

    writeNpmProvider('dist-lib-provider');

    // Initialize the built-in registry via the CORE entry, then register a
    // custom provider via the NODE entry. If the registries are separate
    // bundled copies, getProvider() from core will NOT see it -> test fails.
    await core.initializeProviders();

    const result = await node.registerCustomProviders({
      providers: { 'dist-lib-provider': { enabled: true } },
      customProviders: {
        'dist-lib-provider': { type: 'npm', module: 'dist-lib-provider' },
      },
      trustedProviderIds: ['dist-lib-provider'],
    });

    expect(result.warnings).toEqual([]);
    expect(result.loadedIds).toContain('dist-lib-provider');

    // THE CRITICAL ASSERTION: core's getProvider must see what node registered.
    const fromCore = core.getProvider('dist-lib-provider');
    expect(fromCore).toBeDefined();
    expect(fromCore?.source).toBe('npm');

    // And a dispatch via core must actually run the custom provider.
    const dispatched = await core.dispatch({
      config: {
        version: 1,
        defaults: {
          outputDir: './agents/librarium',
          maxParallel: 2,
          timeout: 10,
          asyncTimeout: 60,
          asyncPollInterval: 1,
          mode: 'sync',
          llmWebSearch: true,
        },
        providers: { 'dist-lib-provider': { enabled: true } },
        customProviders: {},
        trustedProviderIds: [],
        groups: {},
      },
      providerIds: ['dist-lib-provider'],
      query: 'hello',
      mode: 'sync',
      credentials: { env: {} },
    });

    expect(dispatched.results).toHaveLength(1);
    expect(dispatched.results[0]?.status).toBe('success');
    expect(dispatched.results[0]?.text).toBe('dist-lib:hello');
  });

  it('reserved built-in IDs (registered via core) are rejected by node', async () => {
    const core = (await import(DIST_CORE)) as CoreModule;
    const node = (await import(DIST_NODE)) as NodeModule;

    // Built-ins registered via core. node's default reserved-ID set is derived
    // from getAllProviders() -- which reads the registry. If registries are
    // separate, node sees an EMPTY built-in set and would wrongly allow `exa`.
    writeNpmProvider('exa');
    await core.initializeProviders();

    const result = await node.registerCustomProviders({
      providers: { exa: { enabled: true } },
      customProviders: { exa: { type: 'npm', module: 'exa' } },
      trustedProviderIds: ['exa'],
    });

    expect(result.loadedIds).not.toContain('exa');
    expect(result.skippedIds).toContain('exa');
    expect(result.warnings.join(' ')).toMatch(/conflicts with a built-in/);

    // The built-in exa provider (registered via core) is still the one core sees.
    expect(core.getProvider('exa')?.source).toBe('builtin');
  });
});
