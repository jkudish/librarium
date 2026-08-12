import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, Provider } from '../src/types.js';

const state = vi.hoisted(() => ({
  outputDir: '',
  submit: vi.fn(),
  poll: vi.fn(),
  retrieve: vi.fn(),
}));

vi.mock('../src/adapters/node-registry.js', () => {
  const provider: Provider = {
    id: 'status-command-mock',
    displayName: 'Status command mock',
    tier: 'deep-research',
    execution: 'background',
    envVar: '',
    execute: async () => ({
      provider: 'status-command-mock',
      tier: 'deep-research',
      content: '',
      citations: [],
      durationMs: 0,
    }),
    poll: (...args) => state.poll(...args),
    retrieve: (...args) => state.retrieve(...args),
    submit: (...args) => state.submit(...args),
  };
  return {
    initializeProviders: vi.fn(async () => ({
      warnings: [],
      loadedCustomProviders: [],
      skippedCustomProviders: [],
    })),
    getExactProvider: vi.fn(() => provider),
    getProvider: vi.fn(() => provider),
  };
});

vi.mock('../src/core/config.js', () => ({
  loadConfig: vi.fn(
    (): Config => ({
      version: 1,
      defaults: {
        outputDir: state.outputDir,
        maxParallel: 1,
        timeout: 30,
        asyncTimeout: 1800,
        asyncPollInterval: 0.001,
        mode: 'mixed',
        llmWebSearch: true,
      },
      providers: { 'status-command-mock': { enabled: true } },
      customProviders: {},
      trustedProviderIds: [],
      groups: {},
    }),
  ),
  loadProjectConfig: vi.fn(() => null),
  mergeConfigs: vi.fn((config: Config) => config),
}));

import { registerStatusCommand } from '../src/commands/status.js';
import { loadAsyncTasks, saveAsyncTasks } from '../src/core/async-manager.js';
import {
  advanceCoordination,
  createCoordinatorState,
  recordLaunchDispatched,
} from '../src/core/coordinator.js';
import type { PreparedResearchExecution } from '../src/core/execution-plan.js';
import {
  RunJsonCoordinationStateStore,
  readCanonicalRunManifest,
  runCanonicalPreparedExecution,
} from '../src/node-canonical-run.js';
import { providerArtifactFileNames } from '../src/node-run-artifacts.js';
import {
  canonicalFixtureCoordinator,
  canonicalFixturePrepared,
  canonicalFixtureProfile,
  canonicalFixtureResult,
} from './fixtures/canonical-run.js';

function program(): Command {
  const command = new Command();
  command.name('librarium');
  registerStatusCommand(command);
  return command;
}

function task(status: 'running' | 'completed' = 'running', run = 'run-1') {
  const dir = join(state.outputDir, run);
  mkdirSync(dir, { recursive: true });
  saveAsyncTasks(dir, [
    {
      provider: 'status-command-mock',
      taskId: 'task-1',
      query: 'q',
      submittedAt: 1,
      status,
      outputDir: dir,
    },
  ]);
  return dir;
}

function canonicalPlan(
  mode: 'sync' | 'async',
  requestId: string,
  now: number,
): PreparedResearchExecution {
  const profile = canonicalFixtureProfile(
    requestId,
    mode === 'async' ? 'background' : 'inline',
  );
  const plan = canonicalFixturePrepared([profile], {
    mode,
    requestId,
    requestedAtMs: now,
  });
  return {
    ...plan,
    profile_plans_by_identity: Object.fromEntries(
      Object.entries(plan.profile_plans_by_identity).map(([key, value]) => [
        key,
        {
          ...value,
          binding: {
            adapter_id: 'status-command-mock',
            binding_id: `binding-${requestId}`,
          },
        },
      ]),
    ),
  };
}

function canonicalBridge(
  plan: PreparedResearchExecution,
  provider: Provider,
  now: number,
) {
  const profile = plan.request.slots[0]!.primary;
  return {
    resolveExactBinding(binding: { adapter_id: string; binding_id: string }) {
      return binding.adapter_id === provider.id
        ? {
            binding,
            profile,
            catalog_digest: plan.catalog.digest,
            provider,
          }
        : undefined;
    },
    now: () => now,
    wait: async () => {},
  };
}

async function seedCanonicalRun(
  run: string,
  mode: 'sync' | 'async',
): Promise<{ runDir: string; plan: PreparedResearchExecution; now: number }> {
  const now = Date.now();
  const runDir = join(state.outputDir, run);
  mkdirSync(runDir, { recursive: true });
  const plan = canonicalPlan(mode, run, now);
  const provider: Provider = {
    id: 'status-command-mock',
    displayName: 'Status command mock',
    tier: mode === 'async' ? 'deep-research' : 'ai-grounded',
    envVar: '',
    execution: mode === 'async' ? 'background' : 'inline',
    execute: async () => canonicalFixtureResult('status-command-mock'),
    ...(mode === 'async'
      ? {
          submit: (...args: Parameters<NonNullable<Provider['submit']>>) =>
            state.submit(...args),
          poll: (...args: Parameters<NonNullable<Provider['poll']>>) =>
            state.poll(...args),
          retrieve: (...args: Parameters<NonNullable<Provider['retrieve']>>) =>
            state.retrieve(...args),
        }
      : {}),
  };
  await runCanonicalPreparedExecution(plan, {
    runs_root: state.outputDir,
    run_directory: runDir,
    coordinator: canonicalFixtureCoordinator(now),
    attempt_bridge: canonicalBridge(plan, provider, now),
  });
  return { runDir, plan, now };
}

describe('status command', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    state.outputDir = join(
      tmpdir(),
      `librarium-status-command-${randomUUID().slice(0, 8)}`,
    );
    dirs.push(state.outputDir);
    state.poll.mockReset().mockResolvedValue({
      status: 'completed',
      rawStatus: 'COMPLETED',
    });
    state.retrieve.mockReset().mockResolvedValue({
      provider: 'status-command-mock',
      tier: 'deep-research',
      content: 'Completed research.',
      citations: [],
      durationMs: 25,
      model: 'mock-model',
    });
    state.submit.mockReset().mockImplementation(async (query: string) => ({
      provider: 'status-command-mock',
      taskId: 'canonical-task',
      query,
      submittedAt: Date.now(),
      status: 'pending',
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('plain status reconciles and persists remote completion', async () => {
    const dir = task();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await program().parseAsync(['node', 'test', 'status']);

    expect(loadAsyncTasks(dir)[0]).toMatchObject({
      status: 'completed',
      providerStatus: 'COMPLETED',
    });
    expect(state.poll).toHaveBeenCalledTimes(1);
  });

  it('--json keeps stdout to one parseable JSON document', async () => {
    task();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await program().parseAsync(['node', 'test', 'status', '--json']);

    expect(log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.tasks).toEqual([
      expect.objectContaining({ taskId: 'task-1', status: 'completed' }),
    ]);
  });

  it('--retrieve writes the result and removes the completed task', async () => {
    const dir = task('completed');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await program().parseAsync(['node', 'test', 'status', '--retrieve']);

    expect(state.retrieve).toHaveBeenCalledTimes(1);
    expect(
      readFileSync(
        join(dir, providerArtifactFileNames('status-command-mock').outputFile),
        'utf8',
      ),
    ).toBe('Completed research.');
    expect(loadAsyncTasks(dir)).toEqual([]);
  });

  it('--wait retrieves work completed by an earlier status invocation', async () => {
    const dir = task();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await program().parseAsync(['node', 'test', 'status']);
    expect(loadAsyncTasks(dir)[0]?.status).toBe('completed');

    state.poll.mockClear();
    await program().parseAsync(['node', 'test', 'status', '--wait']);

    expect(state.poll).not.toHaveBeenCalled();
    expect(state.retrieve).toHaveBeenCalledTimes(1);
    expect(
      existsSync(
        join(dir, providerArtifactFileNames('status-command-mock').outputFile),
      ),
    ).toBe(true);
    expect(loadAsyncTasks(dir)).toEqual([]);
  });

  it('--wait does not conflate provider-native task IDs across runs', async () => {
    const firstDir = task('completed', 'run-1');
    const secondDir = task('running', 'run-2');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await program().parseAsync(['node', 'test', 'status', '--wait']);

    expect(state.poll).toHaveBeenCalledTimes(1);
    expect(state.retrieve).toHaveBeenCalledTimes(2);
    expect(loadAsyncTasks(firstDir)).toEqual([]);
    expect(loadAsyncTasks(secondDir)).toEqual([]);
    expect(
      existsSync(
        join(
          firstDir,
          providerArtifactFileNames('status-command-mock').outputFile,
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          secondDir,
          providerArtifactFileNames('status-command-mock').outputFile,
        ),
      ),
    ).toBe(true);
  });

  it('keeps terminal v3 status private and does not change its revision', async () => {
    const { runDir } = await seedCanonicalRun('terminal-v3', 'sync');
    const before = readCanonicalRunManifest(state.outputDir, runDir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await program().parseAsync(['node', 'test', 'status', '--json']);

    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.canonicalRuns).toEqual([
      expect.objectContaining({
        runDir: realpathSync(runDir),
        state: 'terminal',
        response: expect.objectContaining({ status: 'succeeded' }),
      }),
    ]);
    expect(JSON.stringify(payload)).not.toMatch(
      /coordination_state|durable_handle|provider_task_id|delivery_lease/,
    );
    expect(readCanonicalRunManifest(state.outputDir, runDir).revision).toBe(
      before.revision,
    );
    expect(state.submit).not.toHaveBeenCalled();
    expect(state.poll).not.toHaveBeenCalled();
  });

  it('resumes a v3 pending run once without resubmitting', async () => {
    const { runDir } = await seedCanonicalRun('pending-v3', 'async');
    expect(state.submit).toHaveBeenCalledOnce();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await program().parseAsync(['node', 'test', 'status', '--json']);
    const revision = readCanonicalRunManifest(state.outputDir, runDir).revision;
    await program().parseAsync(['node', 'test', 'status', '--json']);

    const latest = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(latest.canonicalRuns[0]).toMatchObject({
      state: 'terminal',
      response: { status: 'succeeded' },
    });
    expect(state.submit).toHaveBeenCalledOnce();
    expect(state.poll).toHaveBeenCalledOnce();
    expect(state.retrieve).toHaveBeenCalledOnce();
    expect(readCanonicalRunManifest(state.outputDir, runDir).revision).toBe(
      revision,
    );
  });

  it('repairs a running non-durable v3 attempt after restart', async () => {
    const now = Date.now();
    const runDir = join(state.outputDir, 'interrupted-v3');
    mkdirSync(runDir, { recursive: true });
    const plan = canonicalPlan('sync', 'interrupted-v3', now);
    const dependencies = canonicalFixtureCoordinator(now);
    const started = advanceCoordination(
      createCoordinatorState(plan, dependencies),
      dependencies,
    );
    const launch = started.launches[0]!;
    const running = recordLaunchDispatched(
      started.state,
      launch.attempt_id,
      launch.delivery_lease_id,
      dependencies,
    );
    const store = new RunJsonCoordinationStateStore({
      runs_root: state.outputDir,
      run_directory: runDir,
      request: plan.request,
    });
    await store.create(running);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await program().parseAsync(['node', 'test', 'status', '--json']);

    const repaired = readCanonicalRunManifest(state.outputDir, runDir);
    expect(repaired.coordination_state.status).toBe('unsuccessful');
    expect(repaired.coordination_state.attempts[0]).toMatchObject({
      status: 'failed',
      error: { code: 'non_durable_execution_interrupted' },
    });
    expect(repaired.terminal_response?.status).toBe('failed');
    expect(state.submit).not.toHaveBeenCalled();
  });
});
