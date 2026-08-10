import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_PROVIDER_CATALOG } from '../src/core/provider-profiles.js';

const PLANNED_PROVIDER_IDS = BUILTIN_PROVIDER_CATALOG.filter((entry) =>
  entry.profiles.some((profile) => profile.status === 'planned'),
).map((entry) => entry.provider_id);

// The `librarium/node` entry point is the documented Node-only bridge that lets
// library consumers (not just the CLI) load npm/script custom providers and
// register them into the core registry.

describe('librarium/node entry', () => {
  let tmpDir: string;
  let originalCwd: string;
  let loadCustomProviders: typeof import('../src/node-entry.js').loadCustomProviders;
  let registerCustomProviders: typeof import('../src/node-entry.js').registerCustomProviders;
  let executeResearchRun: typeof import('../src/node-entry.js').executeResearchRun;
  let getProvider: typeof import('../src/adapters/index.js').getProvider;
  let getAllProviders: typeof import('../src/adapters/index.js').getAllProviders;
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
    executeResearchRun = nodeEntry.executeResearchRun;
    const registry = await import('../src/adapters/index.js');
    getProvider = registry.getProvider;
    getAllProviders = registry.getAllProviders;
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
    expect(typeof executeResearchRun).toBe('function');
  });

  function writeNpmProvider(id: string, topLevelEffectPath?: string): void {
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
        ...(topLevelEffectPath
          ? [
              "import { writeFileSync } from 'node:fs';",
              `writeFileSync(${JSON.stringify(topLevelEffectPath)}, 'loaded');`,
            ]
          : []),
        'export default {',
        `  id: '${id}',`,
        "  displayName: 'Lib Provider',",
        "  tier: 'ai-grounded',",
        "  execution: 'inline',",
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

  it('rejects canonical built-in IDs before importing npm code', async () => {
    const markerPath = join(tmpDir, 'npm-provider-loaded');
    writeNpmProvider('exa', markerPath);

    const result = await loadCustomProviders(
      {
        providers: { exa: { enabled: true } },
        customProviders: { exa: { type: 'npm', module: 'exa' } },
        trustedProviderIds: ['exa'],
      },
      {
        reservedProviderIds: [],
      },
    );

    expect(result.loadedIds).not.toContain('exa');
    expect(result.skippedIds).toContain('exa');
    expect(result.warnings.join(' ')).toMatch(/conflicts with a built-in/);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('rejects built-in aliases before spawning script describe code', async () => {
    const markerPath = join(tmpDir, 'script-provider-described');
    const scriptPath = join(tmpDir, 'reserved-provider-script.mjs');
    writeFileSync(
      scriptPath,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(markerPath)}, 'described');`,
      ].join('\n'),
      'utf-8',
    );

    const result = await loadCustomProviders(
      {
        providers: { 'openai-deep': { enabled: true } },
        customProviders: {
          'openai-deep': {
            type: 'script',
            command: process.execPath,
            args: [scriptPath],
          },
        },
        trustedProviderIds: ['openai-deep'],
      },
      { reservedProviderIds: [] },
    );

    expect(result.loadedIds).not.toContain('openai-deep');
    expect(result.skippedIds).toContain('openai-deep');
    expect(result.warnings.join(' ')).toMatch(/conflicts with a built-in/);
    expect(existsSync(markerPath)).toBe(false);
  });

  it.each(PLANNED_PROVIDER_IDS)(
    'rejects planned built-in id %s before importing npm code',
    async (providerId) => {
      const markerPath = join(tmpDir, `${providerId}-npm-loaded`);
      writeNpmProvider(providerId, markerPath);
      const result = await loadCustomProviders({
        providers: { [providerId]: { enabled: true } },
        customProviders: {
          [providerId]: { type: 'npm', module: providerId },
        },
        trustedProviderIds: [providerId],
      });
      expect(result.loadedIds).not.toContain(providerId);
      expect(result.skippedIds).toContain(providerId);
      expect(result.warnings.join(' ')).toMatch(/conflicts with a built-in/);
      expect(existsSync(markerPath)).toBe(false);
    },
  );

  it.each(PLANNED_PROVIDER_IDS)(
    'rejects planned built-in id %s before spawning script describe code',
    async (providerId) => {
      const markerPath = join(tmpDir, `${providerId}-script-described`);
      const scriptPath = join(tmpDir, `${providerId}-provider-script.mjs`);
      writeFileSync(
        scriptPath,
        [
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(markerPath)}, 'described');`,
        ].join('\n'),
        'utf-8',
      );
      const result = await loadCustomProviders({
        providers: { [providerId]: { enabled: true } },
        customProviders: {
          [providerId]: {
            type: 'script',
            command: process.execPath,
            args: [scriptPath],
          },
        },
        trustedProviderIds: [providerId],
      });
      expect(result.loadedIds).not.toContain(providerId);
      expect(result.skippedIds).toContain(providerId);
      expect(result.warnings.join(' ')).toMatch(/conflicts with a built-in/);
      expect(existsSync(markerPath)).toBe(false);
    },
  );
});
