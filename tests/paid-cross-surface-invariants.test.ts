import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { synthesizeAnswer } from '../src/commands/answer.js';
import { executeRun } from '../src/commands/run.js';
import { runResearchSilent } from '../src/mcp/research.js';
import { readRunResults } from '../src/mcp/shaping.js';
import { readCanonicalRunManifest } from '../src/node-canonical-run.js';
import { PaidRunLedgerSchema } from '../src/node-paid-attempt-ledger.js';
import type { Config, Provider, ProviderResult } from '../src/types.js';

const state = vi.hoisted(() => ({
  config: undefined as Config | undefined,
  spinner: {
    start: vi.fn(),
    stop: vi.fn(),
    fail: vi.fn(),
  },
}));

vi.mock('ora', () => ({
  default: () => {
    state.spinner.start.mockReturnValue(state.spinner);
    state.spinner.stop.mockReturnValue(state.spinner);
    state.spinner.fail.mockReturnValue(state.spinner);
    return state.spinner;
  },
}));

vi.mock('../src/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/config.js')>();
  return {
    ...actual,
    loadConfig: () => state.config,
    loadProjectConfig: () => null,
  };
});

const roots: string[] = [];
const originalEnv = process.env;

function runConfig(outputDir: string): Config {
  return {
    version: 1,
    defaults: {
      outputDir,
      maxParallel: 1,
      timeout: 30,
      asyncTimeout: 60,
      asyncPollInterval: 1,
      requestDeadlineMs: 60_000,
      maxCostUsd: 0.021,
      mode: 'sync',
      llmWebSearch: true,
    },
    providers: {
      'kagi-fastgpt': { enabled: true },
      'openai-chat': {
        enabled: true,
        options: { perRequestUsd: 0.003 },
      },
    },
    customProviders: {},
    trustedProviderIds: [],
    groups: {},
    refine: { provider: 'openai', model: 'gpt-5-mini' },
    answer: { provider: 'openai', model: 'gpt-5-mini' },
  };
}

function researchResult(): ProviderResult {
  return {
    provider: 'kagi-fastgpt',
    tier: 'ai-grounded',
    content:
      '# Retained research\n\nThe useful result survives. [Source](https://example.com/source)',
    citations: [
      {
        provider: 'kagi-fastgpt',
        url: 'https://example.com/source',
        title: 'Retained source',
        snippet: 'Useful evidence',
      },
    ],
    durationMs: 5,
    usage: { costUsd: 0.018 },
  };
}

function provider(execute: Provider['execute']): Provider {
  return {
    id: 'kagi-fastgpt',
    displayName: 'Network-denied Kagi fixture',
    tier: 'ai-grounded',
    execution: 'inline',
    envVar: '',
    requiresApiKey: false,
    execute,
  };
}

function initialize() {
  return Promise.resolve({
    warnings: [],
    loadedCustomProviders: [],
    skippedCustomProviders: [],
  });
}

function readLedger(outputDir: string) {
  return PaidRunLedgerSchema.parse(
    JSON.parse(
      readFileSync(join(outputDir, 'paid-attempt-ledger.json'), 'utf8'),
    ),
  );
}

beforeEach(() => {
  const root = join(
    tmpdir(),
    `librarium-paid-cross-surface-${crypto.randomUUID()}`,
  );
  mkdirSync(root, { recursive: true });
  roots.push(root);
  state.config = runConfig(join(root, 'cli'));
  mkdirSync(state.config.defaults.outputDir, { recursive: true });
  process.env = {
    ...originalEnv,
    KAGI_API_KEY: 'network-denied-kagi-key',
    OPENAI_API_KEY: 'network-denied-openai-key',
  };
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  process.env = originalEnv;
  process.exitCode = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('paid cross-surface invariants', () => {
  it('uses one real run authority, preserves synthesis reserve, and retains readable research at the ceiling', async () => {
    const executeCliProvider = vi.fn(async () => researchResult());
    const cliProvider = provider(executeCliProvider);
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    deepResearch: 'Deep retained research',
                    aiGrounded: 'Grounded retained research',
                    rawSearch: 'retained research',
                    suggestedGroup: 'quick',
                  }),
                },
              },
            ],
            usage: { costUsd: 0.003 },
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const cli = await executeRun(
      'prove paid cross-surface invariants',
      {
        providers: ['kagi-fastgpt'],
        mode: 'sync',
        maxCost: 0.021,
        refine: true,
        yes: true,
      },
      {
        paidStages: { synthesis: true },
        postDispatch: synthesizeAnswer,
      },
      {
        initialize,
        registeredAdapterIds: () => ['kagi-fastgpt'],
        resolveExactProvider: () => cliProvider,
      },
    );

    expect(cli.exitCode).toBe(0);
    expect(cli.outputDir).toBeDefined();
    expect(executeCliProvider).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    const cliOutputDir = cli.outputDir as string;
    const cliLedger = readLedger(cliOutputDir);
    expect(cliLedger.limits.max_actual_cost_microusd).toBe('21000');
    expect(
      cliLedger.stages.find(({ stage }) => stage === 'synthesis'),
    ).toMatchObject({
      status: 'requested',
      reserved_cost_microusd: '3000',
    });
    expect(cliLedger.attempts).toEqual([
      expect.objectContaining({
        stage: 'refinement',
        status: 'succeeded',
        reported: { state: 'known', cost_microusd: '3000' },
      }),
      expect.objectContaining({
        stage: 'research',
        status: 'succeeded',
        reported: { state: 'known', cost_microusd: '18000' },
      }),
      expect.objectContaining({
        stage: 'synthesis',
        status: 'blocked',
        reason_code: 'actual_budget_exhausted',
      }),
    ]);
    expect(existsSync(join(cliOutputDir, 'answer.md'))).toBe(false);
    expect(existsSync(join(cliOutputDir, 'sources.json'))).toBe(true);
    expect(
      readCanonicalRunManifest(dirname(cliOutputDir), cliOutputDir),
    ).toMatchObject({
      terminal_response: { status: 'succeeded' },
    });
    expect(readRunResults(cliOutputDir)).toMatchObject({
      results: [
        {
          id: 'kagi-fastgpt',
          status: 'success',
          content: expect.stringContaining('The useful result survives.'),
        },
      ],
    });

    const mcpRoot = join(roots[0] as string, 'mcp');
    mkdirSync(mcpRoot, { recursive: true });
    const mcpConfig = runConfig(mcpRoot);
    const executeMcpProvider = vi.fn(async () => researchResult());
    const mcpProvider = provider(executeMcpProvider);
    const mcp = await runResearchSilent(
      {
        query: 'prove paid cross-surface invariants',
        providers: ['kagi-fastgpt'],
        mode: 'sync',
        refine: true,
      },
      {
        loadMergedConfig: () => mcpConfig,
        initialize,
        registeredAdapterIds: () => ['kagi-fastgpt'],
        resolveExactProvider: () => mcpProvider,
        credentials: {
          env: {
            KAGI_API_KEY: 'network-denied-kagi-key',
            OPENAI_API_KEY: 'network-denied-openai-key',
          },
        },
        onWarn: () => {},
      },
    );

    expect(executeMcpProvider).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const mcpLedger = readLedger(mcp.outputDir);
    const sharedStages = ['refinement', 'research'] as const;
    for (const stage of sharedStages) {
      const cliStage = cliLedger.stages.find((entry) => entry.stage === stage);
      const mcpStage = mcpLedger.stages.find((entry) => entry.stage === stage);
      expect(mcpStage).toMatchObject({
        stage,
        requested: cliStage?.requested,
        fallback_authorized: cliStage?.fallback_authorized,
        prompt_version: cliStage?.prompt_version,
        providers: cliStage?.providers,
        status: cliStage?.status,
      });
      expect(
        mcpLedger.attempts.find((attempt) => attempt.stage === stage),
      ).toMatchObject({
        stage,
        status: 'succeeded',
        reported: cliLedger.attempts.find((attempt) => attempt.stage === stage)
          ?.reported,
      });
    }
    expect(
      mcpLedger.stages.find(({ stage }) => stage === 'synthesis'),
    ).toMatchObject({
      requested: false,
      status: 'not_requested',
    });
    expect(readRunResults(mcp.outputDir)).toMatchObject({
      results: [{ id: 'kagi-fastgpt', status: 'success' }],
    });
  });
});
