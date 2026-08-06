import type {
  AsyncPollResult,
  AsyncTaskHandle,
  AsyncTaskStatus,
} from '../types.js';
import {
  createRunManifest,
  discoverRunTasks,
  loadRunTasks,
  mutateRunManifest,
  toRunTaskState,
  tryReadRunManifest,
  updateRunTask,
} from './run-manifest.js';

/**
 * Load async tasks from an output directory
 */
export function loadAsyncTasks(outputDir: string): AsyncTaskHandle[] {
  try {
    return loadRunTasks(outputDir);
  } catch {
    return [];
  }
}

/** @internal Seed embedded task state; retained for internal callers/tests. */
export function saveAsyncTasks(
  outputDir: string,
  tasks: AsyncTaskHandle[],
): void {
  const providers = tasks.map((task) => ({
    id: task.provider,
    tier: 'deep-research' as const,
    status: 'async-pending' as const,
    durationMs: 0,
    wordCount: 0,
    citationCount: 0,
    outputFile: '',
    metaFile: '',
    task: toRunTaskState(task),
  }));
  const current = tryReadRunManifest(outputDir);
  if (!current) {
    createRunManifest(outputDir, {
      status: 'awaiting_async',
      timestamp: Math.floor(Date.now() / 1000),
      slug: 'async-run',
      query: tasks[0]?.query ?? '',
      mode: 'async',
      outputDir,
      providers,
      sources: { total: 0, unique: 0, file: 'sources.json' },
      exitCode: null,
    });
    return;
  }
  mutateRunManifest(outputDir, (manifest) => {
    manifest.providers = providers;
    manifest.status = 'awaiting_async';
    manifest.exitCode = null;
  });
}

/**
 * Update a specific task in the list
 */
export function updateAsyncTask(
  outputDir: string,
  providerId: string,
  taskId: string,
  updates: Partial<AsyncTaskHandle>,
): AsyncTaskHandle | null {
  return updateRunTask(outputDir, providerId, taskId, updates);
}

export function isAsyncTaskTerminal(status: AsyncTaskStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

/**
 * Convert one provider poll response into durable task fields. The caller owns
 * the file write, which lets CLI and MCP share terminal/error semantics.
 */
export function asyncPollUpdates(
  poll: AsyncPollResult,
  now = Date.now(),
): Partial<AsyncTaskHandle> {
  return {
    status: poll.status,
    lastPolledAt: now,
    ...(poll.rawStatus !== undefined ? { providerStatus: poll.rawStatus } : {}),
    ...(poll.message !== undefined
      ? { lastPollError: poll.message }
      : { lastPollError: undefined }),
    ...(isAsyncTaskTerminal(poll.status) ? { completedAt: now } : {}),
  };
}

/** Durable diagnostic for a poll attempt that could not reach the provider. */
export function asyncPollFailureUpdates(
  error: string,
  now = Date.now(),
): Partial<AsyncTaskHandle> {
  return { lastPolledAt: now, lastPollError: error };
}

/**
 * Get all pending/running async tasks across all output directories
 */
export function getPendingTasks(baseOutputDir: string): AsyncTaskHandle[] {
  return discoverRunTasks(
    baseOutputDir,
    new Set<AsyncTaskStatus>(['pending', 'running']),
  );
}
