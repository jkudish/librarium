import { describe, expect, it, vi } from 'vitest';
import {
  assertAdmittedAdaptersRegistered,
  assertPreparedResearchResponseProjectable,
  emitRequestPreflightNotices,
  formatRequestDiagnosticCodes,
  preflightProductionRequest,
  preflightProductionRequestStructure,
  RequestPreflightError,
} from '../src/node-request-preflight.js';
import type { Config } from '../src/types.js';

function config(overrides: Partial<Config> = {}): Config {
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
    providers: { exa: { enabled: true } },
    customProviders: {},
    trustedProviderIds: [],
    groups: {},
    ...overrides,
  };
}

function request(source: Config, group?: string) {
  return {
    config: source,
    transport: {
      kind: 'cli' as const,
      input: {
        query: 'private query text',
        ...(group === undefined ? { providers: ['exa'] } : { group }),
      },
    },
  };
}

describe('Node production request preflight', () => {
  it('uses quick plus sync for omitted CLI and MCP preferences without widening selection', () => {
    const source = config({
      providers: {
        exa: { enabled: true },
        'brave-answers': { enabled: true },
        tavily: { enabled: true },
      },
    });
    const createCredentials = () => ({
      env: {
        EXA_API_KEY: 'present',
        BRAVE_ANSWERS_API_KEY: 'present',
        TAVILY_API_KEY: 'present',
      },
    });

    for (const kind of ['cli', 'silent_mcp'] as const) {
      const result = preflightProductionRequest(
        {
          config: source,
          transport: { kind, input: { query: 'first run' } },
        },
        { createCredentials },
      );
      expect(result.prepared.request.mode).toBe('sync');
      expect(
        result.prepared.request.slots.map(
          (slot) =>
            `${slot.primary.identity.provider_id}/${slot.primary.identity.profile_id}`,
        ),
      ).toEqual(['brave-answers/grounded', 'exa/search']);
      expect(result.admittedAdapterIds).not.toContain('tavily');
    }
  });

  it('rejects structural input before constructing credentials', () => {
    const createCredentials = vi.fn(() => ({ env: {} }));

    expect(() =>
      preflightProductionRequest(request(config(), '__unknown_group__'), {
        createCredentials,
      }),
    ).toThrow(RequestPreflightError);

    expect(createCredentials).not.toHaveBeenCalled();
  });

  it('structurally admits all SearchAPI surfaces without reading credentials', () => {
    const profiles = [
      'searchapi-chatgpt/surface',
      'searchapi-gemini/surface',
      'searchapi-perplexity/surface',
      'searchapi-google-ai-mode/surface',
      'searchapi-bing-copilot/surface',
      'searchapi-google-ai-overview/surface',
    ];
    const result = preflightProductionRequestStructure({
      config: config({
        providers: Object.fromEntries(
          profiles.map((profile) => [
            profile.replace('/surface', ''),
            { enabled: true },
          ]),
        ),
      }),
      transport: {
        kind: 'cli',
        input: { query: 'surface observations', providers: profiles },
      },
    });

    expect(result.prepared.request.slots).toHaveLength(6);
    expect(
      result.prepared.request.slots.map((slot) => slot.primary.result_kind),
    ).toEqual(Array(6).fill('surface_observation'));
  });

  it('rejects a future unprojectable profile at the structural boundary', () => {
    const result = preflightProductionRequestStructure(request(config()));
    const prepared = structuredClone(result.prepared);
    prepared.request.slots[0]!.primary.result_kind = 'future_result' as never;

    expect(() => assertPreparedResearchResponseProjectable(prepared)).toThrow(
      /profile_not_projectable/,
    );
  });

  it('rejects an invalid mode before constructing credentials', () => {
    const createCredentials = vi.fn(() => ({ env: {} }));

    expect(() =>
      preflightProductionRequest(
        {
          config: config(),
          transport: {
            kind: 'cli',
            input: {
              query: 'bad mode',
              providers: ['exa'],
              mode: 'invalid' as never,
            },
          },
        },
        { createCredentials },
      ),
    ).toThrow(RequestPreflightError);

    expect(createCredentials).not.toHaveBeenCalled();
  });

  it('rejects an invalid configured request deadline before constructing credentials', () => {
    const createCredentials = vi.fn(() => ({ env: {} }));

    expect(() =>
      preflightProductionRequest(
        request(
          config({
            defaults: {
              ...config().defaults,
              requestDeadlineMs: 299_999,
            },
          }),
        ),
        { createCredentials },
      ),
    ).toThrow(/configuration_request_deadline_less_than_attempt_deadline/);

    expect(createCredentials).not.toHaveBeenCalled();
  });

  it('checks a keychain-backed credential only after structural admission', () => {
    const resolveCredential = vi.fn((value: string) =>
      value === 'keychain:EXA_API_KEY' ? 'present' : undefined,
    );
    const createCredentials = vi.fn(() => ({ resolveCredential }));

    const result = preflightProductionRequest(
      request(
        config({
          providers: { exa: { enabled: true, apiKey: 'keychain:EXA_API_KEY' } },
        }),
      ),
      { createCredentials },
    );

    expect(result.admittedAdapterIds).toEqual(['exa']);
    expect(createCredentials).toHaveBeenCalledTimes(1);
    expect(resolveCredential).toHaveBeenCalledWith('keychain:EXA_API_KEY');
  });

  it('rejects a missing credential before provider initialization can begin', () => {
    const createCredentials = vi.fn(() => ({ env: {} }));

    expect(() =>
      preflightProductionRequest(request(config()), { createCredentials }),
    ).toThrow(/profile_uncredentialed/);

    expect(createCredentials).toHaveBeenCalledTimes(1);
  });

  it('rejects an explicitly disabled target before it reads credentials', () => {
    const createCredentials = vi.fn(() => ({
      env: { EXA_API_KEY: 'present' },
    }));

    expect(() =>
      preflightProductionRequest(
        request(config({ providers: { exa: { enabled: false } } })),
        { createCredentials },
      ),
    ).toThrow(/profile_disabled/);

    expect(createCredentials).not.toHaveBeenCalled();
  });

  it('excludes disabled members from an admitted group before runtime setup', () => {
    const result = preflightProductionRequest(
      request(
        config({
          providers: {
            exa: { enabled: true },
            'brave-search': { enabled: false },
          },
          groups: { focused: ['exa', 'brave-search'] },
        }),
        'focused',
      ),
      { createCredentials: () => ({ env: { EXA_API_KEY: 'present' } }) },
    );

    expect(result.prepared.request.slots).toHaveLength(1);
    expect(result.admittedAdapterIds).toEqual(['exa']);
  });

  it('defers default async mode admission until missing credentials are excluded', () => {
    const createCredentials = vi.fn(() => ({
      env: { OPENAI_API_KEY: 'present' },
    }));

    const result = preflightProductionRequest(
      {
        config: config({
          defaults: {
            ...config().defaults,
            mode: 'async',
          },
          providers: {
            exa: { enabled: true },
            'openai-research': { enabled: true },
          },
        }),
        transport: {
          kind: 'cli',
          input: { query: 'durable only', group: 'deep', mode: 'async' },
        },
      },
      { createCredentials },
    );

    expect(createCredentials).toHaveBeenCalledTimes(1);
    expect(result.admittedAdapterIds).toEqual(['openai-research']);
  });

  it('rejects an explicit inline async target in the credential-aware phase', () => {
    const createCredentials = vi.fn(() => ({
      env: { EXA_API_KEY: 'present' },
    }));

    expect(() =>
      preflightProductionRequest(
        {
          config: config(),
          transport: {
            kind: 'cli',
            input: {
              query: 'inline cannot be async',
              providers: ['exa'],
              mode: 'async',
            },
          },
        },
        { createCredentials },
      ),
    ).toThrow(/async_requires_durable_profile/);

    expect(createCredentials).toHaveBeenCalledTimes(1);
  });

  it('defers default hard-budget admission until unavailable profiles are removed', () => {
    const createCredentials = vi.fn(() => ({
      env: { BRAVE_API_KEY: 'present' },
    }));

    const result = preflightProductionRequest(
      {
        config: config({
          defaults: {
            ...config().defaults,
            maxEstimatedCostUsd: 1,
          },
          providers: {
            exa: { enabled: true },
            'brave-search': { enabled: true },
          },
        }),
        transport: {
          kind: 'cli',
          input: { query: 'budgeted workflow', group: 'all' },
        },
      },
      { createCredentials },
    );

    expect(createCredentials).toHaveBeenCalledTimes(1);
    expect(result.admittedAdapterIds).toEqual(['brave-search']);
  });

  it('defers default deadline derivation until unavailable profiles are removed', () => {
    const createCredentials = vi.fn(() => ({
      env: { OPENAI_API_KEY: 'present' },
    }));

    const result = preflightProductionRequest(
      {
        config: config({
          defaults: {
            ...config().defaults,
            mode: 'async',
            maxParallel: 1,
            asyncTimeout: 259_200,
          },
          providers: {
            'openai-research': { enabled: true },
            'gemini-deep': { enabled: true },
            'perplexity-sonar-deep': { enabled: true },
          },
        }),
        transport: {
          kind: 'cli',
          input: {
            query: 'deadline workflow',
            group: 'deep',
            mode: 'async',
          },
        },
      },
      { createCredentials },
    );

    expect(createCredentials).toHaveBeenCalledTimes(1);
    expect(result.admittedAdapterIds).toEqual(['openai-research']);
  });

  it('requires admitted fallback adapters to register before execution', () => {
    const result = preflightProductionRequest(
      request(
        config({
          providers: {
            exa: { enabled: true, fallback: 'brave-search' },
            'brave-search': { enabled: true },
          },
        }),
      ),
      {
        createCredentials: () => ({
          env: { EXA_API_KEY: 'present', BRAVE_API_KEY: 'present' },
        }),
      },
    );

    expect(result.admittedAdapterIds).toEqual(['exa', 'brave-search']);
    expect(() =>
      assertAdmittedAdaptersRegistered(result.prepared, ['exa']),
    ).toThrow(/brave-search/);
  });

  it('keeps emitted notices bounded and free of request content', () => {
    const warnings: string[] = [];
    emitRequestPreflightNotices(
      [
        {
          code: 'legacy_mixed_mode_migrated',
          phase: 'migration',
          path: '/mode',
          message: 'private query text',
        },
      ],
      (message) => warnings.push(message),
    );

    expect(warnings).toEqual([
      '[librarium] preflight: notices=1 notices_codes=legacy_mixed_mode_migrated',
    ]);
    expect(warnings.join()).not.toContain('private query text');
  });

  it('deduplicates diagnostic codes while retaining the occurrence count', () => {
    expect(
      formatRequestDiagnosticCodes('issues', [
        { code: 'duplicate_code' },
        { code: 'duplicate_code' },
        { code: 'other_code' },
      ]),
    ).toBe('issues=3 issues_codes=duplicate_code,other_code');
  });
});
