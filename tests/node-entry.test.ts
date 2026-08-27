import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_PROVIDER_CATALOG } from '../src/core/provider-profiles.js';
import { RESERVED_BUILTIN_PROVIDER_IDS } from '../src/core/reserved-provider-ids.js';

const BUILTIN_IDS = BUILTIN_PROVIDER_CATALOG.map(
  ({ provider_id }) => provider_id,
);
const RESERVED_IDS = [...RESERVED_BUILTIN_PROVIDER_IDS].sort();

describe('librarium/node entry', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `librarium-node-entry-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeNpmProvider(id: string, topLevelEffectPath?: string): void {
    const packageDirectory = join(tmpDir, 'node_modules', id);
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'tmp-project', private: true }, null, 2),
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
        ...(topLevelEffectPath
          ? [
              "import { writeFileSync } from 'node:fs';",
              `writeFileSync(${JSON.stringify(topLevelEffectPath)}, 'loaded');`,
            ]
          : []),
        'export default {',
        `  id: '${id}',`,
        "  displayName: 'Library Provider',",
        "  tier: 'ai-grounded',",
        "  execution: 'inline',",
        "  envVar: '',",
        '  requiresApiKey: false,',
        '  async execute(query) {',
        '    return {',
        `      provider: '${id}',`,
        "      tier: 'ai-grounded',",
        '      content: `library:${query}`,',
        '      citations: [],',
        '      durationMs: 1,',
        '    };',
        '  },',
        '};',
      ].join('\n'),
    );
  }

  function writeScriptProbe(id: string, markerPath: string): string {
    const scriptPath = join(tmpDir, `${id.replaceAll('/', '-')}-provider.mjs`);
    writeFileSync(
      scriptPath,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(markerPath)}, 'described');`,
      ].join('\n'),
    );
    return scriptPath;
  }

  it('loads trusted custom providers without mutating a public registry', async () => {
    writeNpmProvider('library-provider');
    const node = await import('../src/node-entry.js');
    expect(node.SCRIPT_CUSTOM_PROVIDER_PROTOCOL_VERSION).toBe(1);

    const result = await node.loadCustomProviders({
      providers: { 'library-provider': { enabled: true } },
      customProviders: {
        'library-provider': { type: 'npm', module: 'library-provider' },
      },
      trustedProviderIds: ['library-provider'],
    });

    expect(result.warnings).toEqual([]);
    expect(result.loadedIds).toEqual(['library-provider']);
    await expect(
      result.providers[0]?.execute('hello', { timeout: 5 }),
    ).resolves.toMatchObject({ content: 'library:hello' });
    expect(node).not.toHaveProperty('registerCustomProviders');
    expect(node).not.toHaveProperty('executeResearchRun');
  });

  it.each(RESERVED_IDS)(
    'rejects reserved built-in id %s before importing custom code',
    async (providerId) => {
      const markerPath = join(tmpDir, `${providerId}-loaded`);
      writeNpmProvider(providerId, markerPath);
      const { loadCustomProviders } = await import('../src/node-entry.js');

      const result = await loadCustomProviders({
        providers: { [providerId]: { enabled: true } },
        customProviders: {
          [providerId]: { type: 'npm', module: providerId },
        },
        trustedProviderIds: [providerId],
      });

      expect(result.skippedIds).toContain(providerId);
      expect(result.warnings.join(' ')).toMatch(/conflicts with a built-in/);
      expect(existsSync(markerPath)).toBe(false);
    },
  );

  it('cannot bypass built-in protection with an empty additional reserve', async () => {
    const markerPath = join(tmpDir, 'exa-loaded');
    writeNpmProvider('exa', markerPath);
    const { loadCustomProviders } = await import('../src/node-entry.js');

    const result = await loadCustomProviders(
      {
        providers: { exa: { enabled: true } },
        customProviders: { exa: { type: 'npm', module: 'exa' } },
        trustedProviderIds: ['exa'],
      },
      { reservedProviderIds: [] },
    );

    expect(result.skippedIds).toContain('exa');
    expect(existsSync(markerPath)).toBe(false);
  });

  it('rejects a built-in alias before spawning script describe code', async () => {
    const markerPath = join(tmpDir, 'alias-described');
    const scriptPath = writeScriptProbe('openai-deep', markerPath);
    const { loadCustomProviders } = await import('../src/node-entry.js');

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

    expect(result.skippedIds).toContain('openai-deep');
    expect(existsSync(markerPath)).toBe(false);
  });

  it.each(RESERVED_IDS)(
    'rejects reserved script id %s before describe/spawn',
    async (providerId) => {
      const safeId = providerId.replaceAll('/', '-');
      const markerPath = join(tmpDir, `${safeId}-described`);
      const scriptPath = writeScriptProbe(providerId, markerPath);
      const { loadCustomProviders } = await import('../src/node-entry.js');

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

      expect(result.skippedIds).toContain(providerId);
      expect(result.warnings.join(' ')).toMatch(/conflicts with a built-in/);
      expect(existsSync(markerPath)).toBe(false);
    },
  );

  it('covers every current and planned catalog identity in the reserved set', () => {
    expect(
      BUILTIN_IDS.every((id) => RESERVED_BUILTIN_PROVIDER_IDS.has(id)),
    ).toBe(true);
  });
});
