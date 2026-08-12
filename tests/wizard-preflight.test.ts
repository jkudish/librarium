import { describe, expect, it, vi } from 'vitest';
import { hasWizardSynthesisClient } from '../src/commands/wizard.js';
import type { Config } from '../src/types.js';

function config(): Config {
  return {
    version: 1,
    defaults: {
      outputDir: './agents/librarium',
      maxParallel: 2,
      timeout: 30,
      asyncTimeout: 300,
      asyncPollInterval: 5,
      mode: 'sync',
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

describe('wizard preflight credential UX', () => {
  it('recognizes a keychain-backed synthesis client after admission', () => {
    const resolveCredential = vi.fn((reference: string) =>
      reference === 'keychain:OPENAI_API_KEY' ? 'keychain-key' : undefined,
    );

    expect(hasWizardSynthesisClient(config(), { resolveCredential })).toBe(
      true,
    );
    expect(resolveCredential).toHaveBeenCalledWith('keychain:OPENAI_API_KEY');
  });
});
