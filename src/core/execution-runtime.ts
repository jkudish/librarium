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
  recordAttemptProgress,
  recordAttemptRunning,
  recordDurableCustodyObservation,
  recordLaunchDispatched,
  recordSubmissionAccepted,
  recordTransientPollFailure,
  resumeCoordination,
  type UnresolvedAcceptance,
} from './coordinator.js';
import {
  type CoordinationStateStore,
  updateCoordinationState,
  type VersionedCoordinationState,
} from './coordinator-store.js';
import type { PreparedResearchExecution } from './execution-plan.js';
import { profileIdentityKey } from './execution-plan.js';

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
  /** Resume an already accepted durable attempt without submitting it again. */
  resume?(
    launch: AttemptLaunch,
    handle: DurableHandle,
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
  running(progress?: number, message?: string): Promise<void>;
}

export type AttemptExecutionResult =
  | {
      readonly kind: 'finished';
      readonly finished: AttemptFinishedInput;
      /** Private, ingress-owned output. Never projected into ResearchResponse. */
      readonly output?: unknown;
    }
  | { readonly kind: 'acceptance_unknown' }
  | { readonly kind: 'accepted'; readonly durable_handle?: DurableHandle };

export interface ExecutionRuntimeDependencies {
  readonly store: CoordinationStateStore;
  readonly coordinator: CoordinatorDependencies;
  readonly attempts: AttemptExecutionPort;
  /** A bounded CAS retry budget for each persisted state transition. */
  readonly max_compare_and_swap_attempts?: number;
  /**
   * Optional durable success hook. Node persistence uses this to commit the
   * normalized output and succeeded coordinator state in one run.json CAS.
   * The Worker-safe runtime stays storage-neutral.
   */
  readonly persist_success?: (
    input: PersistExecutionSuccessInput,
  ) => Promise<VersionedExecutionSuccess>;
  /** Load and resume an existing durable request instead of creating it. */
  readonly resume_existing?: boolean;
  /** Persist the initial canonical state without advancing or dispatching it. */
  readonly materialize_only?: boolean;
  /** One bounded custody observation for already terminal local requests. */
  readonly reconcile_terminal_custody?: boolean;
  readonly persist_custody_observation?: (
    requestId: string,
    attemptId: string,
    handle: DurableHandle,
  ) => Promise<VersionedCoordinationState>;
}

export interface PersistExecutionSuccessInput {
  readonly request_id: string;
  readonly attempt_id: string;
  readonly finished: Extract<AttemptFinishedInput, { outcome: 'succeeded' }>;
  readonly output: unknown;
  readonly coordinator: CoordinatorDependencies;
  readonly max_compare_and_swap_attempts: number;
}

export interface VersionedExecutionSuccess {
  readonly version: number;
  readonly state: CoordinatorState;
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
  const initial = effectiveDependencies.resume_existing
    ? undefined
    : createCoordinatorState(prepared, effectiveDependencies.coordinator);
  const requestId = prepared.request.request_id;
  const existing = effectiveDependencies.resume_existing
    ? await effectiveDependencies.store.load(requestId)
    : undefined;
  if (effectiveDependencies.resume_existing && !existing) {
    throw new Error(`Coordination state not found: ${requestId}`);
  }
  if (initial) await effectiveDependencies.store.create(initial);
  const outputs = new Map<string, unknown>();
  if (initial && effectiveDependencies.materialize_only) {
    return {
      state: initial,
      outputs_by_attempt: Object.freeze({}),
    };
  }

  const persistLaunchDispatch = async (
    launch: AttemptLaunch,
  ): Promise<boolean> => {
    let dispatched = false;
    const persisted = await transition(
      effectiveDependencies,
      requestId,
      (state) => {
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
        const now = effectiveDependencies.coordinator.clock.now();
        if (
          now >= Date.parse(state.request_deadline_at) ||
          !attempt.delivery_lease_expires_at ||
          now >= Date.parse(attempt.delivery_lease_expires_at)
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
      },
    );
    const attempt = persisted.state.attempts.find(
      (candidate) => candidate.attempt_id === launch.attempt_id,
    );
    const now = effectiveDependencies.coordinator.clock.now();
    return (
      dispatched &&
      (attempt?.status === 'running' || attempt?.status === 'submitting') &&
      attempt.started_at !== undefined &&
      now < Date.parse(persisted.state.request_deadline_at) &&
      now < Date.parse(launch.deadline_at)
    );
  };

  const executeLaunch = async (
    launch: AttemptLaunch,
    acceptedHandle?: DurableHandle,
  ): Promise<void> => {
    if (!acceptedHandle && !(await persistLaunchDispatch(launch))) return;
    const observedBeforeExecution = acceptedHandle
      ? await effectiveDependencies.store.load(requestId)
      : undefined;
    const custodyOnly =
      acceptedHandle !== undefined &&
      effectiveDependencies.reconcile_terminal_custody === true &&
      observedBeforeExecution?.state.status !== 'running';
    const context: AttemptExecutionContext = {
      mode: custodyOnly ? 'async' : prepared.request.mode,
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
        await transition(effectiveDependencies, requestId, (state) => {
          const attempt = state.attempts.find(
            (candidate) => candidate.attempt_id === launch.attempt_id,
          );
          if (
            state.status !== 'running' ||
            (attempt?.status !== 'submitted' && attempt?.status !== 'running')
          ) {
            return undefined;
          }
          return recordTransientPollFailure(
            state,
            launch.attempt_id,
            error,
            effectiveDependencies.coordinator,
          );
        });
      },
      running: async (progress, message) => {
        await transition(effectiveDependencies, requestId, (state) => {
          const attempt = state.attempts.find(
            (candidate) => candidate.attempt_id === launch.attempt_id,
          );
          if (
            state.status !== 'running' ||
            (attempt?.status !== 'submitted' && attempt?.status !== 'running')
          ) {
            return undefined;
          }
          const running =
            attempt.status === 'submitted'
              ? recordAttemptRunning(
                  state,
                  launch.attempt_id,
                  effectiveDependencies.coordinator,
                )
              : state;
          return progress === undefined
            ? attempt.status === 'submitted'
              ? running
              : undefined
            : recordAttemptProgress(
                running,
                launch.attempt_id,
                progress,
                message,
                effectiveDependencies.coordinator,
              );
        });
      },
    };

    try {
      const result = acceptedHandle
        ? await dependencies.attempts.resume?.(launch, acceptedHandle, context)
        : await dependencies.attempts.execute(launch, context);
      if (!result) {
        throw new Error(
          'The attempt port cannot resume an accepted durable attempt.',
        );
      }
      if (custodyOnly) {
        const observedHandle =
          result.kind === 'finished'
            ? result.finished.durable_handle
            : result.kind === 'accepted'
              ? result.durable_handle
              : undefined;
        if (observedHandle) {
          if (effectiveDependencies.persist_custody_observation) {
            await effectiveDependencies.persist_custody_observation(
              requestId,
              launch.attempt_id,
              observedHandle,
            );
          } else {
            await transition(effectiveDependencies, requestId, (state) =>
              recordDurableCustodyObservation(
                state,
                launch.attempt_id,
                observedHandle,
              ),
            );
          }
        }
        return;
      }
      if (result.kind === 'finished') {
        const persisted =
          result.finished.outcome === 'succeeded' &&
          result.output !== undefined &&
          effectiveDependencies.persist_success
            ? await effectiveDependencies.persist_success({
                request_id: requestId,
                attempt_id: launch.attempt_id,
                finished: result.finished,
                output: result.output,
                coordinator: effectiveDependencies.coordinator,
                max_compare_and_swap_attempts:
                  effectiveDependencies.max_compare_and_swap_attempts ?? 16,
              })
            : await transition(effectiveDependencies, requestId, (state) =>
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
        if (result.kind === 'accepted' && result.durable_handle) {
          await transition(effectiveDependencies, requestId, (state) =>
            recordDurableCustodyObservation(
              state,
              launch.attempt_id,
              result.durable_handle as DurableHandle,
            ),
          );
        }
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
      const current = await effectiveDependencies.store.load(requestId);
      const attempt = current?.state.attempts.find(
        (candidate) => candidate.attempt_id === launch.attempt_id,
      );
      if (
        attempt?.durable_handle &&
        (attempt.status === 'submitted' || attempt.status === 'running')
      ) {
        await transition(effectiveDependencies, requestId, (state) => {
          const currentAttempt = state.attempts.find(
            (candidate) => candidate.attempt_id === launch.attempt_id,
          );
          if (
            currentAttempt?.status !== 'submitted' &&
            currentAttempt?.status !== 'running'
          ) {
            return undefined;
          }
          return recordTransientPollFailure(
            state,
            launch.attempt_id,
            {
              code: 'attempt_execution_interrupted',
              message:
                'Local execution was interrupted after durable acceptance.',
              category: 'internal',
              retryable: true,
              fallback_allowed: false,
            },
            effectiveDependencies.coordinator,
          );
        });
        return;
      }
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

  const resumedAttemptIds = new Set<string>();
  if (effectiveDependencies.resume_existing && existing) {
    await Promise.all(
      existing.state.attempts.flatMap((attempt) =>
        attempt.status === 'submitting' && !attempt.durable_handle
          ? [
              transition(effectiveDependencies, requestId, (state) => {
                const currentAttempt = state.attempts.find(
                  (candidate) => candidate.attempt_id === attempt.attempt_id,
                );
                if (
                  currentAttempt?.status !== 'submitting' ||
                  currentAttempt.durable_handle
                ) {
                  return undefined;
                }
                return recordAcceptanceUnknown(
                  state,
                  currentAttempt.attempt_id,
                  effectiveDependencies.coordinator,
                  currentAttempt.adapter_state_ref,
                  'submission_response_uncertain',
                );
              }),
            ]
          : [],
      ),
    );
  }
  for (;;) {
    const advanced = await resumeCoordination(
      effectiveDependencies.store,
      requestId,
      effectiveDependencies.coordinator,
      effectiveDependencies.max_compare_and_swap_attempts,
    );
    const state = advanced.state;

    if (advanced.launches.length > 0) {
      await Promise.all(
        advanced.launches.map((launch) => executeLaunch(launch)),
      );
      continue;
    }

    if (effectiveDependencies.resume_existing) {
      const resumptions = state.attempts.flatMap((attempt) => {
        if (
          resumedAttemptIds.has(attempt.attempt_id) ||
          !attempt.durable_handle ||
          (attempt.status !== 'submitted' &&
            attempt.status !== 'running' &&
            !(
              effectiveDependencies.reconcile_terminal_custody &&
              (attempt.status === 'cancelled' ||
                attempt.status === 'timed_out') &&
              attempt.durable_handle.status !== 'failed' &&
              attempt.durable_handle.status !== 'cancelled' &&
              attempt.durable_handle.status !== 'succeeded'
            ))
        ) {
          return [];
        }
        const plan = Object.values(state.profile_plans_by_identity).find(
          (candidate) =>
            candidate.profile_key ===
            profileIdentityKey(attempt.profile.identity),
        );
        if (!plan) {
          throw new Error(
            `Accepted attempt ${attempt.attempt_id} is missing its frozen binding.`,
          );
        }
        resumedAttemptIds.add(attempt.attempt_id);
        return [
          {
            launch: {
              attempt_id: attempt.attempt_id,
              slot_id: attempt.slot_id,
              profile: attempt.profile,
              binding: plan.binding,
              catalog_digest: state.catalog_digest,
              query: attempt.query,
              deadline_at: attempt.deadline_at,
              // Resume never re-enters delivery claiming. This stable private
              // value satisfies AttemptLaunch's execution-port shape only.
              delivery_lease_id: 'durable-resume',
              idempotency_key: `${state.request_id}:${attempt.attempt_id}`,
            },
            handle: attempt.durable_handle,
          },
        ];
      });
      if (resumptions.length > 0) {
        await Promise.all(
          resumptions.map(({ launch, handle }) =>
            executeLaunch(launch, handle),
          ),
        );
        continue;
      }

      const interrupted = state.attempts.filter(
        (attempt) =>
          !resumedAttemptIds.has(attempt.attempt_id) &&
          !attempt.durable_handle &&
          (attempt.status === 'running' || attempt.status === 'submitting'),
      );
      if (interrupted.length > 0) {
        await Promise.all(
          interrupted.map((attempt) =>
            transition(effectiveDependencies, requestId, (current) =>
              recordAttemptFinished(
                current,
                attempt.attempt_id,
                {
                  outcome: 'failed',
                  error: {
                    code: 'non_durable_execution_interrupted',
                    message:
                      'The local non-durable execution was interrupted and cannot be resumed.',
                    category: 'internal',
                    retryable: false,
                    fallback_allowed: false,
                  },
                },
                effectiveDependencies.coordinator,
              ),
            ),
          ),
        );
        continue;
      }
    }

    // Async acceptance, acceptance uncertainty, local interruption after
    // acceptance, and future durable resumption return persisted nonterminal
    // state without pretending B1 is process-resumable. A coherent sync bridge
    // otherwise finishes its durable lifecycle before returning.
    return {
      state,
      outputs_by_attempt: Object.freeze(Object.fromEntries(outputs)),
    };
  }
}
