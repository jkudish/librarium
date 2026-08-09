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
  recordTransientPollFailure,
  resumeCoordination,
  type UnresolvedAcceptance,
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
  ): Promise<boolean>;
  submissionAcceptanceUnknown(
    adapterStateRef?: string,
    reason?: UnresolvedAcceptance['reason'],
  ): Promise<void>;
  transientPollFailure(error: StructuredError): Promise<void>;
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
  void error;
  return {
    code: 'attempt_execution_failed',
    message: 'The attempt execution port failed.',
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
  const effectiveDependencies: ExecutionRuntimeDependencies = {
    ...dependencies,
    max_compare_and_swap_attempts:
      dependencies.max_compare_and_swap_attempts ??
      // A completion can race the remaining dispatch transitions in the same
      // wave, so one updater may observe roughly two transitions per slot.
      Math.max(16, prepared.policy.limits.max_concurrency * 2 + 2),
  };
  const initial = createCoordinatorState(
    prepared,
    effectiveDependencies.coordinator,
  );
  await effectiveDependencies.store.create(initial);
  const outputs = new Map<string, unknown>();
  const requestId = initial.request_id;

  const persistLaunchDispatch = async (
    launch: AttemptLaunch,
  ): Promise<boolean> => {
    let dispatched = false;
    await transition(effectiveDependencies, requestId, (state) => {
      // updateCoordinationState may invoke this callback more than once after
      // a CAS conflict. Reset the decision on every observation so a stale
      // delivery never inherits permission from a failed CAS attempt.
      dispatched = false;
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
        effectiveDependencies.coordinator,
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
        const persisted = await transition(
          effectiveDependencies,
          requestId,
          (state) =>
            recordSubmissionAccepted(
              state,
              launch.attempt_id,
              handle,
              effectiveDependencies.coordinator,
              adapterStateRef,
            ),
        );
        const attempt = persisted.state.attempts.find(
          (candidate) => candidate.attempt_id === launch.attempt_id,
        );
        return (
          (attempt?.status === 'submitted' || attempt?.status === 'running') &&
          attempt.durable_handle?.handle_id === handle.handle_id &&
          attempt.durable_handle.provider_task_id === handle.provider_task_id
        );
      },
      submissionAcceptanceUnknown: async (adapterStateRef, reason) => {
        await transition(effectiveDependencies, requestId, (state) =>
          recordAcceptanceUnknown(
            state,
            launch.attempt_id,
            effectiveDependencies.coordinator,
            adapterStateRef,
            reason,
          ),
        );
      },
      transientPollFailure: async (error) => {
        await transition(effectiveDependencies, requestId, (state) =>
          recordTransientPollFailure(
            state,
            launch.attempt_id,
            error,
            effectiveDependencies.coordinator,
          ),
        );
      },
      running: async () => {
        await transition(effectiveDependencies, requestId, (state) => {
          const attempt = state.attempts.find(
            (candidate) => candidate.attempt_id === launch.attempt_id,
          );
          if (attempt?.status === 'running') return undefined;
          return recordAttemptRunning(
            state,
            launch.attempt_id,
            effectiveDependencies.coordinator,
          );
        });
      },
    };

    try {
      const result = await dependencies.attempts.execute(launch, context);
      if (result.kind === 'finished') {
        const persisted = await transition(
          effectiveDependencies,
          requestId,
          (state) =>
            recordAttemptFinished(
              state,
              launch.attempt_id,
              result.finished,
              effectiveDependencies.coordinator,
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
      } else {
        let persisted = await effectiveDependencies.store.load(requestId);
        let attempt = persisted?.state.attempts.find(
          (candidate) => candidate.attempt_id === launch.attempt_id,
        );
        if (
          result.kind === 'acceptance_unknown' &&
          attempt?.status === 'submitting'
        ) {
          await context.submissionAcceptanceUnknown();
          persisted = await effectiveDependencies.store.load(requestId);
          attempt = persisted?.state.attempts.find(
            (candidate) => candidate.attempt_id === launch.attempt_id,
          );
        }
        const coherent =
          result.kind === 'accepted'
            ? prepared.request.mode === 'async' &&
              (attempt?.status === 'submitted' ||
                attempt?.status === 'running') &&
              attempt.durable_handle !== undefined
            : attempt?.status === 'acceptance_unknown' ||
              persisted?.state.status !== 'running';
        if (!coherent) {
          throw new Error(
            `Attempt port returned ${result.kind} without the matching persisted coordinator state.`,
          );
        }
      }
    } catch (error) {
      await transition(effectiveDependencies, requestId, (state) =>
        recordAttemptFinished(
          state,
          launch.attempt_id,
          { outcome: 'failed', error: executionFailure(error) },
          effectiveDependencies.coordinator,
        ),
      );
    }
  };

  for (;;) {
    const advanced = await resumeCoordination(
      effectiveDependencies.store,
      requestId,
      effectiveDependencies.coordinator,
      effectiveDependencies.max_compare_and_swap_attempts,
    );
    const state = advanced.state;

    if (advanced.launches.length > 0) {
      await Promise.all(advanced.launches.map(executeLaunch));
      continue;
    }

    // Async acceptance, acceptance uncertainty, and future durable resumption
    // return the persisted state without pretending B1 is process-resumable.
    // A coherent sync bridge finishes its durable lifecycle before returning.
    return {
      state,
      outputs_by_attempt: Object.freeze(Object.fromEntries(outputs)),
    };
  }
}
