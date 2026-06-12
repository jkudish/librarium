import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProvider } from '../adapters/node-registry.js';
import { sanitizeId } from '../constants.js';
import {
  loadAsyncTasks,
  saveAsyncTasks,
  updateAsyncTask,
} from '../core/async-manager.js';
import { normalizeUsage } from '../core/dispatcher.js';
import { safeWriteFile } from '../core/fs-utils.js';
import { deduplicateSources } from '../core/normalizer.js';
import type {
  AsyncTaskHandle,
  AsyncTaskStatus,
  Citation,
  ProviderReport,
  RunManifest,
} from '../types.js';

/**
 * Silent async polling + retrieval for the MCP `check_async` tool. One poll
 * pass over pending tasks (no blocking --wait loop), optionally retrieving any
 * completed tasks through the same path the CLI uses (which folds results back
 * into run.json / sources.json). No stdout writes.
 */

export interface TaskState {
  provider: string;
  taskId: string;
  status: AsyncTaskStatus;
  submittedAt: number;
  completedAt?: number;
  retrieved?: boolean;
  retrieveError?: string;
  error?: string;
}

export interface CheckAsyncResult {
  runDir: string;
  polled: number;
  retrieved: number;
  tasks: TaskState[];
}

/**
 * After a successful retrieval, update run.json's provider entry and rebuild
 * sources.json from every .meta.json in the run directory. Mirrors
 * status.ts:updateManifestAfterRetrieve (kept silent and self-contained).
 */
function updateManifestAfterRetrieve(
  dir: string,
  report: ProviderReport,
): void {
  const manifestPath = join(dir, 'run.json');
  if (!existsSync(manifestPath)) return;
  try {
    const manifest = JSON.parse(
      readFileSync(manifestPath, 'utf8'),
    ) as RunManifest;
    const index = manifest.providers.findIndex(
      (p) => p.id === report.id && p.status === 'async-pending',
    );
    if (index >= 0) manifest.providers[index] = report;

    const allCitations: Citation[] = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.meta.json')) continue;
      try {
        const meta = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as {
          citations?: Citation[];
        };
        if (Array.isArray(meta.citations)) allCitations.push(...meta.citations);
      } catch {}
    }
    const sources = deduplicateSources(allCitations);
    safeWriteFile(join(dir, 'sources.json'), JSON.stringify(sources, null, 2));
    manifest.sources = {
      total: allCitations.length,
      unique: sources.length,
      file: 'sources.json',
    };
    safeWriteFile(manifestPath, JSON.stringify(manifest, null, 2));
  } catch {
    // A malformed manifest must never block retrieval.
  }
}

/** Retrieve one completed task silently; returns true on success. */
async function retrieveTaskSilent(
  task: AsyncTaskHandle,
  dir: string,
  state: TaskState,
): Promise<boolean> {
  const provider = getProvider(task.provider);
  if (!provider?.retrieve) {
    state.retrieveError = `Provider ${task.provider} does not support retrieval`;
    return false;
  }
  try {
    const result = await provider.retrieve(task);
    if (result.error) {
      state.retrieveError = result.error;
      return false;
    }
    const safeId = sanitizeId(task.provider);
    const outputFile = `${safeId}.md`;
    const metaFile = `${safeId}.meta.json`;
    const usage = normalizeUsage(result);

    safeWriteFile(join(dir, outputFile), result.content);
    safeWriteFile(
      join(dir, metaFile),
      JSON.stringify(
        {
          provider: result.provider,
          tier: result.tier,
          model: result.model,
          durationMs: result.durationMs,
          citationCount: result.citations.length,
          tokenUsage: result.tokenUsage,
          usage,
          citations: result.citations,
        },
        null,
        2,
      ),
    );

    const report: ProviderReport = {
      id: task.provider,
      tier: result.tier,
      status: 'success',
      durationMs: result.durationMs,
      wordCount: result.content.split(/\s+/).filter(Boolean).length,
      citationCount: result.citations.length,
      outputFile,
      metaFile,
      usage,
    };
    updateManifestAfterRetrieve(dir, report);

    const remaining = loadAsyncTasks(dir).filter(
      (t) => t.taskId !== task.taskId,
    );
    saveAsyncTasks(dir, remaining);
    state.retrieved = true;
    return true;
  } catch (e) {
    state.retrieveError = e instanceof Error ? e.message : String(e);
    return false;
  }
}

/**
 * One poll pass over a run directory's pending tasks, optionally retrieving
 * completed ones. Returns per-task states. Never blocks.
 */
export async function checkAsyncTasks(
  runDir: string,
  retrieve: boolean,
): Promise<CheckAsyncResult> {
  const tasks = loadAsyncTasks(runDir);
  const states: TaskState[] = [];
  let polled = 0;
  let retrieved = 0;

  for (const task of tasks) {
    const state: TaskState = {
      provider: task.provider,
      taskId: task.taskId,
      status: task.status,
      submittedAt: task.submittedAt,
      ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    };

    if (task.status === 'pending' || task.status === 'running') {
      const provider = getProvider(task.provider);
      if (provider?.poll) {
        polled++;
        try {
          const poll = await provider.poll(task);
          state.status = poll.status;
          if (poll.status === 'completed' || poll.status === 'failed') {
            updateAsyncTask(runDir, task.taskId, {
              status: poll.status,
              completedAt: Date.now(),
            });
            task.status = poll.status;
            if (poll.status === 'failed') {
              state.error = poll.message ?? 'task failed';
            }
          } else {
            updateAsyncTask(runDir, task.taskId, {
              status: poll.status,
              lastPolledAt: Date.now(),
            });
          }
        } catch (e) {
          state.error = e instanceof Error ? e.message : String(e);
        }
      } else {
        state.error = `Provider ${task.provider} does not support polling`;
      }
    }

    if (retrieve && state.status === 'completed') {
      const ok = await retrieveTaskSilent(task, runDir, state);
      if (ok) retrieved++;
    }

    states.push(state);
  }

  return { runDir, polled, retrieved, tasks: states };
}
