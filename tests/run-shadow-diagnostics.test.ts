import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/types.js';

const state = vi.hoisted(() => ({
  events: [] as string[],
  shadowInput: undefined as unknown,
  selectionError: true,
  dispatchInput: undefined as unknown,
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
  providers: {},
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
  configGroupProvenance: () => ({
    global: { authored: ['legacy-provider'] },
    project: {},
  }),
}));

vi.mock('../src/node-shadow-diagnostics.js', () => ({
  emitProductionShadowDiagnostic: (
    input: unknown,
    onWarn: (message: string) => void,
  ) => {
    state.events.push('shadow');
    state.shadowInput = input;
    onWarn('[librarium] shadow: issues=1 issues_codes=fixture');
  },
}));

vi.mock('../src/node-credentials.js', () => ({
  createNodeCredentialContext: () => {
    state.events.push('keychain-credentials');
    return { env: {} };
  },
}));

vi.mock('../src/adapters/node-registry.js', () => ({
  getAllProviders: () => [],
  initializeProviders: async () => {
    state.events.push('initialize');
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
    resolveProviderSelection: () => {
      state.events.push('legacy-selection');
      if (state.selectionError) {
        throw new ProviderSelectionError('no providers for fixture');
      }
      return ['legacy-provider'];
    },
  };
});

vi.mock('../src/core/prompt-builder.js', () => ({
  generateSlug: () => 'fixture-slug',
  resolveOutputDir: () => '/tmp/unused-cli-output',
  createRunDir: () => '/tmp/unused-mcp-output',
}));

const silentResult = {
  manifest: {
    schemaVersion: 2,
    revision: 0,
    status: 'completed',
    timestamp: 0,
    slug: 'fixture-slug',
    query: 'private query',
    mode: 'mixed',
    outputDir: '/tmp/unused-mcp-output',
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

vi.mock('../src/core/research-run.js', () => ({
  executeResearchRun: async (input: unknown) => {
    state.events.push('dispatch');
    state.dispatchInput = input;
    return silentResult;
  },
}));

vi.mock('../src/commands/refine.js', () => ({
  refineQuery: async () => {
    state.events.push('refine');
    return null;
  },
}));

import { executeRun } from '../src/commands/run.js';
import { runResearchSilent } from '../src/mcp/research.js';

describe('CLI production shadow diagnostic', () => {
  beforeEach(() => {
    state.events.length = 0;
    state.shadowInput = undefined;
    state.selectionError = true;
    state.dispatchInput = undefined;
    process.exitCode = undefined;
  });

  it('runs exactly once after merge and before credentials/initialization without polluting JSON stdout', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const outcome = await executeRun('private query', {
        providers: ['legacy-provider'],
        group: 'ignored-group',
        mode: 'async',
        parallel: 4,
        timeout: 45,
        maxCost: 1.25,
        maxEstimatedCost: 2.5,
        fallback: false,
        refine: true,
        json: true,
      });

      expect(outcome).toEqual({ exitCode: 2 });
      expect(state.events).toEqual([
        'load-global',
        'load-project',
        'merge',
        'shadow',
        'keychain-credentials',
        'initialize',
        'legacy-selection',
      ]);
      expect(state.events.filter((event) => event === 'shadow')).toHaveLength(
        1,
      );
      expect(state.shadowInput).toMatchObject({
        config: fixtureConfig,
        transport: {
          kind: 'cli',
          input: {
            query: 'private query',
            providers: ['legacy-provider'],
            group: 'ignored-group',
            mode: 'async',
            parallel: 4,
            timeoutSeconds: 45,
            maxCostUsd: 1.25,
            maxEstimatedCostUsd: 2.5,
            fallback: false,
            refine: true,
          },
        },
      });
      expect(stderr).toHaveBeenCalledWith(
        '[librarium] shadow: issues=1 issues_codes=fixture\n',
      );
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });

  it('keeps silent MCP results and dispatch inputs unchanged while warning only through onWarn', async () => {
    state.selectionError = false;
    const warnings: string[] = [];
    const initialize = vi.fn(async () => {
      state.events.push('initialize');
      return {
        warnings: [],
        loadedCustomProviders: [],
        skippedCustomProviders: [],
      };
    });
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const result = await runResearchSilent(
        {
          query: 'private query',
          providers: ['legacy-provider'],
          mode: 'mixed',
          refine: true,
        },
        {
          loadMergedConfig: () => {
            state.events.push('load-merged');
            return fixtureConfig;
          },
          initialize,
          credentials: { env: { LEGACY_API_KEY: 'legacy-secret' } },
          onWarn: (message) => {
            state.events.push('warning');
            warnings.push(message);
          },
        },
      );

      expect(result).toBe(silentResult);
      expect(state.events).toEqual([
        'load-merged',
        'shadow',
        'warning',
        'initialize',
        'legacy-selection',
        'refine',
        'dispatch',
      ]);
      expect(state.events.filter((event) => event === 'shadow')).toHaveLength(
        1,
      );
      expect(warnings).toEqual([
        '[librarium] shadow: issues=1 issues_codes=fixture',
      ]);
      expect(state.shadowInput).toMatchObject({
        config: fixtureConfig,
        transport: {
          kind: 'silent_mcp',
          input: {
            query: 'private query',
            providers: ['legacy-provider'],
            mode: 'mixed',
            refine: true,
          },
        },
      });
      expect(state.dispatchInput).toMatchObject({
        query: 'private query',
        config: fixtureConfig,
        providerIds: ['legacy-provider'],
        outputDir: '/tmp/unused-mcp-output',
        slug: 'fixture-slug',
        credentials: { env: { LEGACY_API_KEY: 'legacy-secret' } },
      });
      expect(stdout).not.toHaveBeenCalled();
      expect(state.events).not.toContain('keychain-credentials');
    } finally {
      stdout.mockRestore();
    }
  });
});
