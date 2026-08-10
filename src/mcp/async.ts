import {
  createNodeRunReconciliationRuntime,
  type ReconciliationResult,
} from '../node-run-reconciliation-runtime.js';
import type { AsyncTaskStatus, Config } from '../types.js';

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
  /** Fixed diagnostic only; never a provider or filesystem error string. */
  error?: 'artifact.reconciliation_failed';
  regenerationError?: 'artifact.regeneration_failed';
}

function taskState(result: ReconciliationResult): TaskState[] {
  return result.tasks.map((task) => ({
    provider: task.provider,
    taskId: task.taskId,
    // The MCP contract has always exposed durable task states, not the
    // service's transport outcomes. A retrieved task therefore remains
    // completed with an additive retrieved flag.
    status:
      task.status === 'retrieved'
        ? 'completed'
        : task.status === 'unsupported'
          ? 'failed'
          : task.status === 'error' && task.completedAt !== undefined
            ? 'completed'
            : (task.status as AsyncTaskStatus),
    submittedAt: task.submittedAt,
    ...(task.completedAt === undefined
      ? {}
      : { completedAt: task.completedAt }),
    ...(task.retrieved ? { retrieved: true } : {}),
    ...(task.error === undefined
      ? {}
      : task.status === 'error' && task.completedAt !== undefined
        ? { retrieveError: task.error }
        : { error: task.error }),
    ...(task.providerStatus === undefined
      ? {}
      : { providerStatus: task.providerStatus }),
    ...(task.lastPolledAt === undefined
      ? {}
      : { lastPolledAt: task.lastPolledAt }),
  }));
}

/**
 * One poll pass over a run directory's pending tasks, optionally retrieving
 * completed ones. Returns per-task states. Never blocks.
 */
export async function checkAsyncTasks(
  runDir: string,
  retrieve: boolean,
  config?: Config,
): Promise<CheckAsyncResult> {
  if (!config && process.env.NODE_ENV !== 'test') {
    throw new Error('check_async requires merged provider configuration');
  }
  try {
    const runtime = createNodeRunReconciliationRuntime(
      config ?? {
        version: 1,
        defaults: {
          outputDir: '',
          maxParallel: 1,
          timeout: 30,
          asyncTimeout: 1800,
          asyncPollInterval: 10,
          mode: 'mixed',
          llmWebSearch: true,
        },
        providers: {},
        customProviders: {},
        trustedProviderIds: [],
        groups: {},
      },
    );
    const result = await runtime.service.reconcileOnce(runDir, { retrieve });
    return {
      runDir: result.runDir,
      polled: result.polled,
      retrieved: result.retrieved,
      tasks: taskState(result),
      ...(result.regenerationError === undefined
        ? {}
        : { regenerationError: 'artifact.regeneration_failed' as const }),
    };
  } catch {
    // check_async remains a best-effort, protocol-safe inspection endpoint.
    return {
      runDir,
      polled: 0,
      retrieved: 0,
      tasks: [],
      error: 'artifact.reconciliation_failed',
    };
  }
}
