import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerProvider } from '../src/adapters/index.js';
import { reconcilePendingTasksOnce } from '../src/commands/status.js';
import type { Provider } from '../src/types.js';
import { seedHistoricalV2AsyncTasks } from './fixtures/historical-v2-run.js';

describe('status reconciliation', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists a completion for standalone status and retrieve callers', async () => {
    const dir = join(tmpdir(), `librarium-status-${randomUUID().slice(0, 8)}`);
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const provider: Provider = {
      id: 'status-reconcile-mock',
      displayName: 'Status reconcile mock',
      tier: 'deep-research',
      execution: 'background',
      envVar: '',
      execute: async () => ({
        provider: 'status-reconcile-mock',
        tier: 'deep-research',
        content: '',
        citations: [],
        durationMs: 0,
      }),
      poll: async () => ({
        status: 'completed',
        rawStatus: 'COMPLETED',
      }),
      submit: async (query) => ({
        provider: 'status-reconcile-mock',
        taskId: 'unused',
        query,
        submittedAt: Date.now(),
        status: 'pending',
      }),
      retrieve: async () => ({
        provider: 'status-reconcile-mock',
        tier: 'deep-research',
        content: '',
        citations: [],
        durationMs: 0,
      }),
    };
    registerProvider(provider);
    const task = {
      provider: provider.id,
      taskId: 'task-1',
      query: 'q',
      submittedAt: 1,
      status: 'running' as const,
      outputDir: dir,
    };
    seedHistoricalV2AsyncTasks(dir, [task]);

    await reconcilePendingTasksOnce([task]);

    const persisted = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    expect(persisted.providers[0].task).toMatchObject({
      status: 'completed',
      providerStatus: 'COMPLETED',
    });
    expect(persisted.providers[0].task.completedAt).toEqual(expect.any(Number));
    expect(persisted.providers[0].task.lastPolledAt).toEqual(
      expect.any(Number),
    );
  });
});
