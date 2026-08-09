import type {
  DurableHandle,
  StructuredError,
} from './contracts/domain/index.js';
import type { AttemptLaunch } from './core/coordinator.js';
import type {
  AttemptExecutionContext,
  AttemptExecutionPort,
  AttemptExecutionResult,
} from './core/execution-runtime.js';
import type { AsyncTaskHandle, Provider, ProviderResult } from './types.js';

export interface NodeExecutionBridgeDependencies {
  /** Exact-id lookup only: aliases and selector policy are deliberately absent. */
  resolveExactProvider(adapterId: string): Provider | undefined;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

function providerFailure(
  code: string,
  message: string,
  fallbackAllowed: boolean,
): StructuredError {
  return {
    code,
    message,
    category: 'provider',
    retryable: true,
    fallback_allowed: fallbackAllowed,
  };
}

function timeoutFor(launch: AttemptLaunch, now: () => number): number {
  return Math.max(1, Date.parse(launch.deadline_at) - now());
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
          result.error,
          result.preventFallback !== true,
        ),
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
  return {
    handle_id: launch.attempt_id,
    provider_task_id: task.taskId,
    provider: launch.profile.identity,
    submitted_at: new Date(task.submittedAt || now()).toISOString(),
    status: task.status === 'running' ? 'running' : 'pending',
  };
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Node-only compatibility bridge. A launch is already frozen to one binding;
 * this bridge only resolves that exact adapter id and invokes its lifecycle.
 */
export function createNodeAttemptBridge(
  dependencies: NodeExecutionBridgeDependencies,
): AttemptExecutionPort {
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? defaultWait;

  return {
    async execute(
      launch: AttemptLaunch,
      context: AttemptExecutionContext,
    ): Promise<AttemptExecutionResult> {
      const provider = dependencies.resolveExactProvider(
        launch.binding.adapter_id,
      );
      if (!provider || provider.id !== launch.binding.adapter_id) {
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
        try {
          return resultOutcome(
            launch,
            await provider.execute(launch.query, {
              timeout: timeoutFor(launch, now),
            }),
          );
        } catch (error) {
          return {
            kind: 'finished',
            finished: {
              outcome: 'failed',
              error: providerFailure(
                'adapter_execute_failed',
                error instanceof Error ? error.message : String(error),
                true,
              ),
            },
          };
        }
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

      let task: AsyncTaskHandle;
      try {
        task = await provider.submit(launch.query, {
          timeout: timeoutFor(launch, now),
        });
      } catch {
        // A rejected promise cannot prove that the remote side did not accept
        // the request. Halt instead of retrying or spending a fallback.
        await context.submissionAcceptanceUnknown();
        return { kind: 'acceptance_unknown' };
      }

      const handle = durableHandle(launch, task, now);
      // This await is the write-ahead boundary: no poll/retrieve occurs before
      // the accepted handle has been persisted through the coordinator store.
      try {
        await context.submissionAccepted(handle);
      } catch {
        // A local persistence failure after submit is acceptance uncertainty,
        // not a rejected provider request. Stop before any poll, retry, or
        // fallback so the coordinator retains the safe terminal marker.
        await context.submissionAcceptanceUnknown();
        return { kind: 'acceptance_unknown' };
      }
      if (context.mode === 'async') return { kind: 'accepted' };

      for (;;) {
        if (now() >= Date.parse(launch.deadline_at)) {
          return {
            kind: 'finished',
            finished: {
              outcome: 'timed_out',
              error: providerFailure(
                'attempt_deadline_exceeded',
                'The durable attempt exceeded its absolute deadline.',
                true,
              ),
              durable_handle: handle,
            },
          };
        }
        let poll;
        try {
          poll = await provider.poll(task);
        } catch (error) {
          return {
            kind: 'finished',
            finished: {
              outcome: 'failed',
              error: providerFailure(
                'adapter_poll_failed',
                error instanceof Error ? error.message : String(error),
                true,
              ),
              durable_handle: handle,
            },
          };
        }
        if (poll.status === 'running') await context.running();
        if (poll.status === 'completed') {
          try {
            return resultOutcome(launch, await provider.retrieve(task), {
              ...handle,
              status: 'succeeded',
              last_observed_at: new Date(now()).toISOString(),
            });
          } catch (error) {
            return {
              kind: 'finished',
              finished: {
                outcome: 'failed',
                error: providerFailure(
                  'adapter_retrieve_failed',
                  error instanceof Error ? error.message : String(error),
                  true,
                ),
                durable_handle: handle,
              },
            };
          }
        }
        if (poll.status === 'failed' || poll.status === 'cancelled') {
          return {
            kind: 'finished',
            finished: {
              outcome: 'failed',
              error: providerFailure(
                'provider_task_failed',
                poll.message ?? `The durable task ${poll.status}.`,
                true,
              ),
              durable_handle: handle,
            },
          };
        }
        await wait(Math.min(context.poll_interval_ms, timeoutFor(launch, now)));
      }
    },
  };
}
