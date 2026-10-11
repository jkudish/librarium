import { describe, expect, it } from 'vitest';
import { initConfigToSave, planInitProviders } from '../src/commands/init.js';
import { computeInitProviderChoices } from '../src/constants.js';
import type { Config } from '../src/types.js';

const SEARCHAPI_ENV = { SEARCHAPI_API_KEY: 'searchapi-test' };
const SURFACES = [
  'searchapi-chatgpt',
  'searchapi-gemini',
  'searchapi-google-ai-mode',
  'searchapi-bing-copilot',
  'searchapi-google-ai-overview',
];

/** Opt-in providers that share PARALLEL_API_KEY, derived from descriptors. */
const PARALLEL_ENV = { PARALLEL_API_KEY: 'parallel-test' };
const parallelOptIn = computeInitProviderChoices(PARALLEL_ENV)
  .filter(({ envVar, isOptIn }) => envVar === 'PARALLEL_API_KEY' && isOptIn)
  .map(({ id }) => id);

function plan(input: Partial<Parameters<typeof planInitProviders>[0]> = {}) {
  return planInitProviders({
    providers: {},
    customProviderIds: [],
    env: SEARCHAPI_ENV,
    auto: false,
    enable: [],
    ...input,
  });
}

describe('init --auto and --enable', () => {
  it('enables SearchAPI search and every surface when SEARCHAPI_API_KEY is set (#4856)', () => {
    const result = plan({ auto: true });
    for (const id of ['searchapi', ...SURFACES]) {
      expect(result.providers[id]).toEqual({
        apiKey: '$SEARCHAPI_API_KEY',
        enabled: true,
      });
    }
    expect(result.lines).not.toContainEqual(expect.stringContaining('opt-in'));
    // Without the key, --auto enables none of them.
    const withoutKey = plan({ auto: true, env: {} });
    for (const id of ['searchapi', ...SURFACES]) {
      expect(withoutKey.providers[id]).toBeUndefined();
    }
  });

  it('keeps opt-in providers disabled under --auto and names the enable command', () => {
    expect(parallelOptIn).toContain('parallel-research');
    const result = plan({ auto: true, env: PARALLEL_ENV });
    for (const id of parallelOptIn) {
      expect(result.providers[id]).toBeUndefined();
      expect(result.lines).toContainEqual(
        expect.stringContaining(
          `(enable with \`librarium init --enable ${id}\`)`,
        ),
      );
    }
  });

  it('enables explicitly requested opt-in providers and keeps their settings', () => {
    const result = plan({
      env: PARALLEL_ENV,
      providers: {
        'parallel-research': { options: { processor: 'ultra' } },
      },
      enable: parallelOptIn,
    });
    expect(result.unknown).toEqual([]);
    expect(result.enabledCount).toBe(parallelOptIn.length);
    expect(result.providers['parallel-research']).toEqual({
      options: { processor: 'ultra' },
      apiKey: '$PARALLEL_API_KEY',
      enabled: true,
    });
    // --enable alone does not auto-discover anything else.
    expect(result.providers.searchapi).toBeUndefined();
  });

  it('keeps an existing credential reference', () => {
    const result = plan({
      providers: { 'searchapi-gemini': { apiKey: '$MY_SEARCHAPI_KEY' } },
      enable: ['searchapi-gemini'],
    });
    expect(result.providers['searchapi-gemini']).toEqual({
      apiKey: '$MY_SEARCHAPI_KEY',
      enabled: true,
    });
  });

  it('says which key is still needed when enabling without one', () => {
    const result = plan({ env: {}, enable: ['searchapi-bing-copilot'] });
    expect(result.providers['searchapi-bing-copilot']?.enabled).toBe(true);
    expect(result.lines).toContainEqual(
      expect.stringContaining('set SEARCHAPI_API_KEY before running it'),
    );
  });

  it('reports unknown ids instead of writing them', () => {
    const result = plan({ enable: ['not-a-provider', 'searchapi-chatgpt'] });
    expect(result.unknown).toEqual(['not-a-provider']);
  });

  it('enables a configured custom provider', () => {
    const result = plan({ customProviderIds: ['acme'], enable: ['acme'] });
    expect(result.providers.acme).toEqual({ enabled: true });
  });

  it('persists only authored groups', () => {
    const existing = {
      version: 1,
      defaults: {},
      providers: {},
      customProviders: {},
      trustedProviderIds: [],
      groups: { 'custom:mine': ['exa'] },
    } as unknown as Config;
    const saved = initConfigToSave(existing, {
      providers: { exa: { enabled: true } },
    });
    expect(saved.groups).toEqual({ 'custom:mine': ['exa'] });
    expect(saved.providers).toEqual({ exa: { enabled: true } });
  });
});
