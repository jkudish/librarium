import { describe, expect, it } from 'vitest';
import {
  firstQueryGuidance,
  reusableCredentialRef,
} from '../src/commands/onboarding.js';
import type { Config, Provider } from '../src/types.js';

function provider(id: string, envVar: string): Provider {
  return {
    id,
    displayName: id,
    tier: 'llm',
    execution: 'inline',
    envVar,
    execute: async () => ({
      provider: id,
      tier: 'llm',
      content: '',
      citations: [],
      durationMs: 0,
    }),
  };
}

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
      'openai-research': {
        enabled: true,
        apiKey: 'keychain:OPENAI_API_KEY',
      },
    },
    customProviders: {},
    trustedProviderIds: [],
    groups: {},
  };
}

describe('onboarding credential reuse', () => {
  it('reuses keychain-backed credentials across providers that share an env var', () => {
    const selected = [
      provider('openai-research', 'OPENAI_API_KEY'),
      provider('openai-chat', 'OPENAI_API_KEY'),
    ];

    const ref = reusableCredentialRef(config(), selected, 'OPENAI_API_KEY', {
      resolveCredential: (value) =>
        value === 'keychain:OPENAI_API_KEY' ? 'openai-key' : undefined,
    });

    expect(ref).toBe('keychain:OPENAI_API_KEY');
  });

  it('does not invent an env ref when no shared credential is available', () => {
    const selected = [provider('openai-chat', 'OPENAI_API_KEY')];

    const ref = reusableCredentialRef(
      { ...config(), providers: {} },
      selected,
      'OPENAI_API_KEY',
      { env: {} },
    );

    expect(ref).toBeUndefined();
  });
});

describe('onboarding first-query guidance', () => {
  it('shows the guided wizard and a direct first query command', () => {
    expect(firstQueryGuidance()).toContain('librarium`');
    expect(firstQueryGuidance()).toContain(
      'librarium run "compare flutter vs react native"',
    );
  });

  it('includes a provider flag when a usable provider is known', () => {
    expect(firstQueryGuidance('brave-search')).toContain('-p brave-search');
  });

  it('uses the answer command when synthesis is available', () => {
    expect(firstQueryGuidance('perplexity-sonar-pro', true)).toContain(
      'librarium answer "compare flutter vs react native" -p perplexity-sonar-pro',
    );
  });
});
