import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, Provider } from '../src/types.js';

const state = vi.hoisted(() => ({
  outputDir: '',
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
    submit: async (query) => ({
      provider: 'status-command-mock',
      taskId: 'unused',
      query,
      submittedAt: Date.now(),
      status: 'pending',
    }),
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
    expect(readFileSync(join(dir, 'status-command-mock.md'), 'utf8')).toBe(
      'Completed research.',
    );
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
    expect(existsSync(join(dir, 'status-command-mock.md'))).toBe(true);
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
    expect(existsSync(join(firstDir, 'status-command-mock.md'))).toBe(true);
    expect(existsSync(join(secondDir, 'status-command-mock.md'))).toBe(true);
  });
});
