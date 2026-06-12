import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUDGET_SKIP_REASON, createBudgetTracker } from '../src/core/budget.js';
import type {
  Config,
  Provider,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../src/types.js';

let registerProvider: typeof import('../src/adapters/index.js').registerProvider;
let dispatch: typeof import('../src/core/dispatcher.js').dispatch;

function makeConfig(
  providers: Record<string, { apiKey: string; enabled: boolean }>,
  maxParallel = 1,
): Config {
  return {
    version: 1,
    defaults: {
      outputDir: './agents/librarium',
      maxParallel,
      timeout: 30,
      asyncTimeout: 1800,
      asyncPollInterval: 10,
      mode: 'sync',
    },
    providers,
    groups: {},
  };
}

/** A provider that reports a fixed cost and optionally delays before resolving. */
function costProvider(
  id: string,
  costUsd: number,
  delayMs = 0,
  tier: ProviderTier = 'ai-grounded',
): Provider {
  return {
    id,
    displayName: `Mock ${id}`,
    tier,
    envVar: `MOCK_${id.toUpperCase().replace(/-/g, '_')}_KEY`,
    execute: async (
      _query: string,
      _options: ProviderOptions,
    ): Promise<ProviderResult> => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return {
        provider: id,
        tier,
        content: `result from ${id}`,
        citations: [],
        durationMs: delayMs,
        usage: { costUsd },
      };
    },
  };
}

describe('dispatcher budget circuit breaker', () => {
  beforeEach(async () => {
    vi.resetModules();
    const adapters = await import('../src/adapters/index.js');
    registerProvider = adapters.registerProvider;
    const dispatcherMod = await import('../src/core/dispatcher.js');
    dispatch = dispatcherMod.dispatch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MOCK_A_KEY;
    delete process.env.MOCK_B_KEY;
    delete process.env.MOCK_C_KEY;
  });

  it('stops launching providers once the budget is crossed (serial)', async () => {
    process.env.MOCK_A_KEY = 'k';
    process.env.MOCK_B_KEY = 'k';
    process.env.MOCK_C_KEY = 'k';
    registerProvider(costProvider('a', 0.4));
    registerProvider(costProvider('b', 0.4));
    registerProvider(costProvider('c', 0.4));

    const budget = createBudgetTracker(0.5);
    const { reports } = await dispatch({
      config: makeConfig({
        a: { apiKey: '$MOCK_A_KEY', enabled: true },
        b: { apiKey: '$MOCK_B_KEY', enabled: true },
        c: { apiKey: '$MOCK_C_KEY', enabled: true },
      }),
      providerIds: ['a', 'b', 'c'],
      query: 'q',
      mode: 'sync',
      credentials: { env: process.env },
      budget,
    });

    const byId = new Map(reports.map((r) => [r.id, r]));
    // a runs (0.4), b runs (0.8 -> crosses 0.5), c is skipped before launch.
    expect(byId.get('a')?.status).toBe('success');
    expect(byId.get('b')?.status).toBe('success');
    expect(byId.get('c')?.status).toBe('skipped');
    expect(byId.get('c')?.error).toBe(BUDGET_SKIP_REASON);
    expect(budget.spentUsd).toBeCloseTo(0.8);
  });

  it('lets in-flight providers finish even after the budget is crossed', async () => {
    process.env.MOCK_A_KEY = 'k';
    process.env.MOCK_B_KEY = 'k';
    process.env.MOCK_C_KEY = 'k';
    // a is cheap+slow, b is expensive+fast. With maxParallel 2, a and b start
    // together; b crosses the budget while a is still in flight. a must still
    // complete; c (not yet started) must be skipped.
    registerProvider(costProvider('a', 0.1, 40));
    registerProvider(costProvider('b', 1.0, 0));
    registerProvider(costProvider('c', 0.4, 0));

    const budget = createBudgetTracker(0.5);
    const { reports } = await dispatch({
      config: makeConfig(
        {
          a: { apiKey: '$MOCK_A_KEY', enabled: true },
          b: { apiKey: '$MOCK_B_KEY', enabled: true },
          c: { apiKey: '$MOCK_C_KEY', enabled: true },
        },
        2,
      ),
      providerIds: ['a', 'b', 'c'],
      query: 'q',
      mode: 'sync',
      credentials: { env: process.env },
      budget,
    });

    const byId = new Map(reports.map((r) => [r.id, r]));
    expect(byId.get('a')?.status).toBe('success');
    expect(byId.get('b')?.status).toBe('success');
    expect(byId.get('c')?.status).toBe('skipped');
    expect(byId.get('c')?.error).toBe(BUDGET_SKIP_REASON);
  });

  it('skips nothing when no budget is supplied', async () => {
    process.env.MOCK_A_KEY = 'k';
    process.env.MOCK_B_KEY = 'k';
    registerProvider(costProvider('a', 5));
    registerProvider(costProvider('b', 5));

    const { reports } = await dispatch({
      config: makeConfig({
        a: { apiKey: '$MOCK_A_KEY', enabled: true },
        b: { apiKey: '$MOCK_B_KEY', enabled: true },
      }),
      providerIds: ['a', 'b'],
      query: 'q',
      mode: 'sync',
      credentials: { env: process.env },
    });

    expect(reports.every((r) => r.status === 'success')).toBe(true);
  });

  it('does not launch a fallback once the budget is exhausted', async () => {
    process.env.MOCK_A_KEY = 'k';
    process.env.MOCK_B_KEY = 'k';
    process.env.MOCK_C_KEY = 'k';
    // a reports cost over the budget; b then fails; b's fallback (c) must be
    // budget-skipped instead of launched.
    registerProvider(costProvider('mock-a', 1.0));
    const failing: Provider = {
      id: 'mock-b',
      displayName: 'Mock mock-b',
      tier: 'ai-grounded',
      envVar: 'MOCK_B_KEY',
      execute: async (): Promise<ProviderResult> => {
        // Fail only after mock-a has reported its over-budget cost, so the
        // budget is exhausted at fallback time (not at this task's start).
        await new Promise((r) => setTimeout(r, 60));
        return {
          provider: 'mock-b',
          tier: 'ai-grounded',
          content: '',
          citations: [],
          durationMs: 60,
          error: 'boom',
        };
      },
    };
    registerProvider(failing);
    let fallbackRan = false;
    registerProvider({
      ...costProvider('mock-c', 0.01),
      execute: async (): Promise<ProviderResult> => {
        fallbackRan = true;
        return {
          provider: 'mock-c',
          tier: 'ai-grounded',
          content: 'x',
          citations: [],
          durationMs: 1,
          usage: { costUsd: 0.01 },
        };
      },
    });

    const config = makeConfig(
      {
        'mock-a': { apiKey: '$MOCK_A_KEY', enabled: true },
        'mock-b': { apiKey: '$MOCK_B_KEY', enabled: true },
        'mock-c': { apiKey: '$MOCK_C_KEY', enabled: false },
      },
      2,
    );
    config.providers['mock-b'] = {
      ...config.providers['mock-b'],
      fallback: 'mock-c',
    } as never;

    const { reports } = await dispatch({
      config,
      providerIds: ['mock-a', 'mock-b'],
      query: 'q',
      mode: 'sync',
      credentials: { env: process.env },
      budget: createBudgetTracker(0.5),
    });

    expect(fallbackRan).toBe(false);
    const fallbackSkip = reports.find((r) => r.id === 'mock-c');
    expect(fallbackSkip?.status).toBe('skipped');
    expect(fallbackSkip?.error).toBe(BUDGET_SKIP_REASON);
    expect(fallbackSkip?.fallbackFor).toBe('mock-b');
  });
});
