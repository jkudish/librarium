import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/types.js';

const state = vi.hoisted(() => ({
  events: [] as string[],
  rejectPreflight: false,
  rejectRegistration: false,
  stripProjectedFallback: false,
  dispatchedConfig: undefined as Config | undefined,
  initializeArgs: undefined as unknown,
  spinner: {
    isSpinning: false,
    start: undefined as unknown,
    stop: undefined as unknown,
    fail: undefined as unknown,
  },
}));

const fixtureConfig: Config = {
  version: 1,
  defaults: {
    outputDir: './agents/librarium',
    maxParallel: 2,
    timeout: 30,
    asyncTimeout: 1800,
    asyncPollInterval: 10,
    mode: 'mixed',
    llmWebSearch: true,
  },
  providers: {
    'legacy-provider': { enabled: true, fallback: 'incompatible-fallback' },
    'incompatible-fallback': { enabled: false },
  },
  customProviders: {},
  trustedProviderIds: [],
  groups: {},
};

vi.mock('../src/core/config.js', () => ({
  loadConfig: () => {
    state.events.push('load-global');
    return fixtureConfig;
  },
  loadProjectConfig: () => {
    state.events.push('load-project');
    return null;
  },
  mergeConfigs: () => {
    state.events.push('merge');
    return fixtureConfig;
  },
}));

vi.mock('ora', () => ({ default: () => state.spinner }));

vi.mock('../src/node-request-preflight.js', () => {
  class RequestPreflightError extends Error {}
  return {
    RequestPreflightError,
    preflightProductionRequest: () => {
      state.events.push('preflight');
      if (state.rejectPreflight) throw new RequestPreflightError('bad request');
      return {
        credentials: { env: {} },
        notices: [],
        admittedAdapterIds: ['legacy-provider', 'fallback-provider'],
        prepared: {
          request: {
            slots: [
              {
                primary: {
                  identity: {
                    provider_id: 'legacy-provider',
                    profile_id: 'search',
                  },
                },
              },
            ],
          },
          profile_plans_by_identity: {
            '["legacy-provider","search","not_applicable",null,null,null,null,null]':
              {
                binding: { adapter_id: 'legacy-provider' },
              },
            '["fallback-provider","search","not_applicable",null,null,null,null,null]':
              {
                binding: { adapter_id: 'fallback-provider' },
              },
          },
        },
      };
    },
    emitRequestPreflightNotices: () => state.events.push('notices'),
    legacyPrimaryAdapterIds: () => ['legacy-provider'],
    projectLegacyExecutionConfig: (config: Config) =>
      state.stripProjectedFallback
        ? {
            ...config,
            providers: {
              ...config.providers,
              'legacy-provider': { enabled: true },
            },
          }
        : config,
    assertAdmittedAdaptersRegistered: () => {
      state.events.push('registered');
      if (state.rejectRegistration)
        throw new RequestPreflightError('missing fallback');
    },
  };
});

vi.mock('../src/adapters/node-registry.js', () => ({
  getAllProviders: () => [{ id: 'legacy-provider', tier: 'raw-search' }],
  initializeProviders: async (...args: unknown[]) => {
    state.events.push('initialize');
    state.initializeArgs = args;
    return {
      warnings: [],
      loadedCustomProviders: [],
      skippedCustomProviders: [],
    };
  },
}));

vi.mock('../src/core/provider-selection.js', () => {
  class ProviderSelectionError extends Error {}
  return {
    ProviderSelectionError,
    retiredProviderSelectionIssues: () => [],
    assertNoRetiredProviderSelectionTokens: () => {},
    resolveProviderSelection: () => [],
  };
});

vi.mock('../src/core/prompt-builder.js', () => ({
  generateSlug: () => 'fixture-slug',
  resolveOutputDir: () => '/tmp/unused-cli-output',
}));

vi.mock('../src/node-run-directory.js', () => ({
  createRunDir: () => {
    state.events.push('run-dir');
    return '/tmp/unused-mcp-output';
  },
}));

vi.mock('../src/core/research-run.js', () => ({
  executeResearchRun: async (request: { config: Config }) => {
    state.events.push('dispatch');
    state.dispatchedConfig = request.config;
    return {
      manifest: {
        providers: [],
        sources: { total: 0, unique: 0, file: 'sources.json' },
        exitCode: 0,
      },
      reports: [],
      results: [],
      sources: [],
      totalCitations: 0,
      totalDurationMs: 0,
    };
  },
}));

import { executeRun } from '../src/commands/run.js';
import { ResearchInputError, runResearchSilent } from '../src/mcp/research.js';

describe('production request preflight transport ordering', () => {
  beforeEach(() => {
    state.events.length = 0;
    state.rejectPreflight = false;
    state.rejectRegistration = false;
    state.stripProjectedFallback = false;
    state.dispatchedConfig = undefined;
    state.initializeArgs = undefined;
    state.spinner.isSpinning = false;
    state.spinner.start = vi.fn(() => {
      state.events.push('spinner-start');
      state.spinner.isSpinning = true;
      return state.spinner;
    });
    state.spinner.stop = vi.fn(() => {
      state.events.push('spinner-stop');
      state.spinner.isSpinning = false;
      return state.spinner;
    });
    state.spinner.fail = vi.fn(() => {
      state.events.push('spinner-fail');
      state.spinner.isSpinning = false;
      return state.spinner;
    });
    process.exitCode = undefined;
  });

  it('stops CLI invalid requests before initialization, selection, refinement, files, or dispatch', async () => {
    state.rejectPreflight = true;

    const outcome = await executeRun('private query', { json: true });

    expect(outcome).toEqual({ exitCode: 2 });
    expect(state.events.slice(0, 11)).toEqual([
      'spinner-start',
      'load-global',
      'load-project',
      'merge',
      'preflight',
      'spinner-fail',
    ]);
  });

  it('initializes every admitted custom adapter and uses the canonical projection', async () => {
    const outcome = await executeRun('private query', { json: true });

    expect(outcome).toEqual({
      exitCode: 0,
      outputDir: '/tmp/unused-cli-output',
    });
    expect(state.events.slice(0, 11)).toEqual([
      'spinner-start',
      'load-global',
      'load-project',
      'merge',
      'preflight',
      'notices',
      'initialize',
      'registered',
      'spinner-stop',
      'spinner-start',
      'dispatch',
    ]);
    expect(state.events).not.toContain('legacy-selection');
    expect(state.initializeArgs).toEqual([
      expect.objectContaining({ credentials: { env: {} } }),
      { customProviderIds: ['legacy-provider', 'fallback-provider'] },
    ]);
  });

  it('stops CLI after a missing fallback registration before files or dispatch', async () => {
    state.rejectRegistration = true;

    const outcome = await executeRun('private query', { json: true });

    expect(outcome).toEqual({ exitCode: 2 });
    expect(state.events).toEqual([
      'spinner-start',
      'load-global',
      'load-project',
      'merge',
      'preflight',
      'notices',
      'initialize',
      'registered',
      'spinner-fail',
    ]);
  });

  it('passes the projected config, not a raw incompatible fallback, to CLI dispatch', async () => {
    state.stripProjectedFallback = true;

    const outcome = await executeRun('private query', { json: true });

    expect(outcome.exitCode).toBe(0);
    expect(fixtureConfig.providers['legacy-provider']?.fallback).toBe(
      'incompatible-fallback',
    );
    expect(
      state.dispatchedConfig?.providers['legacy-provider']?.fallback,
    ).toBeUndefined();
  });

  it('maps MCP preflight rejection to the existing input-error path before initialization or run files', async () => {
    state.rejectPreflight = true;

    await expect(
      runResearchSilent(
        { query: 'private query' },
        { loadMergedConfig: () => fixtureConfig, onWarn: () => {} },
      ),
    ).rejects.toBeInstanceOf(ResearchInputError);

    expect(state.events).toEqual(['preflight']);
  });

  it('accepts a no-op injected initializer only with its declared registered adapters', async () => {
    const result = await runResearchSilent(
      { query: 'private query' },
      {
        loadMergedConfig: () => fixtureConfig,
        initialize: async () => {
          state.events.push('injected-initialize');
          return {
            warnings: [],
            loadedCustomProviders: [],
            skippedCustomProviders: [],
          };
        },
        registeredAdapterIds: () => ['legacy-provider', 'fallback-provider'],
        onWarn: () => {},
      },
    );

    expect(result.manifest.exitCode).toBe(0);
    expect(state.events).toEqual([
      'preflight',
      'notices',
      'injected-initialize',
      'registered',
      'run-dir',
      'dispatch',
    ]);
  });

  it('maps a missing MCP fallback registration to input error before run files or dispatch', async () => {
    state.rejectRegistration = true;

    await expect(
      runResearchSilent(
        { query: 'private query' },
        {
          loadMergedConfig: () => fixtureConfig,
          registeredAdapterIds: () => ['legacy-provider'],
          onWarn: () => {},
        },
      ),
    ).rejects.toBeInstanceOf(ResearchInputError);

    expect(state.events).toEqual([
      'preflight',
      'notices',
      'initialize',
      'registered',
    ]);
  });
});
