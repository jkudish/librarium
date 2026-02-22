import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Config,
  Provider,
  ProviderOptions,
  ProviderResult,
} from '../src/types.js';

// We re-import the adapter registry fresh for each test to avoid shared state.
let registerProvider: typeof import('../src/adapters/index.js').registerProvider;
let dispatch: typeof import('../src/core/dispatcher.js').dispatch;

/** Create a minimal Config object with the given provider entries. */
function makeConfig(
  providers: Record<
    string,
    { apiKey: string; enabled: boolean; fallback?: string }
  >,
): Config {
  return {
    version: 1,
    defaults: {
      outputDir: './agents/librarium',
      maxParallel: 6,
      timeout: 30,
      asyncTimeout: 1800,
      asyncPollInterval: 10,
      mode: 'mixed',
    },
    providers,
    groups: {},
  };
}

/** Build a mock Provider that resolves successfully. */
function createSuccessProvider(
  id: string,
  tier: 'deep-research' | 'ai-grounded' | 'raw-search' = 'ai-grounded',
): Provider {
  return {
    id,
    displayName: `Mock ${id}`,
    tier,
    envVar: `MOCK_${id.toUpperCase().replace(/-/g, '_')}_KEY`,
    execute: async (
      _query: string,
      _options: ProviderOptions,
    ): Promise<ProviderResult> => ({
      provider: id,
      tier,
      content: `result from ${id}`,
      citations: [
        { url: 'https://example.com', title: 'Example', provider: id },
      ],
      durationMs: 42,
    }),
  };
}

/** Build a mock Provider whose execute() always throws. */
function createFailingProvider(
  id: string,
  errorMessage: string,
  tier: 'deep-research' | 'ai-grounded' | 'raw-search' = 'ai-grounded',
): Provider {
  return {
    id,
    displayName: `Mock ${id}`,
    tier,
    envVar: `MOCK_${id.toUpperCase().replace(/-/g, '_')}_KEY`,
    execute: async (): Promise<ProviderResult> => {
      throw new Error(errorMessage);
    },
  };
}

describe('dispatcher fallback', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();

    // Fresh imports so the provider registry is empty each time.
    const adapters = await import('../src/adapters/index.js');
    registerProvider = adapters.registerProvider;

    const dispatcherMod = await import('../src/core/dispatcher.js');
    dispatch = dispatcherMod.dispatch;

    // Create a temp output directory for file writes.
    tmpDir = join(
      tmpdir(),
      `librarium-fallback-test-${randomUUID().slice(0, 8)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });

    // Clean up env vars that tests may have set.
    delete process.env.MOCK_PRIMARY_KEY;
    delete process.env.MOCK_FALLBACK_KEY;
    delete process.env.MOCK_FALLBACK_FAIL_KEY;
    delete process.env.MOCK_ALREADY_DISPATCHED_KEY;
    delete process.env.MOCK_NO_KEY_FALLBACK_KEY;
  });

  it('triggers fallback when primary provider throws', async () => {
    // Set up env vars so hasApiKey resolves for both providers.
    process.env.MOCK_PRIMARY_KEY = 'key-primary';
    process.env.MOCK_FALLBACK_KEY = 'key-fallback';

    const primary = createFailingProvider('primary', 'primary boom');
    const fallback = createSuccessProvider('fallback');

    registerProvider(primary);
    registerProvider(fallback);

    const config = makeConfig({
      primary: {
        apiKey: '$MOCK_PRIMARY_KEY',
        enabled: true,
        fallback: 'fallback',
      },
      fallback: {
        apiKey: '$MOCK_FALLBACK_KEY',
        enabled: true,
      },
    });

    const { reports } = await dispatch({
      config,
      providerIds: ['primary'],
      query: 'test query',
      outputDir: tmpDir,
      mode: 'sync',
    });

    // Should have two reports: the primary error and the fallback success.
    expect(reports).toHaveLength(2);

    const primaryReport = reports.find((r) => r.id === 'primary');
    expect(primaryReport).toBeDefined();
    expect(primaryReport!.status).toBe('error');
    expect(primaryReport!.error).toBe('primary boom');
    expect(primaryReport!.fallbackFor).toBeUndefined();

    const fallbackReport = reports.find((r) => r.id === 'fallback');
    expect(fallbackReport).toBeDefined();
    expect(fallbackReport!.status).toBe('success');
    expect(fallbackReport!.fallbackFor).toBe('primary');
    expect(fallbackReport!.wordCount).toBeGreaterThan(0);
    expect(fallbackReport!.citationCount).toBe(1);
  });

  it('does NOT trigger fallback when primary provider succeeds', async () => {
    process.env.MOCK_PRIMARY_KEY = 'key-primary';
    process.env.MOCK_FALLBACK_KEY = 'key-fallback';

    const primary = createSuccessProvider('primary');
    const fallback = createSuccessProvider('fallback');

    registerProvider(primary);
    registerProvider(fallback);

    const config = makeConfig({
      primary: {
        apiKey: '$MOCK_PRIMARY_KEY',
        enabled: true,
        fallback: 'fallback',
      },
      fallback: {
        apiKey: '$MOCK_FALLBACK_KEY',
        enabled: true,
      },
    });

    const { reports } = await dispatch({
      config,
      providerIds: ['primary'],
      query: 'test query',
      outputDir: tmpDir,
      mode: 'sync',
    });

    // Only the successful primary report, no fallback.
    expect(reports).toHaveLength(1);
    expect(reports[0].id).toBe('primary');
    expect(reports[0].status).toBe('success');
    expect(reports[0].fallbackFor).toBeUndefined();
  });

  it('reports two errors when fallback also fails', async () => {
    process.env.MOCK_PRIMARY_KEY = 'key-primary';
    process.env.MOCK_FALLBACK_FAIL_KEY = 'key-fallback-fail';

    const primary = createFailingProvider('primary', 'primary exploded');
    const fallbackProvider = createFailingProvider(
      'fallback-fail',
      'fallback exploded',
    );

    registerProvider(primary);
    registerProvider(fallbackProvider);

    const config = makeConfig({
      primary: {
        apiKey: '$MOCK_PRIMARY_KEY',
        enabled: true,
        fallback: 'fallback-fail',
      },
      'fallback-fail': {
        apiKey: '$MOCK_FALLBACK_FAIL_KEY',
        enabled: true,
      },
    });

    const { reports } = await dispatch({
      config,
      providerIds: ['primary'],
      query: 'test query',
      outputDir: tmpDir,
      mode: 'sync',
    });

    expect(reports).toHaveLength(2);

    const primaryReport = reports.find((r) => r.id === 'primary');
    expect(primaryReport).toBeDefined();
    expect(primaryReport!.status).toBe('error');
    expect(primaryReport!.error).toBe('primary exploded');

    const fallbackReport = reports.find((r) => r.id === 'fallback-fail');
    expect(fallbackReport).toBeDefined();
    expect(fallbackReport!.status).toBe('error');
    expect(fallbackReport!.error).toBe('fallback exploded');
    expect(fallbackReport!.fallbackFor).toBe('primary');
  });

  it('skips fallback when fallback provider is already in providerIds', async () => {
    process.env.MOCK_PRIMARY_KEY = 'key-primary';
    process.env.MOCK_ALREADY_DISPATCHED_KEY = 'key-already';

    const primary = createFailingProvider('primary', 'primary failed');
    const alreadyDispatched = createSuccessProvider('already-dispatched');

    registerProvider(primary);
    registerProvider(alreadyDispatched);

    const config = makeConfig({
      primary: {
        apiKey: '$MOCK_PRIMARY_KEY',
        enabled: true,
        fallback: 'already-dispatched',
      },
      'already-dispatched': {
        apiKey: '$MOCK_ALREADY_DISPATCHED_KEY',
        enabled: true,
      },
    });

    const { reports } = await dispatch({
      config,
      // Both primary and the would-be fallback are already in providerIds.
      providerIds: ['primary', 'already-dispatched'],
      query: 'test query',
      outputDir: tmpDir,
      mode: 'sync',
    });

    // The fallback should NOT be triggered because it is already dispatched.
    // We expect two reports: one error for primary, one success for already-dispatched
    // (from its own direct dispatch), but NO fallback report with fallbackFor set.
    const fallbackReports = reports.filter((r) => r.fallbackFor !== undefined);
    expect(fallbackReports).toHaveLength(0);

    const primaryReport = reports.find((r) => r.id === 'primary');
    expect(primaryReport).toBeDefined();
    expect(primaryReport!.status).toBe('error');
  });

  it('skips fallback when fallback provider has no API key', async () => {
    process.env.MOCK_PRIMARY_KEY = 'key-primary';
    // Deliberately do NOT set MOCK_NO_KEY_FALLBACK_KEY so hasApiKey returns false.
    delete process.env.MOCK_NO_KEY_FALLBACK_KEY;

    const primary = createFailingProvider('primary', 'primary died');
    const noKeyFallback = createSuccessProvider('no-key-fallback');

    registerProvider(primary);
    registerProvider(noKeyFallback);

    const config = makeConfig({
      primary: {
        apiKey: '$MOCK_PRIMARY_KEY',
        enabled: true,
        fallback: 'no-key-fallback',
      },
      'no-key-fallback': {
        // Points to an env var that is NOT set.
        apiKey: '$MOCK_NO_KEY_FALLBACK_KEY',
        enabled: true,
      },
    });

    const { reports } = await dispatch({
      config,
      providerIds: ['primary'],
      query: 'test query',
      outputDir: tmpDir,
      mode: 'sync',
    });

    // Only the primary error report, no fallback triggered.
    expect(reports).toHaveLength(1);
    expect(reports[0].id).toBe('primary');
    expect(reports[0].status).toBe('error');
    expect(reports[0].error).toBe('primary died');

    const fallbackReports = reports.filter((r) => r.fallbackFor !== undefined);
    expect(fallbackReports).toHaveLength(0);
  });

  it('triggers fallback when provider returns error result without throwing', async () => {
    process.env.MOCK_PRIMARY_KEY = 'key-primary';
    process.env.MOCK_FALLBACK_KEY = 'key-fallback';

    // Provider that returns an error result (like most adapters do on 401/403)
    const errorResultProvider: Provider = {
      id: 'error-result',
      displayName: 'Mock error-result',
      tier: 'ai-grounded',
      envVar: 'MOCK_PRIMARY_KEY',
      execute: async (
        _query: string,
        _options: ProviderOptions,
      ): Promise<ProviderResult> => ({
        provider: 'error-result',
        tier: 'ai-grounded',
        content: '',
        citations: [],
        durationMs: 100,
        error: 'API returned 401: Unauthorized',
      }),
    };

    const fallback = createSuccessProvider('fallback');

    registerProvider(errorResultProvider);
    registerProvider(fallback);

    const config = makeConfig({
      'error-result': {
        apiKey: '$MOCK_PRIMARY_KEY',
        enabled: true,
        fallback: 'fallback',
      },
      fallback: {
        apiKey: '$MOCK_FALLBACK_KEY',
        enabled: false,
      },
    });

    const { reports } = await dispatch({
      config,
      providerIds: ['error-result'],
      query: 'test query',
      outputDir: tmpDir,
      mode: 'sync',
    });

    // Should have two reports: the primary error and the fallback success.
    expect(reports).toHaveLength(2);

    const primaryReport = reports.find((r) => r.id === 'error-result');
    expect(primaryReport).toBeDefined();
    expect(primaryReport!.status).toBe('error');
    expect(primaryReport!.error).toContain('401');

    const fallbackReport = reports.find((r) => r.id === 'fallback');
    expect(fallbackReport).toBeDefined();
    expect(fallbackReport!.status).toBe('success');
    expect(fallbackReport!.fallbackFor).toBe('error-result');
  });
});
