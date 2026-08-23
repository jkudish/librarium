import type {
  DurableHandle,
  ExecutionProfile,
  StructuredError,
} from '../contracts/domain/index.js';
import {
  ExecutionProfileSchema,
  executionProfilesEqual,
} from '../contracts/domain/index.js';
import type {
  AsyncTaskHandle,
  Provider,
  ProviderFailureDiagnostic,
  ProviderFailureKind,
  ProviderResult,
} from '../types.js';
import type { AttemptLaunch } from './coordinator.js';
import type { AdapterBindingIdentity } from './execution-plan.js';
import type {
  AttemptExecutionContext,
  AttemptExecutionPort,
  AttemptExecutionResult,
} from './execution-runtime.js';

type BackgroundProvider = Extract<Provider, { execution: 'background' }>;

export interface ProviderAttemptBridge extends AttemptExecutionPort {
  /** Best-effort exact-binding remote cancellation for accepted durable work. */
  cancel?(
    launch: AttemptLaunch,
    handle: DurableHandle,
  ): Promise<DurableHandle | undefined>;
}

export interface ProviderAttemptBridgeDependencies {
  /** Exact binding lookup only: aliases and selector policy are absent. */
  resolveExactBinding(binding: AdapterBindingIdentity):
    | {
        readonly binding: AdapterBindingIdentity;
        readonly profile: ExecutionProfile;
        readonly catalog_digest: string;
        readonly provider: Provider;
      }
    | undefined;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

function providerFailure(
  code: string,
  message: string,
  fallbackAllowed: boolean,
  retryable = true,
  category: StructuredError['category'] = 'provider',
): StructuredError {
  return {
    code,
    message,
    category,
    retryable,
    fallback_allowed: fallbackAllowed,
  };
}

const PROVIDER_FAILURE_KINDS = new Set<ProviderFailureKind>([
  'authentication',
  'plan_required',
  'billing',
  'rate_limit',
  'invalid_request',
  'network',
  'timeout',
  'provider',
]);

function isProvenSubmissionRejection(
  diagnostic: ProviderFailureDiagnostic,
): boolean {
  if (diagnostic.kind === 'timeout' || diagnostic.kind === 'network') {
    return false;
  }
  if (diagnostic.kind === 'provider') {
    return (
      diagnostic.httpStatus !== undefined &&
      diagnostic.httpStatus >= 400 &&
      diagnostic.httpStatus < 500
    );
  }
  return true;
}

function failureDiagnosticFromUnknown(
  error: unknown,
): ProviderFailureDiagnostic | undefined {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) {
    return undefined;
  }
  return validatedFailureDiagnostic(
    (error as { readonly failureDiagnostic?: unknown }).failureDiagnostic,
  );
}

function validatedFailureDiagnostic(
  value: unknown,
): ProviderFailureDiagnostic | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.kind !== 'string' ||
    !PROVIDER_FAILURE_KINDS.has(candidate.kind as ProviderFailureKind)
  ) {
    return undefined;
  }
  const httpStatus = candidate.httpStatus;
  return {
    kind: candidate.kind as ProviderFailureKind,
    ...(typeof httpStatus === 'number' &&
      Number.isInteger(httpStatus) &&
      httpStatus >= 100 &&
      httpStatus <= 599 && { httpStatus }),
  };
}

function diagnosedProviderFailure(
  diagnostic: ProviderFailureDiagnostic | undefined,
  fallbackAllowed: boolean,
): StructuredError {
  const mapped: Record<
    ProviderFailureKind,
    Pick<StructuredError, 'code' | 'category' | 'retryable'>
  > = {
    authentication: {
      code: 'provider_authentication_failed',
      category: 'authentication',
      retryable: false,
    },
    plan_required: {
      code: 'provider_plan_required',
      category: 'authorization',
      retryable: false,
    },
    billing: {
      code: 'provider_billing_failed',
      category: 'budget',
      retryable: false,
    },
    rate_limit: {
      code: 'provider_rate_limited',
      category: 'rate_limit',
      retryable: true,
    },
    invalid_request: {
      code: 'provider_invalid_request',
      category: 'validation',
      retryable: false,
    },
    network: {
      code: 'provider_network_failed',
      category: 'network',
      retryable: true,
    },
    timeout: {
      code: 'provider_timeout',
      category: 'timeout',
      retryable: true,
    },
    provider: {
      code: 'provider_reported_error',
      category: 'provider',
      retryable: true,
    },
  };
  const selected = mapped[diagnostic?.kind ?? 'provider'];
  return {
    ...selected,
    message: 'The provider returned an error.',
    fallback_allowed: fallbackAllowed,
    ...(diagnostic?.httpStatus !== undefined && {
      provider_code: `http_${diagnostic.httpStatus}`,
    }),
  };
}

function durableProviderFailure(
  diagnostic: unknown,
  fallbackAllowed: boolean,
): StructuredError {
  const validated = validatedFailureDiagnostic(diagnostic);
  return validated
    ? diagnosedProviderFailure(validated, fallbackAllowed)
    : providerFailure(
        'provider_task_failed',
        'The durable provider task failed.',
        fallbackAllowed,
      );
}

function transientProviderFailure(error: unknown): StructuredError {
  const diagnostic =
    typeof error === 'object' && error !== null && 'failureDiagnostic' in error
      ? validatedFailureDiagnostic(
          (error as { readonly failureDiagnostic?: unknown }).failureDiagnostic,
        )
      : undefined;
  return diagnostic
    ? {
        ...diagnosedProviderFailure(diagnostic, false),
        // The remote task remains accepted. Retrying the GET observation is
        // safe even when the observed cause would forbid a new submission.
        retryable: true,
      }
    : providerFailure(
        'adapter_poll_failed',
        'The durable provider status check failed.',
        false,
      );
}

type DeadlineResult<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'deadline' };

async function beforeDeadline<T>(
  operation: (signal: AbortSignal, remainingMs: number) => Promise<T>,
  launch: AttemptLaunch,
  now: () => number,
): Promise<DeadlineResult<T>> {
  const remainingMs = Date.parse(launch.deadline_at) - now();
  if (remainingMs <= 0) return { kind: 'deadline' };
  const controller = new AbortController();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DeadlineResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish({ kind: 'deadline' });
    }, remainingMs);
    operation(controller.signal, remainingMs).then(
      (value) => finish({ kind: 'value', value }),
      (error: unknown) => finish({ kind: 'error', error }),
    );
  });
}

function timeoutFor(launch: AttemptLaunch, now: () => number): number {
  return Math.max(1, Date.parse(launch.deadline_at) - now());
}

function providerTimeoutSeconds(remainingMs: number): number {
  return Math.max(1, Math.ceil(remainingMs / 1_000));
}

function profilesMatch(
  expected: ExecutionProfile,
  actual: ExecutionProfile,
): boolean {
  const parsedExpected = ExecutionProfileSchema.safeParse(expected);
  const parsedActual = ExecutionProfileSchema.safeParse(actual);
  return (
    parsedExpected.success &&
    parsedActual.success &&
    executionProfilesEqual(parsedExpected.data, parsedActual.data)
  );
}

function resultOutcome(
  launch: AttemptLaunch,
  result: ProviderResult,
  completedHandle?: DurableHandle,
): AttemptExecutionResult {
  if (result.error) {
    const diagnostic = validatedFailureDiagnostic(result.failureDiagnostic);
    return {
      kind: 'finished',
      finished: {
        outcome: 'failed',
        error: diagnosedProviderFailure(
          diagnostic,
          result.preventFallback !== true,
        ),
        ...(completedHandle && { durable_handle: completedHandle }),
      },
      output: result,
    };
  }
  return {
    kind: 'finished',
    finished: {
      outcome: 'succeeded',
      // Attempt ids are already bounded, opaque, and unique per request.
      result_id: launch.attempt_id,
      ...(completedHandle && { durable_handle: completedHandle }),
    },
    output: result,
  };
}

function durableHandle(
  launch: AttemptLaunch,
  task: AsyncTaskHandle,
  now: () => number,
): DurableHandle {
  return {
    handle_id: launch.attempt_id,
    provider_task_id: task.taskId,
    provider: launch.profile.identity,
    submitted_at: new Date(task.submittedAt || now()).toISOString(),
    // Submission acceptance is nonterminal even when the submit response also
    // reports a terminal provider task. Retrieval/terminalization follows the
    // write-ahead acceptance commit and records the observed terminal handle.
    status: task.status === 'running' ? 'running' : 'pending',
  };
}

function observedHandle(
  handle: DurableHandle,
  status: DurableHandle['status'],
  now: () => number,
): DurableHandle {
  return {
    ...handle,
    status,
    last_observed_at: new Date(now()).toISOString(),
  };
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retrieveCompletedTask(
  provider: BackgroundProvider,
  task: AsyncTaskHandle,
  launch: AttemptLaunch,
  handle: DurableHandle,
  now: () => number,
): Promise<AttemptExecutionResult> {
  const completedHandle = observedHandle(handle, 'succeeded', now);
  const retrieved = await beforeDeadline(
    () => provider.retrieve(task),
    launch,
    now,
  );
  if (retrieved.kind === 'deadline') {
    return {
      kind: 'finished',
      finished: {
        outcome: 'timed_out',
        error: providerFailure(
          'attempt_deadline_exceeded',
          'The provider result retrieval exceeded the attempt deadline.',
          false,
          true,
          'timeout',
        ),
        durable_handle: completedHandle,
      },
    };
  }
  if (retrieved.kind === 'error') {
    return {
      kind: 'finished',
      finished: {
        outcome: 'failed',
        error: providerFailure(
          'adapter_retrieve_failed',
          'The provider result retrieval failed.',
          true,
        ),
        durable_handle: completedHandle,
      },
    };
  }
  return resultOutcome(launch, retrieved.value, completedHandle);
}

function taskFromDurableHandle(
  launch: AttemptLaunch,
  handle: DurableHandle,
  adapterId: string,
): AsyncTaskHandle {
  const status = handle.status === 'succeeded' ? 'completed' : handle.status;
  return {
    provider: adapterId,
    taskId: handle.provider_task_id,
    query: launch.query,
    submittedAt: Date.parse(handle.submitted_at),
    status,
    ...(handle.last_observed_at && {
      lastPolledAt: Date.parse(handle.last_observed_at),
    }),
  };
}

function resolveDurableProvider(
  dependencies: ProviderAttemptBridgeDependencies,
  launch: AttemptLaunch,
): BackgroundProvider | undefined {
  const resolved = dependencies.resolveExactBinding(launch.binding);
  if (
    !resolved ||
    resolved.binding.adapter_id !== launch.binding.adapter_id ||
    resolved.binding.binding_id !== launch.binding.binding_id ||
    resolved.catalog_digest !== launch.catalog_digest ||
    !profilesMatch(launch.profile, resolved.profile) ||
    launch.profile.invocation !== 'background' ||
    launch.profile.resumability !== 'durable' ||
    resolved.provider.execution !== 'background' ||
    resolved.provider.id !== launch.binding.adapter_id
  ) {
    return undefined;
  }
  return resolved.provider;
}

/**
 * Provider compatibility bridge. A launch is already frozen to one binding;
 * this bridge only resolves that exact adapter id and invokes its lifecycle.
 */
export function createProviderAttemptBridge(
  dependencies: ProviderAttemptBridgeDependencies,
): ProviderAttemptBridge {
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? defaultWait;

  return {
    async cancel(
      launch: AttemptLaunch,
      handle: DurableHandle,
    ): Promise<DurableHandle | undefined> {
      const provider = resolveDurableProvider(dependencies, launch);
      if (
        !provider?.cancel ||
        !['pending', 'running'].includes(handle.status) ||
        handle.provider.provider_id !== launch.profile.identity.provider_id ||
        handle.provider.profile_id !== launch.profile.identity.profile_id
      ) {
        return undefined;
      }
      const task = taskFromDurableHandle(launch, handle, provider.id);
      const cancelled = await provider.cancel(task);
      return cancelled.status === 'cancelled'
        ? observedHandle(handle, 'cancelled', now)
        : undefined;
    },
    async resume(
      launch: AttemptLaunch,
      handle: DurableHandle,
      context: AttemptExecutionContext,
    ): Promise<AttemptExecutionResult> {
      const provider = resolveDurableProvider(dependencies, launch);
      if (
        !provider ||
        handle.provider.provider_id !== launch.profile.identity.provider_id ||
        handle.provider.profile_id !== launch.profile.identity.profile_id
      ) {
        return {
          kind: 'finished',
          finished: {
            outcome: 'failed',
            error: providerFailure(
              'frozen_adapter_binding_unavailable',
              `The frozen adapter binding ${launch.binding.adapter_id} is unavailable for durable resume.`,
              false,
            ),
          },
        };
      }
      const task = taskFromDurableHandle(launch, handle, provider.id);
      if (handle.status === 'succeeded') {
        if (context.custody_only) {
          return { kind: 'accepted', durable_handle: handle };
        }
        return retrieveCompletedTask(provider, task, launch, handle, now);
      }
      let latestHandle = handle;
      for (;;) {
        const polled = await beforeDeadline(
          () => provider.poll(task),
          launch,
          now,
        );
        if (polled.kind === 'deadline') {
          return {
            kind: 'finished',
            finished: {
              outcome: 'timed_out',
              error: providerFailure(
                'attempt_deadline_exceeded',
                'The durable status check exceeded the attempt deadline.',
                false,
                true,
                'timeout',
              ),
              durable_handle: latestHandle,
            },
          };
        }
        if (polled.kind === 'error') {
          await context.transientPollFailure(
            transientProviderFailure(polled.error),
          );
          if (context.mode === 'async') {
            return { kind: 'accepted', durable_handle: latestHandle };
          }
          await wait(
            Math.min(context.poll_interval_ms, timeoutFor(launch, now)),
          );
          continue;
        }
        const poll = polled.value;
        if (poll.status === 'completed') {
          if (context.custody_only) {
            return {
              kind: 'accepted',
              durable_handle: observedHandle(latestHandle, 'succeeded', now),
            };
          }
          return retrieveCompletedTask(
            provider,
            task,
            launch,
            latestHandle,
            now,
          );
        }
        if (poll.status === 'failed') {
          return {
            kind: 'finished',
            finished: {
              outcome: 'failed',
              error: durableProviderFailure(poll.failureDiagnostic, true),
              durable_handle: observedHandle(latestHandle, 'failed', now),
            },
          };
        }
        if (poll.status === 'cancelled') {
          return {
            kind: 'finished',
            finished: {
              outcome: 'cancelled',
              error: providerFailure(
                'provider_task_cancelled',
                'The durable provider task was cancelled.',
                false,
                false,
                'cancelled',
              ),
              durable_handle: observedHandle(latestHandle, 'cancelled', now),
            },
          };
        }
        latestHandle = observedHandle(
          latestHandle,
          poll.status === 'running' ? 'running' : 'pending',
          now,
        );
        if (poll.status === 'running') {
          await context.running(poll.progress, poll.message);
        }
        if (context.mode === 'async') {
          return { kind: 'accepted', durable_handle: latestHandle };
        }
        await wait(Math.min(context.poll_interval_ms, timeoutFor(launch, now)));
      }
    },
    async execute(
      launch: AttemptLaunch,
      context: AttemptExecutionContext,
    ): Promise<AttemptExecutionResult> {
      const resolved = dependencies.resolveExactBinding(launch.binding);
      const provider = resolved?.provider;
      if (
        !resolved ||
        resolved.binding.adapter_id !== launch.binding.adapter_id ||
        resolved.binding.binding_id !== launch.binding.binding_id ||
        resolved.catalog_digest !== launch.catalog_digest ||
        !profilesMatch(launch.profile, resolved.profile) ||
        !provider ||
        provider.id !== launch.binding.adapter_id
      ) {
        return {
          kind: 'finished',
          finished: {
            outcome: 'failed',
            error: providerFailure(
              'frozen_adapter_binding_unavailable',
              `The frozen adapter binding ${launch.binding.adapter_id} is unavailable.`,
              false,
            ),
          },
        };
      }

      if (launch.profile.invocation === 'inline') {
        if (provider.execution !== 'inline') {
          return {
            kind: 'finished',
            finished: {
              outcome: 'failed',
              error: providerFailure(
                'frozen_adapter_execution_mismatch',
                `The frozen inline binding ${launch.binding.adapter_id} resolved to a non-inline adapter.`,
                false,
              ),
            },
          };
        }
        const executed = await beforeDeadline(
          (signal, remainingMs) =>
            provider.execute(launch.query, {
              timeout: providerTimeoutSeconds(remainingMs),
              signal,
            }),
          launch,
          now,
        );
        if (executed.kind === 'deadline') {
          return {
            kind: 'finished',
            finished: {
              outcome: 'timed_out',
              error: providerFailure(
                'attempt_deadline_exceeded',
                'The provider execution exceeded its absolute deadline.',
                true,
                true,
                'timeout',
              ),
            },
          };
        }
        if (executed.kind === 'error') {
          return {
            kind: 'finished',
            finished: {
              outcome: 'failed',
              error: providerFailure(
                'adapter_execute_failed',
                'The provider execution failed.',
                true,
              ),
            },
          };
        }
        return resultOutcome(launch, executed.value);
      }

      if (
        launch.profile.resumability !== 'durable' ||
        provider.execution !== 'background'
      ) {
        return {
          kind: 'finished',
          finished: {
            outcome: 'failed',
            error: providerFailure(
              'frozen_adapter_execution_mismatch',
              `The frozen durable binding ${launch.binding.adapter_id} does not expose a durable lifecycle.`,
              false,
            ),
          },
        };
      }

      const submitted = await beforeDeadline(
        (signal, remainingMs) =>
          provider.submit(launch.query, {
            timeout: providerTimeoutSeconds(remainingMs),
            signal,
            submissionId: launch.attempt_id,
          }),
        launch,
        now,
      );
      if (submitted.kind === 'deadline') {
        // The local deadline fired while POST may already have been in flight.
        await context.submissionAcceptanceUnknown(
          undefined,
          'submission_deadline_exceeded',
        );
        return { kind: 'acceptance_unknown' };
      }
      if (submitted.kind === 'error') {
        const diagnostic = failureDiagnosticFromUnknown(submitted.error);
        if (diagnostic && isProvenSubmissionRejection(diagnostic)) {
          return {
            kind: 'finished',
            finished: {
              outcome: 'failed',
              error: diagnosedProviderFailure(diagnostic, false),
            },
          };
        }
        // Timeout/5xx/connection-drop after POST cannot prove rejection.
        await context.submissionAcceptanceUnknown(
          undefined,
          'submission_response_uncertain',
        );
        return { kind: 'acceptance_unknown' };
      }
      const task: AsyncTaskHandle = submitted.value;

      const handle = durableHandle(launch, task, now);
      // This await is the write-ahead boundary: no poll/retrieve occurs before
      // the accepted handle has been persisted through the coordinator store.
      try {
        if (!(await context.submissionAccepted(handle))) {
          return { kind: 'acceptance_unknown' };
        }
      } catch {
        // A local persistence failure after submit is acceptance uncertainty,
        // not a rejected provider request. Stop before any poll, retry, or
        // fallback so the coordinator retains the safe terminal marker.
        await context.submissionAcceptanceUnknown();
        return { kind: 'acceptance_unknown' };
      }

      if (task.status === 'failed') {
        return {
          kind: 'finished',
          finished: {
            outcome: 'failed',
            error: durableProviderFailure(task.failureDiagnostic, true),
            durable_handle: observedHandle(handle, 'failed', now),
          },
        };
      }
      if (task.status === 'cancelled') {
        return {
          kind: 'finished',
          finished: {
            outcome: 'cancelled',
            error: providerFailure(
              'provider_task_cancelled',
              'The durable provider task was cancelled.',
              false,
              false,
              'cancelled',
            ),
            durable_handle: observedHandle(handle, 'cancelled', now),
          },
        };
      }
      if (task.status === 'completed') {
        return retrieveCompletedTask(provider, task, launch, handle, now);
      }
      if (context.mode === 'async') return { kind: 'accepted' };

      let latestHandle = handle;
      for (;;) {
        if (now() >= Date.parse(launch.deadline_at)) {
          return {
            kind: 'finished',
            finished: {
              outcome: 'timed_out',
              error: providerFailure(
                'attempt_deadline_exceeded',
                'The durable attempt exceeded its absolute deadline.',
                false,
                true,
                'timeout',
              ),
              durable_handle: latestHandle,
            },
          };
        }
        const polled = await beforeDeadline(
          () => provider.poll(task),
          launch,
          now,
        );
        if (polled.kind === 'deadline') {
          return {
            kind: 'finished',
            finished: {
              outcome: 'timed_out',
              error: providerFailure(
                'attempt_deadline_exceeded',
                'The durable status check exceeded the attempt deadline.',
                false,
                true,
                'timeout',
              ),
              durable_handle: latestHandle,
            },
          };
        }
        if (polled.kind === 'error') {
          await context.transientPollFailure(
            transientProviderFailure(polled.error),
          );
          await wait(
            Math.min(context.poll_interval_ms, timeoutFor(launch, now)),
          );
          continue;
        }
        const poll = polled.value;
        if (poll.status === 'running') {
          latestHandle = observedHandle(latestHandle, 'running', now);
          await context.running(poll.progress, poll.message);
        }
        if (poll.status === 'completed') {
          return retrieveCompletedTask(
            provider,
            task,
            launch,
            latestHandle,
            now,
          );
        }
        if (poll.status === 'failed') {
          return {
            kind: 'finished',
            finished: {
              outcome: 'failed',
              error: durableProviderFailure(poll.failureDiagnostic, true),
              durable_handle: observedHandle(latestHandle, 'failed', now),
            },
          };
        }
        if (poll.status === 'cancelled') {
          return {
            kind: 'finished',
            finished: {
              outcome: 'cancelled',
              error: providerFailure(
                'provider_task_cancelled',
                'The durable provider task was cancelled.',
                false,
                false,
                'cancelled',
              ),
              durable_handle: observedHandle(latestHandle, 'cancelled', now),
            },
          };
        }
        await wait(Math.min(context.poll_interval_ms, timeoutFor(launch, now)));
      }
    },
  };
}
