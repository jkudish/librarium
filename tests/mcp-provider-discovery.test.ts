import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { mapConfiguration } from '../src/core/configuration-mapping.js';
import { discoverProviders } from '../src/mcp/provider-discovery.js';
import type { Config } from '../src/types.js';

function config(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    defaults: {
      outputDir: './agents/librarium',
      maxParallel: 6,
      timeout: 30,
      asyncTimeout: 1800,
      asyncPollInterval: 10,
      mode: 'sync',
      llmWebSearch: true,
    },
    providers: {},
    customProviders: {},
    trustedProviderIds: [],
    groups: {},
    ...overrides,
  };
}

function customProfile(providerId = 'acme-provider') {
  return {
    identity: {
      provider_id: providerId,
      profile_id: 'search',
      target: { primary: { model_selection: 'not_applicable' as const } },
    },
    result_kind: 'search_results' as const,
    observation_mode: 'api_output' as const,
    corpora: ['web' as const],
    retrieval_method: 'search_endpoint' as const,
    access_mode: 'direct' as const,
    operator_id: providerId,
    invocation: 'inline' as const,
    resumability: 'none' as const,
  };
}

describe('MCP provider discovery projection', () => {
  it('preserves the no-argument summary fields and configured target offline', () => {
    const result = discoverProviders(
      config({
        providers: {
          'perplexity-deep-research': {
            enabled: true,
            model: 'openai/gpt-5.6-sol',
          },
        },
      }),
      {},
      { env: { PERPLEXITY_API_KEY: 'credential-sentinel' } },
    );
    expect(result).toEqual({ providers: expect.any(Array) });
    const provider = result.providers.find(
      (candidate) => candidate.id === 'perplexity-deep-research',
    );
    expect(provider).toMatchObject({
      id: 'perplexity-deep-research',
      name: 'Perplexity Deep Research',
      tier: 'deep-research',
      source: 'builtin',
      enabled: true,
      keyConfigured: true,
      credentialSource: 'env',
      configured: true,
      target: {
        primary: {
          model_selection: 'fixed',
          kind: 'preset',
          target_id: 'medium',
        },
        underlying: {
          model_selection: 'configurable',
          kind: 'model',
          target_id: 'openai/gpt-5.6-sol',
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('credential-sentinel');
  });

  it('matches canonical catalog identities, capabilities, workflows, and availability', () => {
    const source = config({
      providers: {
        exa: { enabled: true },
        'brave-search': { enabled: false },
        'openrouter-chat': {
          enabled: true,
          options: {
            reasoningEffort: 'high',
            reasoningMaxTokens: 100,
          },
        },
      },
    });
    const credentials = { env: { EXA_API_KEY: 'present' } };
    const result = discoverProviders(
      source,
      { detail: 'profiles' },
      credentials,
    );
    const mapped = mapConfiguration(source, {
      authoredGroups: { global: source.groups, project: {} },
      credentials,
      includeDisabledCustomProfiles: true,
    });

    expect(result.schemaVersion).toBe(1);
    expect(result.profiles).toHaveLength(mapped.catalog.resolved.length);
    for (const profile of result.profiles) {
      const canonical = mapped.catalog.get(
        profile.provider_id,
        profile.profile_id,
      );
      expect(canonical).toBeDefined();
      expect(profile.target).toEqual(canonical!.profile.identity.target);
      expect(profile.invocation).toBe(canonical!.profile.invocation);
      expect(profile.resumability).toBe(canonical!.profile.resumability);
      expect(profile.workflows).toEqual(canonical!.declaration.workflows);
      expect(profile.capabilities).toMatchObject({
        result_kind: canonical!.profile.result_kind,
        corpora: canonical!.profile.corpora,
        retrieval_method: canonical!.profile.retrieval_method,
      });
    }
    expect(
      result.profiles.find((profile) => profile.selector === 'exa/search'),
    ).toMatchObject({
      availability: { selectable: true, reasons: [] },
      credentialStatus: {
        presence: 'present',
        authentication: 'not-checked',
      },
    });
    expect(
      result.profiles.find(
        (profile) => profile.selector === 'brave-search/search',
      ),
    ).toMatchObject({
      availability: {
        selectable: false,
        reasons: ['profile_disabled', 'credential_missing'],
      },
    });
    expect(
      result.profiles.find((profile) => profile.selector === 'openrouter/chat'),
    ).toMatchObject({
      availability: {
        selectable: false,
        configuration_valid: false,
        reasons: ['credential_missing', 'configuration_invalid'],
      },
    });
  });

  it('keeps declared disabled custom profiles and undeclared custom providers truthful without executing either', () => {
    const fixtureRoot = join(
      tmpdir(),
      `librarium-discovery-${process.pid}-${crypto.randomUUID()}`,
    );
    mkdirSync(fixtureRoot, { recursive: true });
    const npmMarker = join(fixtureRoot, 'npm-imported');
    const scriptMarker = join(fixtureRoot, 'script-spawned');
    const modulePath = join(fixtureRoot, 'provider.mjs');
    const scriptPath = join(fixtureRoot, 'provider-script.mjs');
    writeFileSync(
      modulePath,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(npmMarker)}, 'imported');`,
        'export default {};',
      ].join('\n'),
    );
    writeFileSync(
      scriptPath,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(scriptMarker)}, 'spawned');`,
      ].join('\n'),
    );
    const secret = 'literal-secret-sentinel';
    const source = config({
      providers: {
        'acme-adapter': { enabled: false, apiKey: 'keychain:acme' },
        'undeclared-adapter': { enabled: true, apiKey: secret },
        'untrusted-adapter': { enabled: true },
        'invalid-adapter': { enabled: true },
      },
      customProviders: {
        'acme-adapter': {
          type: 'script',
          command: process.execPath,
          args: [scriptPath, secret],
          executionProfile: {
            bindingId: 'acme.search.v1',
            profile: customProfile(),
            credential: { envVar: 'ACME_API_KEY' },
          },
        },
        'undeclared-adapter': {
          type: 'npm',
          module: modulePath,
          options: { secret },
        },
        'untrusted-adapter': {
          type: 'npm',
          module: modulePath,
          executionProfile: {
            bindingId: 'untrusted.search.v1',
            profile: customProfile('untrusted-provider'),
          },
        },
        'invalid-adapter': {
          type: 'npm',
          module: modulePath,
          executionProfile: {
            bindingId: 'invalid.search.v1',
            profile: customProfile('exa'),
          },
        },
      },
      trustedProviderIds: [
        'acme-adapter',
        'undeclared-adapter',
        'invalid-adapter',
      ],
    });

    const filesBefore = readdirSync(fixtureRoot);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const resolveCredential = vi.fn(() => secret);
    try {
      const result = discoverProviders(
        source,
        { detail: 'profiles' },
        { env: {}, resolveCredential },
      );
      const acme = result.profiles.find(
        (profile) => profile.selector === 'acme-provider/search',
      );
      expect(acme).toMatchObject({
        source: 'trusted_custom_declaration',
        credentialStatus: {
          requirement: 'required',
          presence: 'unknown',
          source: 'keychain',
          authentication: 'not-checked',
        },
        availability: {
          selectable: false,
          reasons: ['profile_disabled', 'credential_status_unknown'],
        },
      });
      expect(
        result.providers.find(
          (provider) => provider.id === 'undeclared-adapter',
        ),
      ).toMatchObject({
        tier: 'unknown',
        credentialStatus: { requirement: 'unknown', presence: 'unknown' },
        planningStatus: 'unplannable',
        reasons: ['custom_profile_declaration_missing'],
      });
      expect(
        result.providers.find(
          (provider) => provider.id === 'untrusted-adapter',
        ),
      ).toMatchObject({
        planningStatus: 'unplannable',
        reasons: ['custom_provider_untrusted'],
      });
      expect(
        result.providers.find((provider) => provider.id === 'invalid-adapter'),
      ).toMatchObject({
        planningStatus: 'unplannable',
        reasons: ['custom_provider_profile_provider_id_reserved'],
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(fixtureRoot);
      expect(serialized).not.toMatch(
        /ACME_API_KEY|command|module|args|options/,
      );
      expect(readdirSync(fixtureRoot)).toEqual(filesBefore);
      expect(existsSync(npmMarker)).toBe(false);
      expect(existsSync(scriptMarker)).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(resolveCredential).not.toHaveBeenCalled();

      const importControl = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `await import(${JSON.stringify(pathToFileURL(modulePath).href)})`,
        ],
        { encoding: 'utf8' },
      );
      const scriptControl = spawnSync(process.execPath, [scriptPath], {
        encoding: 'utf8',
      });
      expect(importControl).toMatchObject({ status: 0, stderr: '' });
      expect(scriptControl).toMatchObject({ status: 0, stderr: '' });
      expect(existsSync(npmMarker)).toBe(true);
      expect(existsSync(scriptMarker)).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('does not inherit custom issue reasons from adapter-id prefixes', () => {
    const source = config({
      providers: {
        acme: { enabled: true },
        'acme-other': { enabled: true },
      },
      customProviders: {
        acme: { type: 'npm', module: 'acme' },
        'acme-other': {
          type: 'npm',
          module: 'acme-other',
          executionProfile: {
            bindingId: 'acme-other.search.v1',
            profile: customProfile('exa'),
          },
        },
      },
      trustedProviderIds: ['acme', 'acme-other'],
    });

    const result = discoverProviders(source, { provider: 'acme' });
    expect(result.providers).toEqual([
      expect.objectContaining({
        id: 'acme',
        reasons: ['custom_profile_declaration_missing'],
      }),
    ]);
  });

  it('returns stable secret-insensitive revisions that change with public facts', () => {
    const first = config({
      providers: { exa: { enabled: true, apiKey: 'secret-one' } },
    });
    const second = config({
      providers: { exa: { enabled: true, apiKey: 'secret-two' } },
    });
    const changed = config({
      providers: { exa: { enabled: false, apiKey: 'secret-two' } },
    });
    const revision = (value: Config) =>
      discoverProviders(value, { detail: 'profiles' }, { env: {} })
        .catalogRevision;

    expect(revision(first)).toBe(revision(second));
    expect(revision(changed)).not.toBe(revision(second));
    expect(
      JSON.stringify(discoverProviders(first, { detail: 'profiles' })),
    ).not.toContain('secret-one');
  });

  it.each([
    {
      name: 'whitespace in an environment reference',
      apiKey: '$ EXA_API_KEY ',
      env: { EXA_API_KEY: 'must-not-match-trimmed-name' },
      source: 'env',
    },
    {
      name: 'an empty keychain reference',
      apiKey: 'keychain:',
      env: {},
      source: 'keychain',
    },
    {
      name: 'an inherited environment property',
      apiKey: '$EXA_API_KEY',
      env: Object.create({ EXA_API_KEY: 'must-not-use-prototype' }) as Record<
        string,
        string
      >,
      source: 'env',
    },
  ])(
    'matches canonical missing-credential availability for $name',
    (fixture) => {
      const source = config({
        providers: { exa: { enabled: true, apiKey: fixture.apiKey } },
      });
      const credentials = { env: fixture.env };
      const discovery = discoverProviders(
        source,
        { provider: 'exa', detail: 'profiles' },
        credentials,
      );
      const canonical = mapConfiguration(source, {
        authoredGroups: { global: source.groups, project: {} },
        credentials,
      }).catalog.get('exa', 'search');
      const profile = discovery.profiles.find(
        (candidate) => candidate.selector === 'exa/search',
      );

      expect(canonical).toBeDefined();
      expect(discovery.providers).toEqual([
        expect.objectContaining({
          id: 'exa',
          keyConfigured: false,
          credentialStatus: {
            requirement: 'required',
            presence: 'missing',
            source: fixture.source,
            authentication: 'not-checked',
          },
          planningStatus: 'unavailable',
          reasons: canonical!.availability.reasons,
        }),
      ]);
      expect(profile).toMatchObject({
        credentialStatus: {
          presence: 'missing',
          source: fixture.source,
          authentication: 'not-checked',
        },
        availability: {
          selectable: canonical!.availability.selectable,
          reasons: canonical!.availability.reasons,
        },
      });
    },
  );

  it('filters by adapter or canonical provider and rejects unknown filters', () => {
    const source = config({
      providers: { 'acme-adapter': { enabled: true } },
      customProviders: {
        'acme-adapter': {
          type: 'npm',
          module: 'must-not-load',
          executionProfile: {
            bindingId: 'acme.search.v1',
            profile: customProfile(),
          },
        },
      },
      trustedProviderIds: ['acme-adapter'],
    });
    const adapter = discoverProviders(source, {
      provider: 'openrouter-online',
      detail: 'profiles',
    });
    expect(adapter.providers.map((provider) => provider.id)).toEqual([
      'openrouter-online',
    ]);
    expect(adapter.profiles.map((profile) => profile.selector)).toEqual([
      'openrouter/grounded',
    ]);

    const canonical = discoverProviders(source, {
      provider: 'openrouter',
      detail: 'profiles',
    });
    expect(canonical.providers.map((provider) => provider.id)).toEqual([
      'openrouter-online',
      'openrouter-chat',
    ]);
    expect(canonical.profiles.map((profile) => profile.selector)).toEqual([
      'openrouter/grounded',
      'openrouter/chat',
    ]);

    const customSummary = discoverProviders(source, {
      provider: 'acme-provider',
    });
    expect(customSummary).toEqual({
      providers: [expect.objectContaining({ id: 'acme-adapter' })],
    });
    const customCanonical = discoverProviders(source, {
      provider: 'acme-provider',
      detail: 'profiles',
    });
    expect(customCanonical.providers.map((provider) => provider.id)).toEqual([
      'acme-adapter',
    ]);
    expect(customCanonical.profiles.map((profile) => profile.selector)).toEqual(
      ['acme-provider/search'],
    );
    const customAdapter = discoverProviders(source, {
      provider: 'acme-adapter',
      detail: 'profiles',
    });
    expect(customAdapter.providers.map((provider) => provider.id)).toEqual([
      'acme-adapter',
    ]);
    expect(customAdapter.profiles.map((profile) => profile.selector)).toEqual([
      'acme-provider/search',
    ]);
    expect(() =>
      discoverProviders(source, { provider: 'not-a-provider' }),
    ).toThrow('Unknown provider filter');
  });
});
