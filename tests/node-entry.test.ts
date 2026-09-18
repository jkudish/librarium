import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

  function nativeConfig(
    id: string,
    overrides: {
      enabled?: boolean;
      trusted?: boolean;
      credentialEnvVar?: string;
    } = {},
  ) {
    return {
      version: 2 as const,
      execution_defaults: {
        mode: 'sync' as const,
        max_concurrency: 2,
        inline_attempt_deadline_ms: 30_000,
        background_attempt_deadline_ms: 1_800_000,
        poll_interval_ms: 10_000,
      },
      providers: {
        [id]: {
          enabled: overrides.enabled ?? true,
          api_key: '$ACME_API_KEY',
          model: 'fixture-model',
          options: { region: 'ca' },
        },
      },
      custom_providers: {
        [id]: {
          type: 'npm' as const,
          module: id,
          export: 'factory',
          options: { suffix: 'native' },
          execution_profile: {
            binding_id: `${id}.search.v1`,
            profile: {
              identity: {
                provider_id: `${id}-public`,
                profile_id: 'search',
                target: {
                  primary: { model_selection: 'not_applicable' as const },
                },
              },
              result_kind: 'search_results' as const,
              observation_mode: 'api_output' as const,
              corpora: ['web' as const],
              retrieval_method: 'search_endpoint' as const,
              access_mode: 'direct' as const,
              operator_id: `${id}-public`,
              invocation: 'inline' as const,
              resumability: 'none' as const,
            },
            credential: {
              env_var: overrides.credentialEnvVar ?? 'ACME_API_KEY',
            },
          },
        },
      },
      trusted_provider_ids: overrides.trusted === false ? [] : [id],
      groups: {},
      runtime: {
        output_dir: './runs',
        llm_web_search: true,
      },
    };
  }

  function writeInspectingNpmProvider(id: string, contextPath: string): void {
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
        "import { writeFileSync } from 'node:fs';",
        'export function factory(context) {',
        `  writeFileSync(${JSON.stringify(contextPath)}, JSON.stringify(context));`,
        '  return {',
        '    id: context.id,',
        "    displayName: 'Native Provider',",
        "    tier: 'raw-search',",
        "    execution: 'inline',",
        "    envVar: 'ACME_API_KEY',",
        '    requiresApiKey: true,',
        '    async execute(query) {',
        '      return {',
        '        provider: context.id,',
        "        tier: 'raw-search',",
        '        content: `${query}:${context.config.apiKey}:${context.config.model}:${context.config.options.region}:${context.sourceOptions.suffix}`,',
        '        citations: [],',
        '        durationMs: 1,',
        '      };',
        '    },',
        '  };',
        '}',
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

    const legacyConfig = {
      version: 1,
      providers: { 'library-provider': { enabled: true } },
      customProviders: {
        'library-provider': {
          type: 'npm' as const,
          module: 'library-provider',
        },
      },
      trustedProviderIds: ['library-provider'],
    };
    const result = await node.loadCustomProviders(legacyConfig);

    expect(result.warnings).toEqual([]);
    expect(result.loadedIds).toEqual(['library-provider']);
    await expect(
      result.providers[0]?.execute('hello', { timeout: 5 }),
    ).resolves.toMatchObject({ content: 'library:hello' });
    expect(node).not.toHaveProperty('registerCustomProviders');
    expect(node).not.toHaveProperty('executeResearchRun');
  });

  it('loads real loadConfigV2 output with native mapping fidelity', async () => {
    const providerId = 'native-provider';
    const configPath = join(tmpDir, 'config.v2.json');
    const contextPath = join(tmpDir, 'factory-context.json');
    const sourceConfig = nativeConfig(providerId);
    writeInspectingNpmProvider(providerId, contextPath);
    writeFileSync(configPath, JSON.stringify(sourceConfig));
    const node = await import('../src/node-entry.js');

    const loadedConfig = node.loadConfigV2({ global_path: configPath });
    expect(loadedConfig.ok).toBe(true);
    if (!loadedConfig.ok) return;

    const converted = node.customProviderLoadConfigFromV2(loadedConfig.config);
    expect(converted).toMatchObject({
      providers: {
        [providerId]: {
          enabled: true,
          apiKey: '$ACME_API_KEY',
          model: 'fixture-model',
          options: { region: 'ca' },
        },
      },
      customProviders: {
        [providerId]: {
          type: 'npm',
          module: providerId,
          export: 'factory',
          options: { suffix: 'native' },
          executionProfile: {
            bindingId: `${providerId}.search.v1`,
            credential: { envVar: 'ACME_API_KEY' },
          },
        },
      },
      trustedProviderIds: [providerId],
    });
    expect(converted.customProviders?.[providerId]?.executionProfile).toEqual({
      bindingId: `${providerId}.search.v1`,
      profile:
        sourceConfig.custom_providers[providerId]?.execution_profile.profile,
      credential: { envVar: 'ACME_API_KEY' },
    });

    const result = await node.loadCustomProviders(loadedConfig.config);
    expect(result).toMatchObject({
      loadedIds: [providerId],
      skippedIds: [],
      warnings: [],
    });
    expect(JSON.parse(readFileSync(contextPath, 'utf8'))).toMatchObject({
      id: providerId,
      config: {
        enabled: true,
        apiKey: '$ACME_API_KEY',
        model: 'fixture-model',
        options: { region: 'ca' },
      },
      sourceOptions: { suffix: 'native' },
    });
    await expect(
      result.providers[0]?.execute('hello', { timeout: 5 }),
    ).resolves.toMatchObject({
      content: 'hello:$ACME_API_KEY:fixture-model:ca:native',
    });
  });

  it('rejects invalid native config before importing custom code', async () => {
    const providerId = 'invalid-native-provider';
    const markerPath = join(tmpDir, 'invalid-native-loaded');
    writeNpmProvider(providerId, markerPath);
    const { loadCustomProviders } = await import('../src/node-entry.js');
    const config = nativeConfig(providerId, {
      credentialEnvVar: 'not valid',
    });

    await expect(loadCustomProviders(config)).rejects.toThrow(
      /Invalid Librarium v2 configuration:.*custom_providers/,
    );
    expect(existsSync(markerPath)).toBe(false);
  });

  it('does not import disabled or untrusted custom code', async () => {
    const disabledId = 'disabled-native-provider';
    const disabledMarker = join(tmpDir, 'disabled-native-loaded');
    writeNpmProvider(disabledId, disabledMarker);
    const { loadCustomProviders } = await import('../src/node-entry.js');

    const disabled = await loadCustomProviders(
      nativeConfig(disabledId, { enabled: false }),
    );
    expect(disabled.skippedIds).toEqual([disabledId]);
    expect(disabled.warnings.join(' ')).toContain('is disabled');
    expect(existsSync(disabledMarker)).toBe(false);

    const nativeUntrustedId = 'untrusted-native-provider';
    const nativeUntrustedMarker = join(tmpDir, 'untrusted-native-loaded');
    writeNpmProvider(nativeUntrustedId, nativeUntrustedMarker);
    const nativeUntrusted = await loadCustomProviders(
      nativeConfig(nativeUntrustedId, { enabled: false, trusted: false }),
    );
    expect(nativeUntrusted.skippedIds).toEqual([nativeUntrustedId]);
    expect(existsSync(nativeUntrustedMarker)).toBe(false);

    const untrustedId = 'untrusted-provider';
    const untrustedMarker = join(tmpDir, 'untrusted-loaded');
    writeNpmProvider(untrustedId, untrustedMarker);
    const untrusted = await loadCustomProviders({
      providers: { [untrustedId]: { enabled: true } },
      customProviders: {
        [untrustedId]: { type: 'npm', module: untrustedId },
      },
      trustedProviderIds: [],
    });
    expect(untrusted.skippedIds).toEqual([untrustedId]);
    expect(untrusted.warnings.join(' ')).toContain('is not trusted');
    expect(existsSync(untrustedMarker)).toBe(false);
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
