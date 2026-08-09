import type {
  DurableHandle,
  StructuredError,
} from '../contracts/domain/index.js';
import {
  type AttemptFinishedInput,
  type AttemptLaunch,
  type CoordinatorDependencies,
  type CoordinatorState,
  createCoordinatorState,
  recordAcceptanceUnknown,
  recordAttemptFinished,
  recordAttemptRunning,
  recordLaunchDispatched,
  recordSubmissionAccepted,
  resumeCoordination,
} from './coordinator.js';
import {
  type CoordinationStateStore,
  updateCoordinationState,
} from './coordinator-store.js';
import type { PreparedResearchExecution } from './execution-plan.js';

/**
 * The Worker-safe execution port. It receives a launch that was already
 * selected and bound by preparation/coordinator code; implementors must never
 * select a replacement provider or reinterpret its profile.
 */
export interface AttemptExecutionPort {
  execute(
    launch: AttemptLaunch,
    context: AttemptExecutionContext,
  ): Promise<AttemptExecutionResult>;
}

export interface AttemptExecutionContext {
  readonly mode: 'sync' | 'async';
  readonly poll_interval_ms: number;
  submissionAccepted(
    handle: DurableHandle,
    adapterStateRef?: string,
  ): Promise<void>;
  submissionAcceptanceUnknown(adapterStateRef?: string): Promise<void>;
  running(): Promise<void>;
}

export type AttemptExecutionResult =
  | {
      readonly kind: 'finished';
      readonly finished: AttemptFinishedInput;
      /** Private, ingress-owned output. Never projected into ResearchResponse. */
      readonly output?: unknown;
    }
  | { readonly kind: 'acceptance_unknown' }
  | { readonly kind: 'accepted' };

export interface ExecutionRuntimeDependencies {
  readonly store: CoordinationStateStore;
  readonly coordinator: CoordinatorDependencies;
  readonly attempts: AttemptExecutionPort;
  /** A bounded CAS retry budget for each persisted state transition. */
  readonly max_compare_and_swap_attempts?: number;
}

export interface ExecutionRuntimeResult {
  readonly state: CoordinatorState;
  /** Private in-process outputs, keyed by attempt id. */
  readonly outputs_by_attempt: Readonly<Record<string, unknown>>;
}

function executionFailure(error: unknown): StructuredError {
  return {
    code: 'attempt_execution_failed',
    message: error instanceof Error ? error.message : String(error),
    category: 'internal',
    retryable: false,
    fallback_allowed: false,
  };
}

async function transition(
  dependencies: ExecutionRuntimeDependencies,
  requestId: string,
  update: (state: CoordinatorState) => CoordinatorState | undefined,
) {
  return updateCoordinationState(
    dependencies.store,
    requestId,
    update,
    dependencies.max_compare_and_swap_attempts,
  );
}

/**
 * Executes a prepared plan through the injected store and attempt port.
 *
 * Preparation is intentionally outside this module: callers must finish the
 * complete network-free plan before constructing this runner, so no refine,
 * registry, or adapter operation can occur after a failed preflight.
 */
export async function runPreparedExecution(
  prepared: PreparedResearchExecution,
  dependencies: ExecutionRuntimeDependencies,
): Promise<ExecutionRuntimeResult> {
  const initial = createCoordinatorState(prepared, dependencies.coordinator);
  await dependencies.store.create(initial);
  const outputs = new Map<string, unknown>();
  const requestId = initial.request_id;

  const persistLaunchDispatch = async (
    launch: AttemptLaunch,
  ): Promise<boolean> => {
    let dispatched = false;
    await transition(dependencies, requestId, (state) => {
      const attempt = state.attempts.find(
        (candidate) => candidate.attempt_id === launch.attempt_id,
      );
      if (
        attempt?.status !== 'dispatch_pending' ||
        attempt?.delivery_lease_id !== launch.delivery_lease_id
      ) {
        return undefined;
      }
      dispatched = true;
      return recordLaunchDispatched(
        state,
        launch.attempt_id,
        launch.delivery_lease_id,
        dependencies.coordinator,
      );
    });
    return dispatched;
  };

  const executeLaunch = async (launch: AttemptLaunch): Promise<void> => {
    if (!(await persistLaunchDispatch(launch))) return;
    const context: AttemptExecutionContext = {
      mode: prepared.request.mode,
      poll_interval_ms: prepared.policy.limits.poll_interval_ms,
      submissionAccepted: async (handle, adapterStateRef) => {
        await transition(dependencies, requestId, (state) =>
          recordSubmissionAccepted(
            state,
            launch.attempt_id,
            handle,
            dependencies.coordinator,
            adapterStateRef,
          ),
        );
      },
      submissionAcceptanceUnknown: async (adapterStateRef) => {
        await transition(dependencies, requestId, (state) =>
          recordAcceptanceUnknown(
            state,
            launch.attempt_id,
            dependencies.coordinator,
            adapterStateRef,
          ),
        );
      },
      running: async () => {
        await transition(dependencies, requestId, (state) =>
          recordAttemptRunning(
            state,
            launch.attempt_id,
            dependencies.coordinator,
          ),
        );
      },
    };

    try {
      const result = await dependencies.attempts.execute(launch, context);
      if (result.kind === 'finished') {
        const persisted = await transition(dependencies, requestId, (state) =>
          recordAttemptFinished(
            state,
            launch.attempt_id,
            result.finished,
            dependencies.coordinator,
          ),
        );
        const persistedAttempt = persisted.state.attempts.find(
          (attempt) => attempt.attempt_id === launch.attempt_id,
        );
        if (
          result.output !== undefined &&
          result.finished.outcome === 'succeeded' &&
          persistedAttempt?.status === 'succeeded' &&
          persistedAttempt.result_id === result.finished.result_id
        ) {
          outputs.set(launch.attempt_id, result.output);
        }
      }
    } catch (error) {
      await transition(dependencies, requestId, (state) =>
        recordAttemptFinished(
          state,
          launch.attempt_id,
          { outcome: 'failed', error: executionFailure(error) },
          dependencies.coordinator,
        ),
      );
    }
  };

  for (;;) {
    const advanced = await resumeCoordination(
      dependencies.store,
      requestId,
      dependencies.coordinator,
      dependencies.max_compare_and_swap_attempts,
    );
    const state = advanced.state;

    if (advanced.launches.length > 0) {
      await Promise.all(advanced.launches.map(executeLaunch));
      continue;
    }

    // Async acceptance and future durable polling are deliberately held for
    // B2. The B1 runner returns the persisted state instead of pretending that
    // it can offer process-resumable status/retrieve semantics.
    if (
      state.status !== 'running' ||
      prepared.request.mode === 'async' ||
      state.attempts.some((attempt) =>
        ['submitted', 'running', 'acceptance_unknown'].includes(attempt.status),
      )
    ) {
      return {
        state,
        outputs_by_attempt: Object.freeze(Object.fromEntries(outputs)),
      };
    }

    // A quiescent synchronous plan should have been finalized by the reducer.
    return {
      state,
      outputs_by_attempt: Object.freeze(Object.fromEntries(outputs)),
    };
  }
}
