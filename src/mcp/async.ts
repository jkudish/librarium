import {
  getExactProvider,
  initializeProviders,
} from '../adapters/node-registry.js';
import type { ResearchResponse } from '../contracts/interchange/research-response.js';
import { generateSlug } from '../core/prompt-builder.js';
import { writeCanonicalPresentationArtifacts } from '../node-canonical-artifacts.js';
import {
  canonicalRunsRoot,
  createNodeCoordinatorDependencies,
  createRegisteredProviderAttemptBridge,
  readCanonicalRunManifest,
  readRunJsonSchemaVersion,
  resumeCanonicalPreparedExecution,
} from '../node-canonical-run.js';
import { createNodeCredentialContext } from '../node-credentials.js';
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
  state?: 'pending' | 'terminal';
  response?: ResearchResponse;
}

export interface CheckAsyncDependencies {
  readonly initialize?: typeof initializeProviders;
  readonly resolveExactProvider?: typeof getExactProvider;
  readonly resumeCanonical?: typeof resumeCanonicalPreparedExecution;
  readonly writeArtifacts?: typeof writeCanonicalPresentationArtifacts;
  readonly onError?: (error: unknown) => void;
  readonly coordinator?: ReturnType<typeof createNodeCoordinatorDependencies>;
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
  dependencies: CheckAsyncDependencies = {},
): Promise<CheckAsyncResult> {
  if (!config && process.env.NODE_ENV !== 'test') {
    throw new Error('check_async requires merged provider configuration');
  }
  try {
    const runsRoot = canonicalRunsRoot(runDir);
    const schemaVersion = readRunJsonSchemaVersion(runsRoot, runDir);
    if (schemaVersion === 3) {
      if (!config) throw new Error('Canonical resume requires configuration.');
      const before = readCanonicalRunManifest(runsRoot, runDir);
      const admittedAdapterIds = [
        ...new Set(
          Object.values(
            before.coordination_state.profile_plans_by_identity,
          ).map((plan) => plan.binding.adapter_id),
        ),
      ];
      const initialize = dependencies.initialize ?? initializeProviders;
      await initialize(
        { ...config, credentials: createNodeCredentialContext() },
        { customProviderIds: admittedAdapterIds },
      );
      const resolveExactProvider =
        dependencies.resolveExactProvider ?? getExactProvider;
      const resume =
        dependencies.resumeCanonical ?? resumeCanonicalPreparedExecution;
      const canonical = await resume({
        runs_root: runsRoot,
        run_directory: runDir,
        coordinator:
          dependencies.coordinator ?? createNodeCoordinatorDependencies(),
        attempt_bridge: createRegisteredProviderAttemptBridge(
          {
            request: before.request,
            catalog: { digest: before.coordination_state.catalog_digest },
            profile_plans_by_identity:
              before.coordination_state.profile_plans_by_identity,
          },
          resolveExactProvider,
        ),
      });
      const afterResults =
        canonical.manifest.terminal_response?.results.length ?? 0;
      const beforeResults = before.terminal_response?.results.length ?? 0;
      const activeBefore = before.coordination_state.attempts.filter(
        (attempt) =>
          attempt.durable_handle &&
          ['pending', 'running'].includes(attempt.durable_handle.status),
      ).length;
      const writeArtifacts =
        dependencies.writeArtifacts ?? writeCanonicalPresentationArtifacts;
      writeArtifacts(
        canonical.manifest,
        runDir,
        generateSlug(canonical.manifest.request.query),
      );
      return {
        runDir,
        polled: activeBefore,
        retrieved: Math.max(0, afterResults - beforeResults),
        tasks: [],
        state:
          canonical.manifest.coordination_state.status === 'running'
            ? 'pending'
            : 'terminal',
        ...(canonical.response && { response: canonical.response }),
      };
    }
    if (schemaVersion !== 2) {
      throw new Error('Unsupported run.json schema version.');
    }
    if (config) {
      await (dependencies.initialize ?? initializeProviders)({
        ...config,
        credentials: createNodeCredentialContext(),
      });
    }
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
  } catch (error) {
    dependencies.onError?.(error);
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
