import type {
  DurableHandle,
  ExecutionProfile,
  StructuredError,
} from '../contracts/domain/index.js';
import {
  ExecutionProfileSchema,
  executionProfilesEqual,
} from '../contracts/domain/index.js';
import type { AsyncTaskHandle, Provider, ProviderResult } from '../types.js';
import type { AttemptLaunch } from './coordinator.js';
import type { AdapterBindingIdentity } from './execution-plan.js';
import type {
  AttemptExecutionContext,
  AttemptExecutionPort,
  AttemptExecutionResult,
} from './execution-runtime.js';

type BackgroundProvider = Extract<Provider, { execution: 'background' }>;

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
    return {
      kind: 'finished',
      finished: {
        outcome: 'failed',
        error: providerFailure(
          'provider_reported_error',
          'The provider returned an error.',
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
      result_id: `result-${launch.attempt_id}`,
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
  const status: DurableHandle['status'] =
    task.status === 'completed' ? 'succeeded' : task.status;
  return {
    handle_id: launch.attempt_id,
    provider_task_id: task.taskId,
    provider: launch.profile.identity,
    submitted_at: new Date(task.submittedAt || now()).toISOString(),
    status,
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

/**
 * Provider compatibility bridge. A launch is already frozen to one binding;
 * this bridge only resolves that exact adapter id and invokes its lifecycle.
 */
export function createProviderAttemptBridge(
  dependencies: ProviderAttemptBridgeDependencies,
): AttemptExecutionPort {
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? defaultWait;

  return {
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
          }),
        launch,
        now,
      );
      if (submitted.kind !== 'value') {
        // A rejected promise cannot prove that the remote side did not accept
        // the request. Halt instead of retrying or spending a fallback.
        await context.submissionAcceptanceUnknown(
          undefined,
          submitted.kind === 'deadline'
            ? 'submission_deadline_exceeded'
            : 'submission_response_uncertain',
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
            error: providerFailure(
              'provider_task_failed',
              'The durable provider task failed.',
              true,
            ),
            durable_handle: handle,
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
            durable_handle: handle,
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
            providerFailure(
              'adapter_poll_failed',
              'The durable provider status check failed.',
              false,
            ),
          );
          await wait(
            Math.min(context.poll_interval_ms, timeoutFor(launch, now)),
          );
          continue;
        }
        const poll = polled.value;
        if (poll.status === 'running') {
          latestHandle = observedHandle(latestHandle, 'running', now);
          await context.running();
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
              error: providerFailure(
                'provider_task_failed',
                'The durable provider task failed.',
                true,
              ),
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
