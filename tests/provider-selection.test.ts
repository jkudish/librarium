import { describe, expect, it } from 'vitest';
import {
  ProviderSelectionError,
  providerCredentialRef,
  resolveProviderSelection,
  usableProviderIds,
} from '../src/core/provider-selection.js';
import type { Config, Provider } from '../src/types.js';

function provider(id: string, envVar: string): Provider {
  return {
    id,
    displayName: id,
    tier: 'raw-search',
    execution: 'inline',
    envVar,
    execute: async () => ({
      provider: id,
      tier: 'raw-search',
      content: '',
      citations: [],
      durationMs: 0,
    }),
  };
}

const providers = [
  provider('brave-search', 'BRAVE_API_KEY'),
  provider('exa', 'EXA_API_KEY'),
];

function config(): Config {
  return {
    version: 1,
    defaults: {
      outputDir: './agents/librarium',
      maxParallel: 6,
      timeout: 30,
      asyncTimeout: 1800,
      asyncPollInterval: 10,
      mode: 'mixed',
      llmWebSearch: true,
    },
    providers: {
      'brave-search': { enabled: true, apiKey: '$BRAVE_API_KEY' },
      exa: { enabled: true, apiKey: '$EXA_API_KEY' },
    },
    customProviders: {},
    trustedProviderIds: [],
    groups: {
      quick: ['brave-search', 'exa'],
    },
  };
}

describe('provider selection', () => {
  it('uses provider env vars when config has no explicit apiKey', () => {
    expect(providerCredentialRef(providers[0], undefined)).toBe(
      '$BRAVE_API_KEY',
    );
    expect(providerCredentialRef(providers[0], { apiKey: 'literal' })).toBe(
      'literal',
    );
  });

  it('returns only usable enabled providers', () => {
    const ids = usableProviderIds(config(), providers, {
      env: { BRAVE_API_KEY: 'brave-key' },
    });
    expect(ids).toEqual(['brave-search']);
  });

  it('skips missing-key providers for group/default selections', () => {
    const warnings: string[] = [];
    const ids = resolveProviderSelection(
      config(),
      { group: 'quick' },
      providers,
      {
        requireUsable: true,
        credentials: { env: { BRAVE_API_KEY: 'brave-key' } },
        onWarn: (message) => warnings.push(message),
      },
    );

    expect(ids).toEqual(['brave-search']);
    expect(warnings.join('\n')).toContain('exa is missing an API key');
  });

  it('fails fast when explicit providers are missing keys', () => {
    expect(() =>
      resolveProviderSelection(config(), { providers: ['exa'] }, providers, {
        requireUsable: true,
        strictExplicitCredentials: true,
        credentials: { env: {} },
      }),
    ).toThrow(ProviderSelectionError);
  });

  it('allows explicit providers with credentials even when not enabled', () => {
    const c = config();
    c.providers.exa.enabled = false;

    const ids = resolveProviderSelection(c, { providers: ['exa'] }, providers, {
      requireUsable: true,
      strictExplicitCredentials: true,
      credentials: { env: { EXA_API_KEY: 'exa-key' } },
    });

    expect(ids).toEqual(['exa']);
  });

  it('allows explicit groups to opt into credentialed disabled providers', () => {
    const c = config();
    c.providers.exa.enabled = false;

    const ids = resolveProviderSelection(c, { group: 'quick' }, providers, {
      requireUsable: true,
      credentials: {
        env: { BRAVE_API_KEY: 'brave-key', EXA_API_KEY: 'exa-key' },
      },
    });

    expect(ids).toEqual(['brave-search', 'exa']);
  });

  it('keeps default selections limited to enabled providers', () => {
    const c = config();
    c.providers.exa.enabled = false;

    const ids = resolveProviderSelection(c, {}, providers, {
      requireUsable: true,
      credentials: {
        env: { BRAVE_API_KEY: 'brave-key', EXA_API_KEY: 'exa-key' },
      },
    });

    expect(ids).toEqual(['brave-search']);
  });

  it('treats explicit comprehensive/all as opt-in to configured shared-key providers', () => {
    const c = config();
    c.providers['searchapi-chatgpt'] = {
      enabled: false,
      apiKey: '$SEARCHAPI_API_KEY',
    };
    c.providers['perplexity-sonar-pro'] = {
      enabled: false,
      apiKey: '$PERPLEXITY_API_KEY',
    };
    c.groups.comprehensive = ['searchapi-chatgpt', 'perplexity-sonar-pro'];
    c.groups.all = [...c.groups.comprehensive];
    const expandedProviders = [
      ...providers,
      provider('searchapi-chatgpt', 'SEARCHAPI_API_KEY'),
      provider('perplexity-sonar-pro', 'PERPLEXITY_API_KEY'),
    ];
    const credentials = {
      env: {
        BRAVE_API_KEY: 'brave-key',
        EXA_API_KEY: 'exa-key',
        SEARCHAPI_API_KEY: 'searchapi-key',
        PERPLEXITY_API_KEY: 'perplexity-key',
      },
    };

    for (const group of ['comprehensive', 'all']) {
      expect(
        resolveProviderSelection(c, { group }, expandedProviders, {
          requireUsable: true,
          credentials,
        }),
      ).toEqual(['searchapi-chatgpt', 'perplexity-sonar-pro']);
    }
    expect(
      resolveProviderSelection(c, {}, expandedProviders, {
        requireUsable: true,
        credentials,
      }),
    ).toEqual(['brave-search', 'exa']);
  });

  it('fails when no usable provider remains', () => {
    expect(() =>
      resolveProviderSelection(config(), {}, providers, {
        requireUsable: true,
        credentials: { env: {} },
      }),
    ).toThrow(/No usable providers selected/);
  });
});
