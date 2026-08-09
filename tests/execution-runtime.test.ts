import { describe, expect, it, vi } from 'vitest';
import type { ExecutionProfile } from '../src/contracts/domain/index.js';
import { InMemoryCoordinationStateStore } from '../src/core/coordinator-store.js';
import type { PreparedResearchExecution } from '../src/core/execution-plan.js';
import { profileIdentityKey } from '../src/core/execution-plan.js';
import {
  type AttemptExecutionPort,
  runPreparedExecution,
} from '../src/core/execution-runtime.js';
import { createNodeAttemptBridge } from '../src/node-execution-bridge.js';
import type { Provider, ProviderResult } from '../src/types.js';

const start = Date.parse('2026-08-09T12:00:00.000Z');

function profile(
  providerId: string,
  invocation: 'inline' | 'background' = 'inline',
): ExecutionProfile {
  return {
    identity: {
      provider_id: providerId,
      profile_id: 'fixture',
      target: {
        primary: {
          model_selection: 'fixed',
          kind: 'model',
          target_id: `${providerId}-model`,
        },
      },
    },
    result_kind: 'grounded_answer',
    grounding_policy: 'required',
    observation_mode: 'api_output',
    corpora: ['web'],
    retrieval_method: 'model_search_tool',
    access_mode: 'direct',
    operator_id: providerId,
    invocation,
    resumability: invocation === 'inline' ? 'none' : 'durable',
  };
}

function prepared(
  primaries: readonly ExecutionProfile[],
  reserve: readonly ExecutionProfile[] = [],
): PreparedResearchExecution {
  const all = [...primaries, ...reserve];
  const plans = Object.fromEntries(
    all.map((item) => [
      profileIdentityKey(item.identity),
      {
        profile_key: profileIdentityKey(item.identity),
        identity: item.identity,
        binding: {
          adapter_id: `adapter-${item.identity.provider_id}`,
          binding_id: `binding-${item.identity.provider_id}`,
        },
      },
    ]),
  );
  return {
    request: {
      interchange_version: '1.0',
      message_type: 'request',
      request_id: 'runtime-request',
      requested_at: new Date(start).toISOString(),
      mode: 'sync',
      query: 'runtime query',
      slots: primaries.map((item, position) => ({
        slot_id: `slot-${position}`,
        position,
        requirements: {
          result_kind: 'grounded_answer',
          grounding_policy: 'required',
          corpora: ['web'],
        },
        primary: item,
      })),
      fallback_reserve: reserve.map((item, position) => ({
        candidate_id: `reserve-${position}`,
        position,
        profile: item,
        eligible_slot_ids: primaries.map((_, index) => `slot-${index}`),
      })),
    },
    policy: {
      limits: {
        max_concurrency: primaries.length,
        request_deadline_ms: 60_000,
        inline_attempt_deadline_ms: 10_000,
        background_attempt_deadline_ms: 20_000,
        poll_interval_ms: 1_000,
      },
      fallback: reserve.length
        ? { kind: 'explicit', reserve: [] }
        : { kind: 'disabled' },
      exclusions: [],
      refinement: { kind: 'disabled' },
    },
    profile_plans_by_identity: plans,
    catalog: { revision: 'runtime-r1', digest: 'runtime-digest' },
    notices: [],
  };
}

function coordinatorDependencies() {
  let next = 0;
  return {
    clock: { now: () => start },
    ids: {
      next: (scope: 'attempt' | 'event' | 'delivery_lease') =>
        `${scope}-${++next}`,
    },
  };
}

function mutableCoordinatorDependencies() {
  let now = start;
  let next = 0;
  return {
    clock: { now: () => now },
    ids: {
      next: (scope: 'attempt' | 'event' | 'delivery_lease') =>
        `${scope}-${++next}`,
    },
    setNow(value: number) {
      now = value;
    },
  };
}

function successfulResult(provider: string): ProviderResult {
  return {
    provider,
    tier: 'raw-search',
    content: 'done',
    citations: [],
    durationMs: 1,
  };
}

describe('private prepared execution runtime', () => {
  it('executes only the frozen adapter binding and never performs provider selection', async () => {
    const exact: Provider = {
      id: 'adapter-primary',
      displayName: 'Exact',
      tier: 'raw-search',
      envVar: '',
      execution: 'inline',
      execute: vi.fn(async () => successfulResult('adapter-primary')),
    };
    const resolveExactProvider = vi.fn((id: string) =>
      id === 'adapter-primary' ? exact : undefined,
    );
    const plan = prepared([profile('primary')]);
    const store = new InMemoryCoordinationStateStore();
    const result = await runPreparedExecution(plan, {
      store,
      coordinator: coordinatorDependencies(),
      attempts: createNodeAttemptBridge({
        resolveExactProvider,
        now: () => start,
      }),
    });

    expect(resolveExactProvider).toHaveBeenCalledExactlyOnceWith(
      'adapter-primary',
    );
    expect(exact.execute).toHaveBeenCalledExactlyOnceWith('runtime query', {
      timeout: 10_000,
    });
    expect(result.state.status).toBe('succeeded');
    expect(result.outputs_by_attempt).toEqual(
      expect.objectContaining({
        'attempt-2': expect.objectContaining({ content: 'done' }),
      }),
    );
  });

  it('persists durable acceptance before polling and uses the background deadline', async () => {
    const store = new InMemoryCoordinationStateStore();
    const durable: Provider = {
      id: 'adapter-durable',
      displayName: 'Durable',
      tier: 'deep-research',
      envVar: '',
      execution: 'background',
      execute: vi.fn(),
      submit: vi.fn(async () => ({
        provider: 'adapter-durable',
        taskId: 'provider-task',
        query: 'runtime query',
        submittedAt: start,
        status: 'pending' as const,
      })),
      poll: vi.fn(async () => {
        const persisted = await store.load('runtime-request');
        expect(persisted?.state.attempts[0]?.durable_handle).toMatchObject({
          provider_task_id: 'provider-task',
        });
        return { status: 'completed' as const };
      }),
      retrieve: vi.fn(async () => successfulResult('adapter-durable')),
    };

    const result = await runPreparedExecution(
      prepared([profile('durable', 'background')]),
      {
        store,
        coordinator: coordinatorDependencies(),
        attempts: createNodeAttemptBridge({
          resolveExactProvider: (id) =>
            id === 'adapter-durable' ? durable : undefined,
          now: () => start,
        }),
      },
    );

    expect(durable.submit).toHaveBeenCalledWith('runtime query', {
      timeout: 20_000,
    });
    expect(durable.poll).toHaveBeenCalledOnce();
    expect(durable.retrieve).toHaveBeenCalledOnce();
    expect(result.state.status).toBe('succeeded');
  });

  it('halts on ambiguous submission acceptance without fallback or retry', async () => {
    const submit = vi.fn(async () => {
      throw new Error('connection dropped after submit');
    });
    const fallback: Provider = {
      id: 'adapter-reserve',
      displayName: 'Reserve',
      tier: 'raw-search',
      envVar: '',
      execution: 'inline',
      execute: vi.fn(async () => successfulResult('adapter-reserve')),
    };
    const durable: Provider = {
      id: 'adapter-durable',
      displayName: 'Durable',
      tier: 'deep-research',
      envVar: '',
      execution: 'background',
      execute: vi.fn(),
      submit,
      poll: vi.fn(),
      retrieve: vi.fn(),
    };
    const result = await runPreparedExecution(
      prepared([profile('durable', 'background')], [profile('reserve')]),
      {
        store: new InMemoryCoordinationStateStore(),
        coordinator: coordinatorDependencies(),
        attempts: createNodeAttemptBridge({
          resolveExactProvider: (id) =>
            id === 'adapter-durable'
              ? durable
              : id === 'adapter-reserve'
                ? fallback
                : undefined,
          now: () => start,
        }),
      },
    );

    expect(submit).toHaveBeenCalledOnce();
    expect(fallback.execute).not.toHaveBeenCalled();
    expect(result.state.attempts).toHaveLength(1);
    expect(result.state.attempts[0]?.status).toBe('acceptance_unknown');
    expect(result.state.unresolved_acceptances[0]).toMatchObject({
      reason: 'submission_response_uncertain',
    });
  });

  it('drops a late primary output and retains the successful fallback output', async () => {
    const dependencies = mutableCoordinatorDependencies();
    const attempts: AttemptExecutionPort = {
      execute: async (launch) => {
        if (launch.profile.identity.provider_id === 'primary') {
          dependencies.setNow(start + 10_000);
          return {
            kind: 'finished',
            finished: {
              outcome: 'succeeded',
              result_id: `result-${launch.attempt_id}`,
            },
            output: { source: 'late-primary' },
          };
        }
        return {
          kind: 'finished',
          finished: {
            outcome: 'succeeded',
            result_id: `result-${launch.attempt_id}`,
          },
          output: { source: 'fallback' },
        };
      },
    };

    const result = await runPreparedExecution(
      prepared([profile('primary')], [profile('reserve')]),
      {
        store: new InMemoryCoordinationStateStore(),
        coordinator: dependencies,
        attempts,
      },
    );

    expect(result.state.status).toBe('succeeded');
    expect(
      result.state.attempts.map((attempt) => [
        attempt.profile.identity.provider_id,
        attempt.status,
      ]),
    ).toEqual([
      ['primary', 'timed_out'],
      ['reserve', 'succeeded'],
    ]);
    const fallbackAttempt = result.state.attempts.find(
      (attempt) => attempt.profile.identity.provider_id === 'reserve',
    );
    expect(result.outputs_by_attempt).toEqual({
      [fallbackAttempt?.attempt_id ?? 'missing']: { source: 'fallback' },
    });
  });

  it('fans out deterministic shared reserve replacements through the real runtime loop', async () => {
    const startedPrimaries: string[] = [];
    let releasePrimaries: () => void = () => {};
    const bothPrimariesStarted = new Promise<void>((resolve) => {
      releasePrimaries = resolve;
    });
    const calls: string[] = [];
    const attempts: AttemptExecutionPort = {
      execute: async (launch) => {
        const providerId = launch.profile.identity.provider_id;
        calls.push(providerId);
        if (providerId === 'primary-a' || providerId === 'primary-b') {
          startedPrimaries.push(providerId);
          if (startedPrimaries.length === 2) releasePrimaries();
          await bothPrimariesStarted;
          return {
            kind: 'finished',
            finished: {
              outcome: 'failed',
              error: {
                code: 'primary_failed',
                message: 'Primary failed.',
                category: 'provider',
                retryable: true,
                fallback_allowed: true,
              },
            },
          };
        }
        return {
          kind: 'finished',
          finished: {
            outcome: 'succeeded',
            result_id: `result-${launch.attempt_id}`,
          },
          output: { provider: providerId },
        };
      },
    };

    const result = await runPreparedExecution(
      prepared(
        [profile('primary-a'), profile('primary-b')],
        [profile('reserve-shared'), profile('reserve-second')],
      ),
      {
        store: new InMemoryCoordinationStateStore(),
        coordinator: coordinatorDependencies(),
        attempts,
      },
    );

    expect(startedPrimaries).toEqual(['primary-a', 'primary-b']);
    expect(calls).toEqual([
      'primary-a',
      'primary-b',
      'reserve-shared',
      'reserve-second',
    ]);
    expect(
      result.state.attempts
        .filter((attempt) => attempt.round === 1)
        .map((attempt) => [
          attempt.slot_id,
          attempt.profile.identity.provider_id,
          attempt.status,
        ]),
    ).toEqual([
      ['slot-0', 'reserve-shared', 'succeeded'],
      ['slot-1', 'reserve-second', 'succeeded'],
    ]);
    expect(new Set(calls).size).toBe(calls.length);
    expect(
      result.state.slots.every((slot) => slot.status === 'succeeded'),
    ).toBe(true);
  });
});
