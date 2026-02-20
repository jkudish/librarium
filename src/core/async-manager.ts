import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AsyncTaskHandle } from '../types.js';
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
          tasks.push(task);
        }
      }
    } catch {}
  }

  return tasks;
}
