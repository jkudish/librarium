import { describe, expect, it, vi } from 'vitest';
import type { ExecutionProfile } from '../src/contracts/domain/index.js';
import {
  advanceCoordination,
  type CoordinatorState,
  createCoordinatorState,
  recordLaunchDispatched,
} from '../src/core/coordinator.js';
import { CoordinatorStateSchema } from '../src/core/coordinator-state-schema.js';
import {
  type CoordinationCompareAndSwapResult,
  type CoordinationStateStore,
  InMemoryCoordinationStateStore,
  type VersionedCoordinationState,
} from '../src/core/coordinator-store.js';
import type { PreparedResearchExecution } from '../src/core/execution-plan.js';
import { profileIdentityKey } from '../src/core/execution-plan.js';
import {
  type AttemptExecutionPort,
  runPreparedExecution,
} from '../src/core/execution-runtime.js';
import { createProviderAttemptBridge } from '../src/core/provider-attempt-bridge.js';
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
  mode: 'sync' | 'async' = 'sync',
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
      mode,
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

function systemCoordinatorDependencies() {
  let next = 0;
  return {
    clock: { now: Date.now },
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

function resolvedBinding(
  providerId: string,
  provider: Provider,
  resolvedProfile: ExecutionProfile = profile(
    providerId,
    provider.execution === 'background' ? 'background' : 'inline',
  ),
  catalogDigest = 'runtime-digest',
) {
  return {
    binding: {
      adapter_id: `adapter-${providerId}`,
      binding_id: `binding-${providerId}`,
    },
    profile: resolvedProfile,
    catalog_digest: catalogDigest,
    provider,
  };
}

class LoseDispatchLeaseStore implements CoordinationStateStore {
  readonly inner = new InMemoryCoordinationStateStore();
  lostDispatch = false;

  load(requestId: string): Promise<VersionedCoordinationState | undefined> {
    return this.inner.load(requestId);
  }

  create(state: CoordinatorState): Promise<VersionedCoordinationState> {
    return this.inner.create(state);
  }

  async compareAndSwap(
    requestId: string,
    expectedVersion: number,
    state: CoordinatorState,
  ): Promise<CoordinationCompareAndSwapResult> {
    if (
      !this.lostDispatch &&
      state.attempts.some(
        (attempt) =>
          attempt.status === 'running' || attempt.status === 'submitting',
      )
    ) {
      this.lostDispatch = true;
      const wonElsewhere = await this.inner.compareAndSwap(
        requestId,
        expectedVersion,
        state,
      );
      expect(wonElsewhere.ok).toBe(true);
      return {
        ok: false,
        current: await this.inner.load(requestId),
      };
    }
    return this.inner.compareAndSwap(requestId, expectedVersion, state);
  }
}

class AdvanceClockAfterLeaseStore implements CoordinationStateStore {
  readonly inner = new InMemoryCoordinationStateStore();
  advanced = false;

  constructor(private readonly advance: () => void) {}

  load(requestId: string): Promise<VersionedCoordinationState | undefined> {
    return this.inner.load(requestId);
  }

  create(state: CoordinatorState): Promise<VersionedCoordinationState> {
    return this.inner.create(state);
  }

  async compareAndSwap(
    requestId: string,
    expectedVersion: number,
    state: CoordinatorState,
  ): Promise<CoordinationCompareAndSwapResult> {
    const result = await this.inner.compareAndSwap(
      requestId,
      expectedVersion,
      state,
    );
    if (
      result.ok &&
      !this.advanced &&
      state.attempts.some(
        (attempt) =>
          attempt.status === 'dispatch_pending' &&
          attempt.delivery_lease_id !== undefined,
      )
    ) {
      this.advanced = true;
      this.advance();
    }
    return result;
  }
}

class AdvanceClockAfterDispatchStore implements CoordinationStateStore {
  readonly inner = new InMemoryCoordinationStateStore();
  advanced = false;

  constructor(private readonly advance: () => void) {}

  load(requestId: string): Promise<VersionedCoordinationState | undefined> {
    return this.inner.load(requestId);
  }

  create(state: CoordinatorState): Promise<VersionedCoordinationState> {
    return this.inner.create(state);
  }

  async compareAndSwap(
    requestId: string,
    expectedVersion: number,
    state: CoordinatorState,
  ): Promise<CoordinationCompareAndSwapResult> {
    const result = await this.inner.compareAndSwap(
      requestId,
      expectedVersion,
      state,
    );
    if (
      result.ok &&
      !this.advanced &&
      state.attempts.some(
        (attempt) =>
          attempt.status === 'running' || attempt.status === 'submitting',
      )
    ) {
      this.advanced = true;
      this.advance();
    }
    return result;
  }
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
    const resolveExactBinding = vi.fn((binding) =>
      binding.adapter_id === 'adapter-primary'
        ? resolvedBinding('primary', exact)
        : undefined,
    );
    const plan = prepared([profile('primary')]);
    const store = new InMemoryCoordinationStateStore();
    const result = await runPreparedExecution(plan, {
      store,
      coordinator: coordinatorDependencies(),
      attempts: createProviderAttemptBridge({
        resolveExactBinding,
        now: () => start,
      }),
    });

    expect(resolveExactBinding).toHaveBeenCalledExactlyOnceWith({
      adapter_id: 'adapter-primary',
      binding_id: 'binding-primary',
    });
    expect(exact.execute).toHaveBeenCalledExactlyOnceWith(
      'runtime query',
      expect.objectContaining({ timeout: 10, signal: expect.anything() }),
    );
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
        attempts: createProviderAttemptBridge({
          resolveExactBinding: (binding) =>
            binding.adapter_id === 'adapter-durable'
              ? resolvedBinding('durable', durable)
              : undefined,
          now: () => start,
        }),
      },
    );

    expect(durable.submit).toHaveBeenCalledWith(
      'runtime query',
      expect.objectContaining({ timeout: 20, signal: expect.anything() }),
    );
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
        attempts: createProviderAttemptBridge({
          resolveExactBinding: (binding) =>
            binding.adapter_id === 'adapter-durable'
              ? resolvedBinding('durable', durable)
              : binding.adapter_id === 'adapter-reserve'
                ? resolvedBinding('reserve', fallback)
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

  it('rechecks concurrent orphan submissions after the request expires', async () => {
    const plan = prepared(
      [profile('durable-a', 'background'), profile('durable-b', 'background')],
      [],
      'sync',
    );
    const store = new InMemoryCoordinationStateStore();
    const initialDependencies = coordinatorDependencies();
    const started = advanceCoordination(
      createCoordinatorState(plan, initialDependencies),
      initialDependencies,
    );
    let state = started.state;
    for (const launch of started.launches) {
      state = recordLaunchDispatched(
        state,
        launch.attempt_id,
        launch.delivery_lease_id,
        initialDependencies,
      );
    }
    expect(state.attempts.map((attempt) => attempt.status)).toEqual([
      'submitting',
      'submitting',
    ]);
    await store.create(state);
    const resumedDependencies = mutableCoordinatorDependencies();
    resumedDependencies.setNow(start + 60_000);
    const attempts: AttemptExecutionPort = { execute: vi.fn() };

    const result = await runPreparedExecution(plan, {
      store,
      coordinator: resumedDependencies,
      attempts,
      resume_existing: true,
    });

    expect(attempts.execute).not.toHaveBeenCalled();
    expect(result.state.status).toBe('unsuccessful');
    expect(result.state.attempts.map((attempt) => attempt.status)).toEqual([
      'timed_out',
      'timed_out',
    ]);
  });

  it('rejects a latest attempt reference from a different slot', () => {
    const plan = prepared([profile('first'), profile('second')]);
    const dependencies = coordinatorDependencies();
    const advanced = advanceCoordination(
      createCoordinatorState(plan, dependencies),
      dependencies,
    );
    const state = structuredClone(advanced.state);
    state.slots[0]!.latest_attempt_id = state.slots[1]!.latest_attempt_id;

    expect(CoordinatorStateSchema.safeParse(state).success).toBe(false);
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

  it('rejects a resolver result whose binding id differs from the frozen launch', async () => {
    const execute = vi.fn(async () => successfulResult('adapter-primary'));
    const provider: Provider = {
      id: 'adapter-primary',
      displayName: 'Primary',
      tier: 'raw-search',
      envVar: '',
      execution: 'inline',
      execute,
    };
    const result = await runPreparedExecution(prepared([profile('primary')]), {
      store: new InMemoryCoordinationStateStore(),
      coordinator: coordinatorDependencies(),
      attempts: createProviderAttemptBridge({
        resolveExactBinding: () => ({
          binding: {
            adapter_id: 'adapter-primary',
            binding_id: 'different-binding',
          },
          profile: profile('primary'),
          catalog_digest: 'runtime-digest',
          provider,
        }),
        now: () => start,
      }),
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.state.attempts[0]).toMatchObject({
      status: 'failed',
      error: {
        code: 'frozen_adapter_binding_unavailable',
        fallback_allowed: false,
      },
    });
  });

  it.each([
    {
      name: 'execution profile',
      resolvedProfile: profile('different-profile'),
      catalogDigest: 'runtime-digest',
    },
    {
      name: 'catalog digest',
      resolvedProfile: profile('primary'),
      catalogDigest: 'different-digest',
    },
  ])(
    'rejects a resolver result with a mismatched frozen $name',
    async ({ resolvedProfile, catalogDigest }) => {
      const execute = vi.fn(async () => successfulResult('adapter-primary'));
      const provider: Provider = {
        id: 'adapter-primary',
        displayName: 'Primary',
        tier: 'raw-search',
        envVar: '',
        execution: 'inline',
        execute,
      };

      const result = await runPreparedExecution(
        prepared([profile('primary')]),
        {
          store: new InMemoryCoordinationStateStore(),
          coordinator: coordinatorDependencies(),
          attempts: createProviderAttemptBridge({
            resolveExactBinding: () =>
              resolvedBinding(
                'primary',
                provider,
                resolvedProfile,
                catalogDigest,
              ),
            now: () => start,
          }),
        },
      );

      expect(execute).not.toHaveBeenCalled();
      expect(result.state.attempts[0]).toMatchObject({
        status: 'failed',
        error: {
          code: 'frozen_adapter_binding_unavailable',
          fallback_allowed: false,
        },
      });
    },
  );

  it('accepts semantically equal frozen profiles with reordered extension keys', async () => {
    const plannedProfile = profile('primary');
    plannedProfile.extensions = {
      'com.librarium:test': { second: 2, first: 1 },
    };
    const resolvedProfile = profile('primary');
    resolvedProfile.extensions = {
      'com.librarium:test': { first: 1, second: 2 },
    };
    const provider: Provider = {
      id: 'adapter-primary',
      displayName: 'Primary',
      tier: 'raw-search',
      envVar: '',
      execution: 'inline',
      execute: vi.fn(async () => successfulResult('adapter-primary')),
    };

    const result = await runPreparedExecution(prepared([plannedProfile]), {
      store: new InMemoryCoordinationStateStore(),
      coordinator: coordinatorDependencies(),
      attempts: createProviderAttemptBridge({
        resolveExactBinding: () =>
          resolvedBinding('primary', provider, resolvedProfile),
        now: () => start,
      }),
    });

    expect(provider.execute).toHaveBeenCalledOnce();
    expect(result.state.status).toBe('succeeded');
  });

  it('keeps polling through transient errors and repeated running states before fallback', async () => {
    const pollSteps: Array<Error | { status: 'running' | 'failed' }> = [
      new Error('Bearer secret-token'),
      { status: 'running' },
      { status: 'running' },
      { status: 'failed' },
    ];
    const durable: Provider = {
      id: 'adapter-durable',
      displayName: 'Durable',
      tier: 'deep-research',
      envVar: '',
      execution: 'background',
      execute: vi.fn(),
      submit: vi.fn(async () => ({
        provider: 'adapter-durable',
        taskId: 'task-running',
        query: 'runtime query',
        submittedAt: start,
        status: 'pending' as const,
      })),
      poll: vi.fn(async () => {
        const step = pollSteps.shift();
        if (step instanceof Error) throw step;
        if (!step) throw new Error('missing poll step');
        return step;
      }),
      retrieve: vi.fn(),
    };
    const reserveExecute = vi.fn(async () =>
      successfulResult('adapter-reserve'),
    );
    const reserve: Provider = {
      id: 'adapter-reserve',
      displayName: 'Reserve',
      tier: 'raw-search',
      envVar: '',
      execution: 'inline',
      execute: reserveExecute,
    };
    const result = await runPreparedExecution(
      prepared([profile('durable', 'background')], [profile('reserve')]),
      {
        store: new InMemoryCoordinationStateStore(),
        coordinator: coordinatorDependencies(),
        attempts: createProviderAttemptBridge({
          resolveExactBinding: (binding) =>
            binding.adapter_id === 'adapter-durable'
              ? resolvedBinding('durable', durable)
              : binding.adapter_id === 'adapter-reserve'
                ? resolvedBinding('reserve', reserve)
                : undefined,
          now: () => start,
          wait: async () => {},
        }),
      },
    );

    expect(durable.poll).toHaveBeenCalledTimes(4);
    expect(reserveExecute).toHaveBeenCalledOnce();
    expect(result.state.status).toBe('succeeded');
    expect(result.state.attempts[0]).toMatchObject({
      status: 'failed',
      durable_handle: { status: 'failed' },
      error: {
        code: 'provider_task_failed',
        fallback_allowed: true,
      },
    });
    expect(JSON.stringify(result.state)).not.toContain('secret-token');
  });

  it('returns an async accepted handle without polling or retrieving', async () => {
    const durable: Provider = {
      id: 'adapter-durable',
      displayName: 'Durable',
      tier: 'deep-research',
      envVar: '',
      execution: 'background',
      execute: vi.fn(),
      submit: vi.fn(async () => ({
        provider: 'adapter-durable',
        taskId: 'async-task',
        query: 'runtime query',
        submittedAt: start,
        status: 'pending' as const,
      })),
      poll: vi.fn(),
      retrieve: vi.fn(),
    };
    const result = await runPreparedExecution(
      prepared([profile('durable', 'background')], [], 'async'),
      {
        store: new InMemoryCoordinationStateStore(),
        coordinator: coordinatorDependencies(),
        attempts: createProviderAttemptBridge({
          resolveExactBinding: () => resolvedBinding('durable', durable),
          now: () => start,
        }),
      },
    );

    expect(result.state.status).toBe('running');
    expect(result.state.attempts[0]).toMatchObject({
      status: 'submitted',
      durable_handle: { provider_task_id: 'async-task', status: 'pending' },
    });
    expect(result.outputs_by_attempt).toEqual({});
    expect(durable.poll).not.toHaveBeenCalled();
    expect(durable.retrieve).not.toHaveBeenCalled();
  });

  it('retrieves an already-completed durable submission in async mode', async () => {
    const durable: Provider = {
      id: 'adapter-durable',
      displayName: 'Durable',
      tier: 'deep-research',
      envVar: '',
      execution: 'background',
      execute: vi.fn(),
      submit: vi.fn(async () => ({
        provider: 'adapter-durable',
        taskId: 'already-completed',
        query: 'runtime query',
        submittedAt: start,
        status: 'completed' as const,
      })),
      poll: vi.fn(),
      retrieve: vi.fn(async () => successfulResult('adapter-durable')),
    };

    const result = await runPreparedExecution(
      prepared([profile('durable', 'background')], [], 'async'),
      {
        store: new InMemoryCoordinationStateStore(),
        coordinator: coordinatorDependencies(),
        attempts: createProviderAttemptBridge({
          resolveExactBinding: () => resolvedBinding('durable', durable),
          now: () => start,
        }),
      },
    );

    expect(result.state.status).toBe('succeeded');
    expect(result.state.attempts[0]).toMatchObject({
      status: 'succeeded',
      durable_handle: {
        provider_task_id: 'already-completed',
        status: 'succeeded',
      },
    });
    expect(durable.poll).not.toHaveBeenCalled();
    expect(durable.retrieve).toHaveBeenCalledOnce();
    expect(result.outputs_by_attempt).toEqual(
      expect.objectContaining({
        'attempt-2': expect.objectContaining({ content: 'done' }),
      }),
    );
  });

  it.each([
    {
      taskStatus: 'failed' as const,
      attemptStatus: 'failed',
      errorCode: 'provider_task_failed',
    },
    {
      taskStatus: 'cancelled' as const,
      attemptStatus: 'cancelled',
      errorCode: 'provider_task_cancelled',
    },
  ])(
    'terminalizes an already-$taskStatus durable submission without polling',
    async ({ taskStatus, attemptStatus, errorCode }) => {
      const durable: Provider = {
        id: 'adapter-durable',
        displayName: 'Durable',
        tier: 'deep-research',
        envVar: '',
        execution: 'background',
        execute: vi.fn(),
        submit: vi.fn(async () => ({
          provider: 'adapter-durable',
          taskId: `already-${taskStatus}`,
          query: 'runtime query',
          submittedAt: start,
          status: taskStatus,
        })),
        poll: vi.fn(),
        retrieve: vi.fn(),
      };

      const result = await runPreparedExecution(
        prepared([profile('durable', 'background')], [], 'async'),
        {
          store: new InMemoryCoordinationStateStore(),
          coordinator: coordinatorDependencies(),
          attempts: createProviderAttemptBridge({
            resolveExactBinding: () => resolvedBinding('durable', durable),
            now: () => start,
          }),
        },
      );

      expect(result.state.attempts[0]).toMatchObject({
        status: attemptStatus,
        durable_handle: { status: taskStatus },
        error: { code: errorCode },
      });
      expect(durable.poll).not.toHaveBeenCalled();
      expect(durable.retrieve).not.toHaveBeenCalled();
    },
  );

  it('retains accepted durable work after a local execution exception', async () => {
    const result = await runPreparedExecution(
      prepared([profile('durable', 'background')], [], 'async'),
      {
        store: new InMemoryCoordinationStateStore(),
        coordinator: coordinatorDependencies(),
        attempts: {
          execute: async (launch, context) => {
            await context.submissionAccepted({
              handle_id: launch.attempt_id,
              provider_task_id: 'accepted-before-local-error',
              provider: launch.profile.identity,
              submitted_at: new Date(start).toISOString(),
              status: 'pending',
            });
            throw new Error('Authorization: secret-after-acceptance');
          },
        },
      },
    );

    expect(result.state.status).toBe('running');
    expect(result.state.attempts[0]).toMatchObject({
      status: 'submitted',
      durable_handle: {
        provider_task_id: 'accepted-before-local-error',
        status: 'pending',
      },
      transient_poll_error: {
        code: 'attempt_execution_interrupted',
        fallback_allowed: false,
        retryable: true,
      },
    });
    expect(JSON.stringify(result.state)).not.toContain(
      'secret-after-acceptance',
    );
  });

  it('times out a hung inline call and executes an eligible fallback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    try {
      let aborted = false;
      const primary: Provider = {
        id: 'adapter-primary',
        displayName: 'Primary',
        tier: 'raw-search',
        envVar: '',
        execution: 'inline',
        execute: vi.fn(
          (_query, options) =>
            new Promise<ProviderResult>((_resolve, reject) => {
              options.signal?.addEventListener(
                'abort',
                () => {
                  aborted = true;
                  reject(new Error('aborted by deadline'));
                },
                { once: true },
              );
            }),
        ),
      };
      const reserveExecute = vi.fn(async () =>
        successfulResult('adapter-reserve'),
      );
      const reserve: Provider = {
        id: 'adapter-reserve',
        displayName: 'Reserve',
        tier: 'raw-search',
        envVar: '',
        execution: 'inline',
        execute: reserveExecute,
      };
      const running = runPreparedExecution(
        prepared([profile('primary')], [profile('reserve')]),
        {
          store: new InMemoryCoordinationStateStore(),
          coordinator: systemCoordinatorDependencies(),
          attempts: createProviderAttemptBridge({
            resolveExactBinding: (binding) =>
              binding.adapter_id === 'adapter-primary'
                ? resolvedBinding('primary', primary)
                : binding.adapter_id === 'adapter-reserve'
                  ? resolvedBinding('reserve', reserve)
                  : undefined,
            now: Date.now,
          }),
        },
      );

      await vi.advanceTimersByTimeAsync(10_000);
      const result = await running;
      expect(result.state.attempts[0]).toMatchObject({
        status: 'timed_out',
        error: { code: 'attempt_deadline_exceeded', fallback_allowed: true },
      });
      expect(reserveExecute).toHaveBeenCalledOnce();
      expect(aborted).toBe(true);
      expect(result.state.status).toBe('succeeded');
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns a hung submit into acceptance uncertainty without fallback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    try {
      const submit = vi.fn(() => new Promise<never>(() => {}));
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
      const reserveExecute = vi.fn(async () =>
        successfulResult('adapter-reserve'),
      );
      const reserve: Provider = {
        id: 'adapter-reserve',
        displayName: 'Reserve',
        tier: 'raw-search',
        envVar: '',
        execution: 'inline',
        execute: reserveExecute,
      };
      const running = runPreparedExecution(
        prepared([profile('durable', 'background')], [profile('reserve')]),
        {
          store: new InMemoryCoordinationStateStore(),
          coordinator: systemCoordinatorDependencies(),
          attempts: createProviderAttemptBridge({
            resolveExactBinding: (binding) =>
              binding.adapter_id === 'adapter-durable'
                ? resolvedBinding('durable', durable)
                : binding.adapter_id === 'adapter-reserve'
                  ? resolvedBinding('reserve', reserve)
                  : undefined,
            now: Date.now,
          }),
        },
      );

      await vi.advanceTimersByTimeAsync(20_000);
      const result = await running;
      expect(submit).toHaveBeenCalledOnce();
      expect(result.state.attempts[0]?.status).toBe('acceptance_unknown');
      expect(result.state.unresolved_acceptances[0]).toMatchObject({
        reason: 'submission_deadline_exceeded',
      });
      expect(reserveExecute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fall back when an accepted durable poll exceeds its deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    try {
      const durable: Provider = {
        id: 'adapter-durable',
        displayName: 'Durable',
        tier: 'deep-research',
        envVar: '',
        execution: 'background',
        execute: vi.fn(),
        submit: vi.fn(async () => ({
          provider: 'adapter-durable',
          taskId: 'hung-poll',
          query: 'runtime query',
          submittedAt: start,
          status: 'pending' as const,
        })),
        poll: vi.fn(() => new Promise<never>(() => {})),
        retrieve: vi.fn(),
      };
      const reserveExecute = vi.fn(async () =>
        successfulResult('adapter-reserve'),
      );
      const reserve: Provider = {
        id: 'adapter-reserve',
        displayName: 'Reserve',
        tier: 'raw-search',
        envVar: '',
        execution: 'inline',
        execute: reserveExecute,
      };
      const running = runPreparedExecution(
        prepared([profile('durable', 'background')], [profile('reserve')]),
        {
          store: new InMemoryCoordinationStateStore(),
          coordinator: systemCoordinatorDependencies(),
          attempts: createProviderAttemptBridge({
            resolveExactBinding: (binding) =>
              binding.adapter_id === 'adapter-durable'
                ? resolvedBinding('durable', durable)
                : binding.adapter_id === 'adapter-reserve'
                  ? resolvedBinding('reserve', reserve)
                  : undefined,
            now: Date.now,
          }),
        },
      );

      await vi.advanceTimersByTimeAsync(20_000);
      const result = await running;
      expect(result.state.attempts[0]).toMatchObject({
        status: 'timed_out',
        durable_handle: { provider_task_id: 'hung-poll', status: 'pending' },
        error: {
          code: 'accepted_durable_attempt_deadline_exceeded',
          fallback_allowed: false,
        },
      });
      expect(reserveExecute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a succeeded handle when retrieval fails and permits fallback', async () => {
    const durable: Provider = {
      id: 'adapter-durable',
      displayName: 'Durable',
      tier: 'deep-research',
      envVar: '',
      execution: 'background',
      execute: vi.fn(),
      submit: vi.fn(async () => ({
        provider: 'adapter-durable',
        taskId: 'retrieve-failure',
        query: 'runtime query',
        submittedAt: start,
        status: 'pending' as const,
      })),
      poll: vi.fn(async () => ({ status: 'completed' as const })),
      retrieve: vi.fn(async () => {
        throw new Error('Authorization: secret-token');
      }),
    };
    const reserveExecute = vi.fn(async () =>
      successfulResult('adapter-reserve'),
    );
    const reserve: Provider = {
      id: 'adapter-reserve',
      displayName: 'Reserve',
      tier: 'raw-search',
      envVar: '',
      execution: 'inline',
      execute: reserveExecute,
    };
    const result = await runPreparedExecution(
      prepared([profile('durable', 'background')], [profile('reserve')]),
      {
        store: new InMemoryCoordinationStateStore(),
        coordinator: coordinatorDependencies(),
        attempts: createProviderAttemptBridge({
          resolveExactBinding: (binding) =>
            binding.adapter_id === 'adapter-durable'
              ? resolvedBinding('durable', durable)
              : binding.adapter_id === 'adapter-reserve'
                ? resolvedBinding('reserve', reserve)
                : undefined,
          now: () => start,
        }),
      },
    );

    expect(result.state.attempts[0]).toMatchObject({
      status: 'failed',
      durable_handle: { status: 'succeeded' },
      error: { code: 'adapter_retrieve_failed', fallback_allowed: true },
    });
    expect(JSON.stringify(result.state)).not.toContain('secret-token');
    expect(reserveExecute).toHaveBeenCalledOnce();
    expect(result.state.status).toBe('succeeded');
  });

  it('does not spend a fallback after provider-side durable cancellation', async () => {
    const durable: Provider = {
      id: 'adapter-durable',
      displayName: 'Durable',
      tier: 'deep-research',
      envVar: '',
      execution: 'background',
      execute: vi.fn(),
      submit: vi.fn(async () => ({
        provider: 'adapter-durable',
        taskId: 'cancelled-task',
        query: 'runtime query',
        submittedAt: start,
        status: 'pending' as const,
      })),
      poll: vi.fn(async () => ({ status: 'cancelled' as const })),
      retrieve: vi.fn(),
    };
    const reserveExecute = vi.fn(async () =>
      successfulResult('adapter-reserve'),
    );
    const reserve: Provider = {
      id: 'adapter-reserve',
      displayName: 'Reserve',
      tier: 'raw-search',
      envVar: '',
      execution: 'inline',
      execute: reserveExecute,
    };
    const result = await runPreparedExecution(
      prepared([profile('durable', 'background')], [profile('reserve')]),
      {
        store: new InMemoryCoordinationStateStore(),
        coordinator: coordinatorDependencies(),
        attempts: createProviderAttemptBridge({
          resolveExactBinding: (binding) =>
            binding.adapter_id === 'adapter-durable'
              ? resolvedBinding('durable', durable)
              : binding.adapter_id === 'adapter-reserve'
                ? resolvedBinding('reserve', reserve)
                : undefined,
          now: () => start,
        }),
      },
    );

    expect(result.state.attempts[0]).toMatchObject({
      status: 'cancelled',
      durable_handle: { status: 'cancelled' },
      error: { code: 'provider_task_cancelled', fallback_allowed: false },
    });
    expect(reserveExecute).not.toHaveBeenCalled();
  });

  it('does not execute after losing the dispatch lease CAS race', async () => {
    const store = new LoseDispatchLeaseStore();
    const attempts: AttemptExecutionPort = { execute: vi.fn() };
    const result = await runPreparedExecution(prepared([profile('primary')]), {
      store,
      coordinator: coordinatorDependencies(),
      attempts,
    });

    expect(store.lostDispatch).toBe(true);
    expect(attempts.execute).not.toHaveBeenCalled();
    expect(result.state.attempts[0]?.status).toBe('running');
  });

  it('does not dispatch after the request deadline wins the launch race', async () => {
    const dependencies = mutableCoordinatorDependencies();
    const store = new AdvanceClockAfterLeaseStore(() => {
      dependencies.setNow(start + 60_000);
    });
    const attempts: AttemptExecutionPort = { execute: vi.fn() };

    const result = await runPreparedExecution(prepared([profile('primary')]), {
      store,
      coordinator: dependencies,
      attempts,
    });

    expect(store.advanced).toBe(true);
    expect(attempts.execute).not.toHaveBeenCalled();
    expect(result.state.status).toBe('unsuccessful');
    expect(result.state.attempts[0]).toMatchObject({
      status: 'timed_out',
      error: { code: 'request_deadline_exceeded' },
    });
  });

  it('does not invoke the port when the request deadline crosses after the dispatch CAS', async () => {
    const dependencies = mutableCoordinatorDependencies();
    const store = new AdvanceClockAfterDispatchStore(() => {
      dependencies.setNow(start + 60_000);
    });
    const attempts: AttemptExecutionPort = { execute: vi.fn() };

    const result = await runPreparedExecution(prepared([profile('primary')]), {
      store,
      coordinator: dependencies,
      attempts,
    });

    expect(store.advanced).toBe(true);
    expect(attempts.execute).not.toHaveBeenCalled();
    expect(result.state.status).toBe('unsuccessful');
    expect(result.state.attempts[0]).toMatchObject({
      status: 'timed_out',
      error: { code: 'request_deadline_exceeded' },
    });
  });

  it('reclaims an expired launch lease before dispatching exactly once', async () => {
    const dependencies = mutableCoordinatorDependencies();
    const store = new AdvanceClockAfterLeaseStore(() => {
      dependencies.setNow(start + 1_001);
    });
    const execute = vi.fn(async (launch) => ({
      kind: 'finished' as const,
      finished: {
        outcome: 'succeeded' as const,
        result_id: `result-${launch.attempt_id}`,
      },
    }));

    const result = await runPreparedExecution(prepared([profile('primary')]), {
      store,
      coordinator: dependencies,
      attempts: { execute },
    });

    expect(store.advanced).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(result.state.status).toBe('succeeded');
  });

  it('derives enough CAS retries for the maximum concurrent completion wave', async () => {
    const primaries = Array.from({ length: 64 }, (_, index) =>
      profile(`primary-${index}`),
    );
    const result = await runPreparedExecution(prepared(primaries), {
      store: new InMemoryCoordinationStateStore(),
      coordinator: coordinatorDependencies(),
      attempts: {
        execute: async (launch) => ({
          kind: 'finished',
          finished: {
            outcome: 'succeeded',
            result_id: `result-${launch.attempt_id}`,
          },
        }),
      },
    });

    expect(result.state.status).toBe('succeeded');
    expect(result.state.attempts).toHaveLength(64);
  });

  it('bounds persisted provider diagnostics', async () => {
    const provider: Provider = {
      id: 'adapter-primary',
      displayName: 'Primary',
      tier: 'raw-search',
      envVar: '',
      execution: 'inline',
      execute: vi.fn(async () => ({
        ...successfulResult('adapter-primary'),
        error: `Bearer secret-token ${'x'.repeat(3_000)}`,
      })),
    };
    const result = await runPreparedExecution(prepared([profile('primary')]), {
      store: new InMemoryCoordinationStateStore(),
      coordinator: coordinatorDependencies(),
      attempts: createProviderAttemptBridge({
        resolveExactBinding: () => resolvedBinding('primary', provider),
        now: () => start,
      }),
    });

    expect(result.state.attempts[0]?.error).toEqual(
      expect.objectContaining({
        code: 'provider_reported_error',
        message: 'The provider returned an error.',
      }),
    );
    expect(JSON.stringify(result.state)).not.toContain('secret-token');
  });
});
