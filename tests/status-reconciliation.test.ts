import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerProvider } from '../src/adapters/index.js';
import { reconcilePendingTasksOnce } from '../src/commands/status.js';
import { saveAsyncTasks } from '../src/core/async-manager.js';
import type { Provider } from '../src/types.js';

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
    saveAsyncTasks(dir, [task]);

    await reconcilePendingTasksOnce([task]);

    const persisted = JSON.parse(
      readFileSync(join(dir, 'async-tasks.json'), 'utf8'),
    );
    expect(persisted[0]).toMatchObject({
      status: 'completed',
      providerStatus: 'COMPLETED',
    });
    expect(persisted[0].completedAt).toEqual(expect.any(Number));
    expect(persisted[0].lastPolledAt).toEqual(expect.any(Number));
  });
});
