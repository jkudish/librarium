import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRunManifest,
  RunManifestError,
  readRunManifest,
} from '../src/core/run-manifest.js';
import {
  providerArtifactFileNames,
  RunArtifactRepository,
} from '../src/node-run-artifacts.js';
import {
  type ReconciliationBackgroundProvider,
  RunReconciliationService,
} from '../src/node-run-reconciliation.js';
import type {
  AsyncPollResult,
  ProviderReport,
  ProviderResult,
} from '../src/types.js';

const runs: string[] = [];

afterEach(() => {
  for (const run of runs.splice(0))
    rmSync(run, { recursive: true, force: true });
});

function makeRun(providers: ProviderReport[]): string {
  const runDir = mkdtempSync(join(tmpdir(), 'librarium-reconcile-'));
  runs.push(runDir);
  createRunManifest(runDir, {
    status: 'awaiting_async',
    timestamp: 1,
    slug: 'reconcile-test',
    query: 'test query',
    mode: 'async',
    outputDir: '/untrusted/manifest-output',
    providers,
    sources: { total: 0, unique: 0, file: 'sources.json' },
    exitCode: null,
  });
  return runDir;
}

function pending(
  provider: string,
  taskId: string,
  status: 'pending' | 'completed' = 'pending',
): ProviderReport {
  return {
    id: provider,
    tier: 'deep-research',
    status: 'async-pending',
    durationMs: 0,
    wordCount: 0,
    citationCount: 0,
    outputFile: '',
    metaFile: '',
    task: { taskId, submittedAt: 1, status },
  };
}

function successResult(
  provider: string,
  text = `# ${provider}\nresult`,
): ProviderResult {
  return {
    provider,
    tier: 'raw-search',
    content: text,
    citations: [
      { provider, url: `https://${provider}.test/source`, title: 'Source' },
    ],
    durationMs: 12,
    tokenUsage: { input: 2, output: 3 },
  };
}

function provider(
  poll: (
    handle: Parameters<ReconciliationBackgroundProvider['poll']>[0],
  ) => Promise<AsyncPollResult>,
  retrieve: (
    handle: Parameters<ReconciliationBackgroundProvider['retrieve']>[0],
  ) => Promise<ProviderResult>,
): ReconciliationBackgroundProvider {
  return { execution: 'background', poll, retrieve };
}

describe('RunReconciliationService', () => {
  it('counts and regenerates only the service invocation that wins a concurrent retrieval commit', async () => {
    const runDir = makeRun([
      pending('brave-search', 'concurrent', 'completed'),
    ]);
    const repository = new RunArtifactRepository();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    let bothEntered!: () => void;
    const both = new Promise<void>((resolve) => {
      bothEntered = resolve;
    });
    const retrieve = vi.fn(async () => {
      entered++;
      if (entered === 2) bothEntered();
      await released;
      return successResult('brave-search');
    });
    const regenerate = vi.fn();
    const service = () =>
      new RunReconciliationService({
        repository,
        resolveBackgroundProvider: () =>
          provider(async () => ({ status: 'completed' }), retrieve),
        getProviderConfig: () => undefined,
        now: () => 50,
        regenerateDerivedArtifacts: regenerate,
      });

    const first = service().reconcileOnce(runDir, { retrieve: true });
    const second = service().reconcileOnce(runDir, { retrieve: true });
    await both;
    release();
    const results = await Promise.all([first, second]);

    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(results.map((result) => result.retrieved).sort()).toEqual([0, 1]);
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(
      results
        .flatMap((result) => result.tasks)
        .filter((task) => task.retrievedThisPass),
    ).toHaveLength(1);
    expect(readRunManifest(runDir).providers[0]?.task?.retrievedAt).toBe(50);
  });

  it('polls, rescans, and retrieves newly completed plus pre-existing tasks', async () => {
    const runDir = makeRun([
      pending('brave-search', 'new-task'),
      pending('searchapi', 'old-task', 'completed'),
    ]);
    const polls: string[] = [];
    const retrieves: string[] = [];
    const configs: string[] = [];
    const providers = new Map<string, ReconciliationBackgroundProvider>([
      [
        'brave-search',
        provider(
          async (handle) => {
            polls.push(handle.taskId);
            return { status: 'completed', rawStatus: 'DONE' };
          },
          async (handle) => {
            retrieves.push(handle.taskId);
            return successResult('brave-search');
          },
        ),
      ],
      [
        'searchapi',
        provider(
          async () => ({ status: 'running' }),
          async (handle) => {
            retrieves.push(handle.taskId);
            return successResult('searchapi');
          },
        ),
      ],
    ]);
    let now = 100;
    const service = new RunReconciliationService({
      repository: new RunArtifactRepository(),
      resolveBackgroundProvider: (id) => providers.get(id),
      getProviderConfig: (id) => {
        configs.push(id);
        return id === 'brave-search'
          ? { options: { perRequestUsd: 0.09 } }
          : { options: { perRequestUsd: 0.07 } };
      },
      now: () => now++,
    });

    const result = await service.reconcileOnce(runDir, { retrieve: true });
    expect(polls).toEqual(['new-task']);
    expect(retrieves).toEqual(['new-task', 'old-task']);
    expect(configs).toEqual(['brave-search', 'searchapi']);
    expect(result.polled).toBe(1);
    expect(result.retrieved).toBe(2);
    expect(result.tasks.map((task) => task.status)).toEqual([
      'retrieved',
      'retrieved',
    ]);
    expect(result.tasks).toEqual(result.tasks);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.tasks)).toBe(true);

    const manifest = readRunManifest(runDir);
    expect(
      manifest.providers.every(
        (report) => report.task?.retrievedAt !== undefined,
      ),
    ).toBe(true);
    expect(manifest.providers[0]?.metering?.estimate?.estimatedCostUsd).toBe(
      0.09,
    );
    expect(manifest.providers[1]?.metering?.estimate?.estimatedCostUsd).toBe(
      0.07,
    );
    expect(manifest.sources.total).toBe(2);
  });

  it('persists transport errors while keeping a task retryable', async () => {
    const runDir = makeRun([pending('brave-search', 'retry')]);
    let shouldFail = true;
    const poll = vi.fn(async () => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('temporary transport failure\nwith stack-like text');
      }
      return { status: 'completed' as const };
    });
    const retrieve = vi.fn(async () => successResult('brave-search'));
    let now = 10;
    const service = new RunReconciliationService({
      repository: new RunArtifactRepository(),
      resolveBackgroundProvider: () => provider(poll, retrieve),
      getProviderConfig: () => undefined,
      now: () => now++,
    });

    const first = await service.reconcileOnce(runDir);
    expect(first.tasks[0]).toMatchObject({
      status: 'pending',
      error: 'provider.poll_failed',
    });
    expect(readRunManifest(runDir).providers[0]?.task).toMatchObject({
      status: 'pending',
      lastPollError: 'provider.poll_failed',
    });
    const second = await service.reconcileOnce(runDir, { retrieve: true });
    expect(second.retrieved).toBe(1);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('terminalizes provider-returned errors immediately without writing result artifacts', async () => {
    const runDir = makeRun([
      pending('brave-search', 'error-task', 'completed'),
    ]);
    const providerResult: ProviderResult = {
      ...successResult('brave-search'),
      error: 'remote provider failed',
    };
    const retrieve = vi.fn(async () => providerResult);
    const service = new RunReconciliationService({
      repository: new RunArtifactRepository(),
      resolveBackgroundProvider: () =>
        provider(async () => ({ status: 'completed' }), retrieve),
      getProviderConfig: () => undefined,
      now: () => 20,
    });
    const first = await service.reconcileOnce(runDir, { retrieve: true });
    expect(first.tasks[0]).toMatchObject({ status: 'error', retrieved: false });
    expect(readRunManifest(runDir).providers[0]).toMatchObject({
      status: 'error',
      error: 'provider.result_error',
      task: {
        status: 'failed',
        retrievalAttempts: 1,
        lastRetrievalAttemptAt: 20,
        lastRetrievalError: 'provider.result_error',
      },
    });
    expect(
      existsSync(
        join(runDir, providerArtifactFileNames('brave-search').outputFile),
      ),
    ).toBe(false);

    const second = await service.reconcileOnce(runDir, { retrieve: true });
    expect(second.retrieved).toBe(0);
    expect(retrieve).toHaveBeenCalledOnce();
  });

  it('durably bounds retryable retrieval failures and commits a successful retry', async () => {
    const runDir = makeRun([pending('brave-search', 'bounded', 'completed')]);
    const retrieve = vi
      .fn<ReconciliationBackgroundProvider['retrieve']>()
      .mockRejectedValueOnce(new Error('secret first failure'))
      .mockResolvedValueOnce(successResult('brave-search'));
    let now = 100;
    const service = new RunReconciliationService({
      repository: new RunArtifactRepository(),
      resolveBackgroundProvider: () =>
        provider(async () => ({ status: 'completed' }), retrieve),
      getProviderConfig: () => undefined,
      now: () => now++,
    });

    await service.reconcileOnce(runDir, { retrieve: true });
    expect(readRunManifest(runDir).providers[0]?.task).toMatchObject({
      status: 'completed',
      retrievalAttempts: 1,
      lastRetrievalAttemptAt: 100,
      lastRetrievalError: 'provider.retrieve_failed',
    });
    const second = await service.reconcileOnce(runDir, { retrieve: true });
    expect(second.retrieved).toBe(1);
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(readRunManifest(runDir).providers[0]?.task).toMatchObject({
      retrievalAttempts: 2,
      lastRetrievalAttemptAt: 101,
      retrievedAt: 101,
    });
  });

  it('terminalizes after three failed retrieval calls', async () => {
    const runDir = makeRun([pending('brave-search', 'bounded', 'completed')]);
    const retrieve = vi.fn(async () => {
      throw new Error('never persist this');
    });
    let now = 200;
    const service = new RunReconciliationService({
      repository: new RunArtifactRepository(),
      resolveBackgroundProvider: () =>
        provider(async () => ({ status: 'completed' }), retrieve),
      getProviderConfig: () => undefined,
      now: () => now++,
    });
    await service.reconcileOnce(runDir, { retrieve: true });
    await service.reconcileOnce(runDir, { retrieve: true });
    await service.reconcileOnce(runDir, { retrieve: true });
    await service.reconcileOnce(runDir, { retrieve: true });
    expect(retrieve).toHaveBeenCalledTimes(3);
    expect(readRunManifest(runDir).providers[0]).toMatchObject({
      error: 'provider.retrieve_failed',
      task: { status: 'failed', retrievalAttempts: 3 },
    });
  });

  it('increments retrieval diagnostics monotonically across competing updates', async () => {
    const runDir = makeRun([pending('brave-search', 'race', 'completed')]);
    const repository = new RunArtifactRepository();
    await Promise.all([
      Promise.resolve().then(() =>
        repository.recordRetrievalFailure(
          runDir,
          'brave-search',
          'race',
          'provider.retrieve_failed',
          10,
          false,
        ),
      ),
      Promise.resolve().then(() =>
        repository.recordRetrievalFailure(
          runDir,
          'brave-search',
          'race',
          'provider.retrieve_failed',
          11,
          false,
        ),
      ),
    ]);
    expect(readRunManifest(runDir).providers[0]?.task).toMatchObject({
      retrievalAttempts: 2,
      lastRetrievalAttemptAt: 11,
      lastRetrievalError: 'provider.retrieve_failed',
    });
  });

  it('terminalizes unsupported providers without invoking a resolver-owned provider', async () => {
    const runDir = makeRun([pending('retired-provider', 'unsupported')]);
    const resolver = vi.fn(() => undefined);
    const service = new RunReconciliationService({
      repository: new RunArtifactRepository(),
      resolveBackgroundProvider: resolver,
      getProviderConfig: () => undefined,
      now: () => 30,
    });
    const result = await service.reconcileOnce(runDir);
    expect(resolver).toHaveBeenCalledWith('retired-provider');
    expect(result.tasks[0]).toMatchObject({
      status: 'unsupported',
      error: 'provider.unavailable',
    });
    expect(readRunManifest(runDir).providers[0]).toMatchObject({
      status: 'error',
      error: 'provider.unavailable',
      task: { status: 'failed', providerStatus: 'unsupported_provider' },
    });
  });

  it('fails a pre-existing completed task once when its provider is unavailable', async () => {
    const runDir = makeRun([
      pending('retired-provider', 'completed-unsupported', 'completed'),
    ]);
    const repository = new RunArtifactRepository();
    const resolver = vi.fn(() => undefined);
    const service = new RunReconciliationService({
      repository,
      resolveBackgroundProvider: resolver,
      getProviderConfig: () => undefined,
      now: () => 31,
    });
    const first = await service.reconcileOnce(runDir, { retrieve: true });
    const manifest = readRunManifest(runDir);
    expect(first.tasks[0]).toMatchObject({
      status: 'unsupported',
      error: 'provider.unavailable',
    });
    expect(manifest.providers[0]).toMatchObject({
      status: 'error',
      error: 'provider.unavailable',
      task: {
        status: 'failed',
        completedAt: 31,
        lastPollError: 'provider.unavailable',
      },
    });
    const revision = manifest.revision;
    const second = await service.reconcileOnce(runDir, { retrieve: true });
    expect(second.tasks[0]?.status).toBe('failed');
    expect(readRunManifest(runDir).revision).toBe(revision);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('calls regeneration once with pre-existing derived artifact flags and reports failures without rollback', async () => {
    const runDir = makeRun([pending('brave-search', 'regen', 'completed')]);
    writeFileSync(join(runDir, 'summary.md'), 'old summary');
    writeFileSync(join(runDir, 'report.html'), 'old html');
    const regenerate = vi.fn(async () => {
      throw new Error('renderer unavailable');
    });
    const service = new RunReconciliationService({
      repository: new RunArtifactRepository(),
      resolveBackgroundProvider: () =>
        provider(
          async () => ({ status: 'completed' }),
          async () => successResult('brave-search'),
        ),
      getProviderConfig: () => undefined,
      now: () => 40,
      regenerateDerivedArtifacts: regenerate,
    });
    const result = await service.reconcileOnce(runDir, { retrieve: true });
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(regenerate.mock.calls[0]?.[0]).toMatchObject({
      refreshSummary: true,
      refreshHtml: true,
      refreshJsonl: false,
    });
    expect(result).toMatchObject({
      retrieved: 1,
      regenerated: false,
      regenerationError: 'artifact.regeneration_failed',
    });
    expect(readRunManifest(runDir).providers[0]?.task?.retrievedAt).toBe(40);
  });

  it('continues after one provider result failure and keeps output deterministic', async () => {
    const runDir = makeRun([
      pending('bad-provider', 'bad', 'completed'),
      pending('good-provider', 'good', 'completed'),
    ]);
    const service = new RunReconciliationService({
      repository: new RunArtifactRepository(),
      resolveBackgroundProvider: (id) =>
        provider(
          async () => ({ status: 'completed' }),
          async () =>
            id === 'bad-provider'
              ? ({
                  ...successResult(id),
                  provider: 'wrong-provider',
                } as ProviderResult)
              : successResult(id),
        ),
      getProviderConfig: () => undefined,
      now: () => 50,
    });
    const result = await service.reconcileOnce(runDir, { retrieve: true });
    expect(result.retrieved).toBe(1);
    expect(result.tasks).toMatchObject([
      { provider: 'bad-provider', status: 'error', retrieved: false },
      { provider: 'good-provider', status: 'retrieved', retrieved: true },
    ]);
    expect(readRunManifest(runDir).providers[0]?.task).toMatchObject({
      status: 'failed',
      retrievalAttempts: 1,
      lastRetrievalError: 'provider.result_invalid',
    });
    expect(readRunManifest(runDir).providers[1]?.task?.retrievedAt).toBe(50);
  });

  it('terminalizes invalid provider config immediately', async () => {
    const runDir = makeRun([
      pending('brave-search', 'invalid-config', 'completed'),
    ]);
    const retrieve = vi.fn(async () => successResult('brave-search'));
    const service = new RunReconciliationService({
      repository: new RunArtifactRepository(),
      resolveBackgroundProvider: () =>
        provider(async () => ({ status: 'completed' }), retrieve),
      getProviderConfig: () => ({ options: 'not-an-object' }) as never,
      now: () => 60,
    });

    await service.reconcileOnce(runDir, { retrieve: true });
    expect(readRunManifest(runDir).providers[0]).toMatchObject({
      status: 'error',
      error: 'provider.config_invalid',
      task: {
        status: 'failed',
        retrievalAttempts: 1,
        lastRetrievalError: 'provider.config_invalid',
      },
    });
    await service.reconcileOnce(runDir, { retrieve: true });
    expect(retrieve).toHaveBeenCalledOnce();
  });

  it('rejects an invalid injected timestamp before any poll mutation', async () => {
    const runDir = makeRun([pending('brave-search', 'bad-clock')]);
    const poll = vi.fn(async () => ({ status: 'completed' as const }));
    const service = new RunReconciliationService({
      repository: new RunArtifactRepository(),
      resolveBackgroundProvider: () =>
        provider(poll, async () => successResult('brave-search')),
      getProviderConfig: () => undefined,
      now: () => Number.NaN,
    });
    const before = readFileSync(join(runDir, 'run.json'), 'utf8');
    const result = await service.reconcileOnce(runDir);
    expect(result.tasks[0]).toMatchObject({
      status: 'pending',
      error: 'provider.poll_failed',
    });
    expect(poll).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(runDir, 'run.json'), 'utf8')).toBe(before);
  });

  it('strictly rejects duplicate provider identities before resolver or clock effects', async () => {
    const runDir = makeRun([
      pending('duplicate-provider', 'one'),
      pending('duplicate-provider', 'two'),
    ]);
    const resolver = vi.fn(() => undefined);
    const now = vi.fn(() => 99);
    const service = new RunReconciliationService({
      repository: new RunArtifactRepository(),
      resolveBackgroundProvider: resolver,
      getProviderConfig: () => undefined,
      now,
    });
    await expect(service.reconcileOnce(runDir)).rejects.toBeInstanceOf(
      RunManifestError,
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  it('strictly rejects duplicate provider/task identities before retrieval', async () => {
    const runDir = makeRun([
      pending('duplicate-provider', 'same'),
      pending('duplicate-provider', 'same'),
    ]);
    const repository = new RunArtifactRepository();
    expect(() => repository.readManifest(runDir)).toThrow(RunManifestError);
  });

  it('keeps poll task state monotonic and does not bump revision for stale updates', () => {
    const runDir = makeRun([pending('monotonic-provider', 'monotonic')]);
    const repository = new RunArtifactRepository();
    repository.updateTask(
      runDir,
      'monotonic-provider',
      'monotonic',
      { status: 'running', lastPolledAt: 10 },
      10,
    );
    const running = readRunManifest(runDir);
    expect(running.providers[0]?.task?.status).toBe('running');
    repository.updateTask(
      runDir,
      'monotonic-provider',
      'monotonic',
      { status: 'pending', lastPolledAt: 1 },
      11,
    );
    const afterRegression = readRunManifest(runDir);
    expect(afterRegression.providers[0]?.task?.status).toBe('running');
    expect(afterRegression.revision).toBe(running.revision);
    repository.updateTask(
      runDir,
      'monotonic-provider',
      'monotonic',
      { status: 'completed', completedAt: 12 },
      12,
    );
    const completed = readRunManifest(runDir);
    repository.updateTask(
      runDir,
      'monotonic-provider',
      'monotonic',
      { status: 'running', lastPollError: 'ignored' },
      13,
    );
    const afterTerminal = readRunManifest(runDir);
    expect(afterTerminal.providers[0]?.task?.status).toBe('completed');
    expect(afterTerminal.revision).toBe(completed.revision);
  });
});
