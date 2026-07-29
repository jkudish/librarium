import { join } from 'node:path';
import { getExactProvider } from '../adapters/node-registry.js';
import { sanitizeId } from '../constants.js';
import {
  asyncPollFailureUpdates,
  asyncPollUpdates,
  loadAsyncTasks,
  saveAsyncTasks,
  updateAsyncTask,
} from '../core/async-manager.js';
import { normalizeUsage } from '../core/dispatcher.js';
import { safeWriteFile } from '../core/fs-utils.js';
import { buildProviderMetering } from '../core/metering.js';
import { updateRunManifestAfterRetrieve } from '../core/retrieval-manifest.js';
import type {
  AsyncTaskHandle,
  AsyncTaskStatus,
  ProviderReport,
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
  providerStatus?: string;
  lastPolledAt?: number;
}

export interface CheckAsyncResult {
  runDir: string;
  polled: number;
  retrieved: number;
  tasks: TaskState[];
}

/** Retrieve one completed task silently; returns true on success. */
async function retrieveTaskSilent(
  task: AsyncTaskHandle,
  dir: string,
  state: TaskState,
): Promise<boolean> {
  const provider = getExactProvider(task.provider);
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
    // Same metering normalization path as sync dispatch and `status --retrieve`,
    // so MCP-retrieved async results carry metering on run.json/.meta.json too.
    const metering = buildProviderMetering(task.provider, undefined, usage);

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
          metering,
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
      metering,
    };
    if (!updateRunManifestAfterRetrieve(dir, report, task.taskId)) {
      state.retrieveError = 'Retrieved result, but could not update run.json';
      return false;
    }

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
      ...(task.providerStatus ? { providerStatus: task.providerStatus } : {}),
      ...(task.lastPolledAt ? { lastPolledAt: task.lastPolledAt } : {}),
      ...(task.lastPollError ? { error: task.lastPollError } : {}),
    };

    if (task.status === 'pending' || task.status === 'running') {
      const provider = getExactProvider(task.provider);
      if (provider?.poll) {
        polled++;
        try {
          const poll = await provider.poll(task);
          const updated = updateAsyncTask(
            runDir,
            task.taskId,
            asyncPollUpdates(poll),
          );
          Object.assign(task, updated ?? asyncPollUpdates(poll));
          state.status = task.status;
          state.completedAt = task.completedAt;
          state.providerStatus = task.providerStatus;
          state.lastPolledAt = task.lastPolledAt;
          state.error = task.lastPollError;
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          const updated = updateAsyncTask(
            runDir,
            task.taskId,
            asyncPollFailureUpdates(error),
          );
          Object.assign(task, updated ?? asyncPollFailureUpdates(error));
          state.lastPolledAt = task.lastPolledAt;
          state.error = task.lastPollError;
        }
      } else {
        const error = `Provider ${task.provider} does not support polling after this upgrade`;
        const updated = updateAsyncTask(
          runDir,
          task.taskId,
          asyncPollUpdates({
            status: 'failed',
            rawStatus: 'unsupported_provider',
            message: error,
          }),
        );
        Object.assign(
          task,
          updated ??
            asyncPollUpdates({
              status: 'failed',
              rawStatus: 'unsupported_provider',
              message: error,
            }),
        );
        state.status = task.status;
        state.completedAt = task.completedAt;
        state.providerStatus = task.providerStatus;
        state.lastPolledAt = task.lastPolledAt;
        state.error = task.lastPollError;
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
