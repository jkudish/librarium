import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ESTIMATE_BUDGET_SKIP_REASON } from '../src/core/budget.js';
import type {
  Config,
  Provider,
  ProviderOptions,
  ProviderResult,
} from '../src/types.js';

let registerProvider: typeof import('../src/adapters/index.js').registerProvider;
let createEstimateBudgetTracker: typeof import('../src/core/budget.js').createEstimateBudgetTracker;
let dispatch: typeof import('../src/core/dispatcher.js').dispatch;

function makeConfig(
  providers: Record<
    string,
    { apiKey: string; enabled: boolean; options?: Record<string, unknown> }
  >,
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

/** A raw-search provider (real registry id) that reports no usage. */
function searchProvider(id: string): Provider {
  return {
    id,
    displayName: `Mock ${id}`,
    tier: 'raw-search',
    envVar: `MOCK_${id.toUpperCase().replace(/-/g, '_')}_KEY`,
    execute: async (
      _query: string,
      _options: ProviderOptions,
    ): Promise<ProviderResult> => ({
      provider: id,
      tier: 'raw-search',
      content: `result from ${id}`,
      citations: [],
      durationMs: 1,
    }),
  };
}

describe('dispatcher: metering attachment', () => {
  beforeEach(async () => {
    vi.resetModules();
    const adapters = await import('../src/adapters/index.js');
    registerProvider = adapters.registerProvider;
    const budgetMod = await import('../src/core/budget.js');
    createEstimateBudgetTracker = budgetMod.createEstimateBudgetTracker;
    const dispatcherMod = await import('../src/core/dispatcher.js');
    dispatch = dispatcherMod.dispatch;
    process.env.MOCK_SERPAPI_KEY = 'k';
    process.env.MOCK_BRAVE_SEARCH_KEY = 'k';
    process.env.MOCK_TAVILY_KEY = 'k';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MOCK_SERPAPI_KEY;
    delete process.env.MOCK_BRAVE_SEARCH_KEY;
    delete process.env.MOCK_TAVILY_KEY;
  });

  it('attaches metering (kind + estimate) to every report and result', async () => {
    registerProvider(searchProvider('serpapi'));
    const { reports, results } = await dispatch({
      config: makeConfig({
        serpapi: { apiKey: '$MOCK_SERPAPI_KEY', enabled: true },
      }),
      providerIds: ['serpapi'],
      query: 'q',
      mode: 'sync',
      credentials: { env: process.env },
    });

    const report = reports.find((r) => r.id === 'serpapi');
    expect(report?.metering?.kind).toBe('request_priced');
    expect(report?.metering?.estimate?.estimatedCostUsd).toBe(0.015);
    expect(report?.metering?.estimate?.costConfidence).toBe('estimated');
    // The same metering rides on the structured dispatch result.
    const result = results.find((r) => r.provider === 'serpapi');
    expect(result?.metering?.kind).toBe('request_priced');
  });

  it('honors configured pricing overrides from provider options', async () => {
    registerProvider(searchProvider('serpapi'));
    const { reports } = await dispatch({
      config: makeConfig({
        serpapi: {
          apiKey: '$MOCK_SERPAPI_KEY',
          enabled: true,
          options: { perRequestUsd: 0.03 },
        },
      }),
      providerIds: ['serpapi'],
      query: 'q',
      mode: 'sync',
      credentials: { env: process.env },
    });
    const est = reports.find((r) => r.id === 'serpapi')?.metering?.estimate;
    expect(est?.estimatedCostUsd).toBe(0.03);
    expect(est?.costConfidence).toBe('configured');
  });
});

describe('dispatcher: estimated budget reservation', () => {
  beforeEach(async () => {
    vi.resetModules();
    const adapters = await import('../src/adapters/index.js');
    registerProvider = adapters.registerProvider;
    const budgetMod = await import('../src/core/budget.js');
    createEstimateBudgetTracker = budgetMod.createEstimateBudgetTracker;
    const dispatcherMod = await import('../src/core/dispatcher.js');
    dispatch = dispatcherMod.dispatch;
    process.env.MOCK_SERPAPI_KEY = 'k';
    process.env.MOCK_BRAVE_SEARCH_KEY = 'k';
    process.env.MOCK_SEARCHAPI_KEY = 'k';
    process.env.MOCK_TAVILY_KEY = 'k';
    process.env.MOCK_FIRECRAWL_SEARCH_KEY = 'k';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of [
      'MOCK_SERPAPI_KEY',
      'MOCK_BRAVE_SEARCH_KEY',
      'MOCK_SEARCHAPI_KEY',
      'MOCK_TAVILY_KEY',
      'MOCK_FIRECRAWL_SEARCH_KEY',
    ]) {
      delete process.env[k];
    }
  });

  it('skips not-yet-started providers once the reservation crosses the ceiling', async () => {
    registerProvider(searchProvider('serpapi')); // estimate 0.015
    registerProvider(searchProvider('searchapi')); // estimate 0.004
    registerProvider(searchProvider('brave-search')); // estimate 0.005

    const estimatedBudget = createEstimateBudgetTracker(0.015);
    const { reports } = await dispatch({
      config: makeConfig({
        serpapi: { apiKey: '$MOCK_SERPAPI_KEY', enabled: true },
        searchapi: { apiKey: '$MOCK_SEARCHAPI_KEY', enabled: true },
        'brave-search': { apiKey: '$MOCK_BRAVE_SEARCH_KEY', enabled: true },
      }),
      providerIds: ['serpapi', 'searchapi', 'brave-search'],
      query: 'q',
      mode: 'sync',
      credentials: { env: process.env },
      estimatedBudget,
    });

    const byId = new Map(reports.map((r) => [r.id, r]));
    // serpapi reserves 0.015 -> reaches the ceiling -> the rest are skipped.
    expect(byId.get('serpapi')?.status).toBe('success');
    expect(byId.get('searchapi')?.status).toBe('skipped');
    expect(byId.get('searchapi')?.error).toBe(ESTIMATE_BUDGET_SKIP_REASON);
    expect(byId.get('brave-search')?.status).toBe('skipped');
    expect(estimatedBudget.reservedUsd).toBeCloseTo(0.015);
  });

  it('never skips providers whose estimate has no USD figure (reserve 0)', async () => {
    // tavily/firecrawl are credit-priced with no configured price: each reserves
    // 0, so even a tiny ceiling lets them all run.
    registerProvider(searchProvider('tavily'));
    registerProvider(searchProvider('firecrawl-search'));

    const estimatedBudget = createEstimateBudgetTracker(0.001);
    const { reports } = await dispatch({
      config: makeConfig({
        tavily: { apiKey: '$MOCK_TAVILY_KEY', enabled: true },
        'firecrawl-search': {
          apiKey: '$MOCK_FIRECRAWL_SEARCH_KEY',
          enabled: true,
        },
      }),
      providerIds: ['tavily', 'firecrawl-search'],
      query: 'q',
      mode: 'sync',
      credentials: { env: process.env },
      estimatedBudget,
    });

    expect(reports.every((r) => r.status === 'success')).toBe(true);
    expect(estimatedBudget.reservedUsd).toBe(0);
  });

  it('does not reserve a fallback that never launches (no phantom reservation)', async () => {
    // serpapi fails and is configured to fall back to brave-search — but
    // brave-search is already a primary in this dispatch, so the fallback bails
    // out without launching. Its estimate must NOT be reserved twice.
    const failing: Provider = {
      id: 'serpapi',
      displayName: 'Mock serpapi',
      tier: 'raw-search',
      envVar: 'MOCK_SERPAPI_KEY',
      execute: async (): Promise<ProviderResult> => ({
        provider: 'serpapi',
        tier: 'raw-search',
        content: '',
        citations: [],
        durationMs: 1,
        error: 'boom',
      }),
    };
    registerProvider(failing);
    registerProvider(searchProvider('brave-search'));

    const config = makeConfig({
      serpapi: { apiKey: '$MOCK_SERPAPI_KEY', enabled: true },
      'brave-search': { apiKey: '$MOCK_BRAVE_SEARCH_KEY', enabled: true },
    });
    config.providers.serpapi = {
      ...config.providers.serpapi,
      fallback: 'brave-search',
    } as never;

    const estimatedBudget = createEstimateBudgetTracker(1);
    await dispatch({
      config,
      providerIds: ['serpapi', 'brave-search'],
      query: 'q',
      mode: 'sync',
      credentials: { env: process.env },
      estimatedBudget,
    });

    // serpapi (0.015) + brave-search-as-primary (0.005) = 0.02. The bailed
    // fallback must not add another 0.005.
    expect(estimatedBudget.reservedUsd).toBeCloseTo(0.02);
  });

  it('does not reserve or skip anything when no estimated budget is supplied', async () => {
    registerProvider(searchProvider('serpapi'));
    registerProvider(searchProvider('searchapi'));
    const { reports } = await dispatch({
      config: makeConfig({
        serpapi: { apiKey: '$MOCK_SERPAPI_KEY', enabled: true },
        searchapi: { apiKey: '$MOCK_SEARCHAPI_KEY', enabled: true },
      }),
      providerIds: ['serpapi', 'searchapi'],
      query: 'q',
      mode: 'sync',
      credentials: { env: process.env },
    });
    expect(reports.every((r) => r.status === 'success')).toBe(true);
  });
});
