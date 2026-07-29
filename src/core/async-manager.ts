import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AsyncPollResult,
  AsyncTaskHandle,
  AsyncTaskStatus,
} from '../types.js';
import { safeWriteFile } from './fs-utils.js';

const ASYNC_TASKS_FILE = 'async-tasks.json';

/**
 * Load async tasks from an output directory
 */
export function loadAsyncTasks(outputDir: string): AsyncTaskHandle[] {
  const path = join(outputDir, ASYNC_TASKS_FILE);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Save async tasks to an output directory
 */
export function saveAsyncTasks(
  outputDir: string,
  tasks: AsyncTaskHandle[],
): void {
  const path = join(outputDir, ASYNC_TASKS_FILE);
  safeWriteFile(path, JSON.stringify(tasks, null, 2));
}

/**
 * Update a specific task in the list
 */
export function updateAsyncTask(
  outputDir: string,
  taskId: string,
  updates: Partial<AsyncTaskHandle>,
): AsyncTaskHandle | null {
  const tasks = loadAsyncTasks(outputDir);
  const index = tasks.findIndex((t) => t.taskId === taskId);
  if (index === -1) return null;

  tasks[index] = { ...tasks[index], ...updates };
  saveAsyncTasks(outputDir, tasks);
  return tasks[index];
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
  if (!existsSync(baseOutputDir)) return [];

  const entries = readdirSync(baseOutputDir);
  const tasks: AsyncTaskHandle[] = [];

  for (const entry of entries) {
    const dir = join(baseOutputDir, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const dirTasks = loadAsyncTasks(dir);
      for (const task of dirTasks) {
        if (task.status === 'pending' || task.status === 'running') {
          if (!task.outputDir) task.outputDir = dir;
          tasks.push(task);
        }
      }
    } catch {}
  }

  return tasks;
}
