import { describe, expect, it } from 'vitest';
import type {
  DurableHandle,
  ExecutionProfile,
  StructuredError,
} from '../src/contracts/domain/index.js';
import { LifecycleTraceSchema } from '../src/contracts/interchange/lifecycle.js';
import {
  acceptedDurableHandles,
  advanceCoordination,
  type CoordinatorState,
  cancelCoordination,
  claimFallbackRound,
  createCoordinatorState,
  failCoordination,
  finalizeCoordination,
  mapCoordinatorOutcome,
  recordAcceptanceRejected,
  recordAcceptanceUnknown,
  recordAttemptFinished,
  recordLaunchDispatched,
  recordSubmissionAccepted,
  recordTransientPollFailure,
  resumeCoordination,
  setRefinedSlotQuery,
  startLaunchableAttempts,
} from '../src/core/coordinator.js';
import {
  InMemoryCoordinationStateStore,
  updateCoordinationState,
} from '../src/core/coordinator-store.js';
import {
  type PreparedResearchExecution,
  profileIdentityKey,
} from '../src/core/execution-plan.js';

function inlineProfile(providerId: string): ExecutionProfile {
  return {
    identity: {
      provider_id: providerId,
      profile_id: 'grounded-web',
      target: {
        primary: {
          model_selection: 'fixed',
          kind: 'model',
          target_id: `${providerId}-fixture-model`,
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
    invocation: 'inline',
    resumability: 'none',
  };
}

function durableProfile(providerId: string): ExecutionProfile {
  return {
    ...inlineProfile(providerId),
    invocation: 'background',
    resumability: 'durable',
  };
}

function processLocalProfile(providerId: string): ExecutionProfile {
  return {
    ...inlineProfile(providerId),
    invocation: 'background',
    resumability: 'process_local',
  };
}

interface PreparedOptions {
  primaries: readonly ExecutionProfile[];
  reserve?: readonly {
    profile: ExecutionProfile;
    eligibleSlots: readonly number[];
  }[];
  maxConcurrency?: number;
  inlineAttemptDeadlineMs?: number;
  backgroundAttemptDeadlineMs?: number;
  requestDeadlineMs?: number;
  pollIntervalMs?: number;
  estimates?: Readonly<Record<string, string | undefined>>;
  budgets?: {
    max_estimated_cost_microusd?: string;
    max_actual_cost_microusd?: string;
  };
  mode?: 'sync' | 'async';
}

function preparedExecution(
  options: PreparedOptions,
): PreparedResearchExecution {
  const reserve = options.reserve ?? [];
  const profiles = [
    ...options.primaries,
    ...reserve.map((candidate) => candidate.profile),
  ];
  const profilePlans = Object.fromEntries(
    profiles.map((profile) => {
      const key = profileIdentityKey(profile.identity);
      const estimate = options.estimates?.[profile.identity.provider_id];
      return [
        key,
        {
          profile_key: key,
          identity: profile.identity,
          binding: {
            adapter_id: `adapter-${profile.identity.provider_id}`,
            binding_id: `binding-${profile.identity.profile_id}`,
          },
          estimate:
            estimate === undefined
              ? undefined
              : { estimated_cost_microusd: estimate },
        },
      ];
    }),
  );
  const fallback =
    reserve.length === 0
      ? ({ kind: 'disabled' } as const)
      : ({
          kind: 'explicit',
          reserve: reserve.map(({ profile }) => ({
            provider_id: profile.identity.provider_id,
            profile_id: profile.identity.profile_id,
          })),
        } as const);
  return {
    request: {
      interchange_version: '1.0.0',
      message_type: 'request',
      request_id: 'request-1',
      requested_at: '2026-08-08T12:00:00.000Z',
      mode: options.mode ?? 'sync',
      query: 'original query',
      slots: options.primaries.map((profile, position) => ({
        slot_id: `slot-${position}`,
        position,
        requirements: {
          result_kind: 'grounded_answer',
          grounding_policy: 'required',
          observation_mode: 'api_output',
          corpora: ['web'],
          retrieval_methods: ['model_search_tool'],
        },
        primary: profile,
      })),
      fallback_reserve: reserve.map((candidate, position) => ({
        candidate_id: `candidate-${position}`,
        position,
        profile: candidate.profile,
        eligible_slot_ids: candidate.eligibleSlots.map(
          (slot) => `slot-${slot}`,
        ),
      })),
    },
    policy: {
      limits: {
        max_concurrency: options.maxConcurrency ?? options.primaries.length,
        request_deadline_ms: options.requestDeadlineMs ?? 60_000,
        inline_attempt_deadline_ms: options.inlineAttemptDeadlineMs ?? 30_000,
        background_attempt_deadline_ms:
          options.backgroundAttemptDeadlineMs ?? 30_000,
        poll_interval_ms: options.pollIntervalMs ?? 1_000,
      },
      budgets: options.budgets,
      fallback,
      exclusions: [],
      refinement: { kind: 'disabled' },
    },
    profile_plans_by_identity: profilePlans,
    catalog: { revision: 'fixture-r1', digest: 'fixture-digest' },
    notices: [],
  };
}

function dependencies(start = Date.parse('2026-08-08T12:00:00Z')) {
  let now = start;
  const counts = new Map<string, number>();
  return {
    clock: { now: () => now },
    ids: {
      next: (scope: 'attempt' | 'event' | 'delivery_lease') => {
        const count = (counts.get(scope) ?? 0) + 1;
        counts.set(scope, count);
        return `${scope}-${count}`;
      },
    },
    setNow(value: number) {
      now = value;
    },
  };
}

function providerFailure(
  fallbackAllowed: boolean,
  code = 'provider_failed',
): StructuredError {
  return {
    code,
    message: 'The provider failed.',
    category: 'provider',
    retryable: true,
    fallback_allowed: fallbackAllowed,
  };
}

function internalFailure(): StructuredError {
  return {
    code: 'coordinator_failed',
    message: 'The coordinator infrastructure failed.',
    category: 'internal',
    retryable: true,
    fallback_allowed: false,
  };
}

function handle(
  profile: ExecutionProfile,
  status: DurableHandle['status'],
): DurableHandle {
  return {
    handle_id: `handle-${profile.identity.provider_id}`,
    provider_task_id: `task-${profile.identity.provider_id}`,
    provider: profile.identity,
    submitted_at: '2026-08-08T12:00:00.000Z',
    last_observed_at: '2026-08-08T12:00:01.000Z',
    status,
  };
}

function startAll(
  prepared: PreparedResearchExecution,
  deps: ReturnType<typeof dependencies>,
): CoordinatorState {
  const started = startLaunchableAttempts(
    createCoordinatorState(prepared, deps),
    deps,
  );
  return dispatchLaunches(started.state, started.launches, deps);
}

function dispatchLaunches(
  state: CoordinatorState,
  launches: ReturnType<typeof startLaunchableAttempts>['launches'],
  deps: ReturnType<typeof dependencies>,
): CoordinatorState {
  return launches.reduce(
    (state, launch) =>
      recordLaunchDispatched(
        state,
        launch.attempt_id,
        launch.delivery_lease_id,
        deps,
      ),
    state,
  );
}

describe('deterministic coordinator rounds', () => {
  it('allocates a shared reserve by failed slot position with eligibility holes', () => {
    const deps = dependencies();
    const prepared = preparedExecution({
      primaries: [inlineProfile('primary-a'), inlineProfile('primary-b')],
      reserve: [
        { profile: inlineProfile('reserve-b-first'), eligibleSlots: [1] },
        { profile: inlineProfile('reserve-shared'), eligibleSlots: [0, 1] },
        { profile: inlineProfile('reserve-last'), eligibleSlots: [0, 1] },
      ],
    });
    let state = startAll(prepared, deps);
    for (const attempt of [...state.attempts]) {
      state = recordAttemptFinished(
        state,
        attempt.attempt_id,
        { outcome: 'failed', error: providerFailure(true) },
        deps,
      );
    }

    const round = claimFallbackRound(state, deps);
    expect(
      round.claims.map(({ slot_id, candidate_id }) => [slot_id, candidate_id]),
    ).toEqual([
      ['slot-0', 'candidate-1'],
      ['slot-1', 'candidate-0'],
    ]);
    expect(
      round.state.reserve
        .filter((candidate) => candidate.claimed_by_slot_id)
        .map((candidate) => candidate.candidate_id),
    ).toEqual(['candidate-0', 'candidate-1']);

    const replacement = startLaunchableAttempts(round.state, deps);
    expect(
      replacement.launches.map((launch) => launch.profile.identity.provider_id),
    ).toEqual(['reserve-shared', 'reserve-b-first']);
    state = dispatchLaunches(replacement.state, replacement.launches, deps);
    for (const attempt of state.attempts.filter(
      (candidate) => candidate.round === 1,
    )) {
      state = recordAttemptFinished(
        state,
        attempt.attempt_id,
        { outcome: 'succeeded', result_id: `result-${attempt.slot_id}` },
        deps,
      );
    }
    state = finalizeCoordination(state, deps);

    const eventKinds = state.lifecycle.map((event) => event.event_kind);
    expect(eventKinds[0]).toBe('request_started');
    expect(eventKinds.at(-1)).toBe('request_completed');
    const primaryAttemptIds = new Set(
      state.attempts
        .filter((attempt) => attempt.round === 0)
        .map((attempt) => attempt.attempt_id),
    );
    const primaryFinishIndexes = state.lifecycle.flatMap((event, index) =>
      event.event_kind === 'attempt_finished' &&
      primaryAttemptIds.has(event.attempt_id)
        ? [index]
        : [],
    );
    const fallbackIndexes = state.lifecycle.flatMap((event, index) =>
      event.event_kind === 'fallback_selected' ? [index] : [],
    );
    expect(Math.max(...primaryFinishIndexes)).toBeLessThan(
      Math.min(...fallbackIndexes),
    );
    for (const [index, event] of state.lifecycle.entries()) {
      if (event.event_kind !== 'fallback_selected') continue;
      const replacementStart = state.lifecycle.findIndex(
        (candidate) =>
          candidate.event_kind === 'attempt_started' &&
          candidate.attempt_id === event.data.replacement_attempt_id,
      );
      expect(index).toBeLessThan(replacementStart);
    }
    expect(() => LifecycleTraceSchema.parse(state.lifecycle)).not.toThrow();
  });

  it('accounts for earlier same-round fallback reservations when choosing later candidates', () => {
    const deps = dependencies();
    const prepared = preparedExecution({
      primaries: [inlineProfile('primary-a'), inlineProfile('primary-b')],
      reserve: [
        { profile: inlineProfile('reserve-six-a'), eligibleSlots: [0] },
        { profile: inlineProfile('reserve-six-b'), eligibleSlots: [1] },
        { profile: inlineProfile('reserve-four-b'), eligibleSlots: [1] },
      ],
      estimates: {
        'primary-a': '0',
        'primary-b': '0',
        'reserve-six-a': '6',
        'reserve-six-b': '6',
        'reserve-four-b': '4',
      },
      budgets: { max_estimated_cost_microusd: '10' },
    });
    let state = startAll(prepared, deps);
    for (const attempt of [...state.attempts]) {
      state = recordAttemptFinished(
        state,
        attempt.attempt_id,
        { outcome: 'failed', error: providerFailure(true) },
        deps,
      );
    }
    const round = claimFallbackRound(state, deps);
    expect(round.claims.map((claim) => claim.candidate_id)).toEqual([
      'candidate-0',
      'candidate-2',
    ]);
    const started = startLaunchableAttempts(round.state, deps);
    expect(
      started.launches.map((launch) => launch.profile.identity.provider_id),
    ).toEqual(['reserve-six-a', 'reserve-four-b']);
  });

  it('allows only the concurrent CAS winner to receive launches', async () => {
    const deps = dependencies();
    const prepared = preparedExecution({
      primaries: [inlineProfile('primary-a'), inlineProfile('primary-b')],
      reserve: [
        { profile: inlineProfile('reserve-a'), eligibleSlots: [0, 1] },
        { profile: inlineProfile('reserve-b'), eligibleSlots: [0, 1] },
      ],
    });
    let state = startAll(prepared, deps);
    for (const attempt of [...state.attempts]) {
      state = recordAttemptFinished(
        state,
        attempt.attempt_id,
        { outcome: 'failed', error: providerFailure(true) },
        deps,
      );
    }
    const store = new InMemoryCoordinationStateStore();
    await store.create(state);

    const resumes = await Promise.all([
      resumeCoordination(store, state.request_id, deps),
      resumeCoordination(store, state.request_id, deps),
    ]);
    expect(resumes.map((result) => result.launches.length).sort()).toEqual([
      0, 2,
    ]);

    const persisted = await store.load(state.request_id);
    expect(persisted?.version).toBe(2);
    const claimedCandidates =
      persisted?.state.reserve.filter(
        (candidate) => candidate.claimed_by_slot_id,
      ) ?? [];
    expect(claimedCandidates).toHaveLength(2);
    expect(
      new Set(claimedCandidates.map((candidate) => candidate.candidate_id))
        .size,
    ).toBe(2);
    const replacementAttempts =
      persisted?.state.attempts.filter((attempt) => attempt.round === 1) ?? [];
    expect(replacementAttempts).toHaveLength(2);
    expect(
      new Set(
        replacementAttempts.map((attempt) =>
          profileIdentityKey(attempt.profile.identity),
        ),
      ).size,
    ).toBe(2);
  });

  it('replays an undispatched launch only after its delivery lease expires', async () => {
    const start = Date.parse('2026-08-08T12:00:00Z');
    const deps = dependencies(start);
    const state = createCoordinatorState(
      preparedExecution({ primaries: [inlineProfile('primary')] }),
      deps,
    );
    const store = new InMemoryCoordinationStateStore();
    await store.create(state);

    const first = await resumeCoordination(store, state.request_id, deps);
    expect(first.launches).toHaveLength(1);
    expect(first.state.attempts[0]?.status).toBe('dispatch_pending');

    deps.setNow(start + 500);
    const leased = await resumeCoordination(store, state.request_id, deps);
    expect(leased.launches).toEqual([]);

    deps.setNow(start + 1_000);
    const replayed = await resumeCoordination(store, state.request_id, deps);
    expect(replayed.launches).toHaveLength(1);
    expect(replayed.launches[0]?.attempt_id).toBe(
      first.launches[0]?.attempt_id,
    );
    expect(replayed.launches[0]?.idempotency_key).toBe(
      first.launches[0]?.attempt_id,
    );
    expect(replayed.launches[0]?.delivery_lease_id).not.toBe(
      first.launches[0]?.delivery_lease_id,
    );
    expect({
      profile: replayed.launches[0]?.profile,
      binding: replayed.launches[0]?.binding,
      query: replayed.launches[0]?.query,
      idempotency_key: replayed.launches[0]?.idempotency_key,
    }).toEqual({
      profile: first.launches[0]?.profile,
      binding: first.launches[0]?.binding,
      query: first.launches[0]?.query,
      idempotency_key: first.launches[0]?.idempotency_key,
    });

    const dispatched = recordLaunchDispatched(
      replayed.state,
      replayed.launches[0]?.attempt_id ?? '',
      replayed.launches[0]?.delivery_lease_id ?? '',
      deps,
    );
    expect(dispatched.attempts[0]?.status).toBe('running');
    expect(dispatched.lifecycle.map((event) => event.event_kind)).toEqual([
      'request_started',
      'attempt_started',
    ]);
  });

  it('never permits a delivery lease to outlive the pending attempt deadline', () => {
    const start = Date.parse('2026-08-08T12:00:00Z');
    const deps = dependencies(start);
    const started = startLaunchableAttempts(
      createCoordinatorState(
        preparedExecution({
          primaries: [inlineProfile('inline')],
          inlineAttemptDeadlineMs: 1_000,
          backgroundAttemptDeadlineMs: 10_000,
          requestDeadlineMs: 10_000,
          pollIntervalMs: 5_000,
        }),
        deps,
      ),
      deps,
    );
    expect(started.state.attempts[0]?.delivery_lease_expires_at).toBe(
      new Date(start + 1_000).toISOString(),
    );
    deps.setNow(start + 1_000);
    expect(() =>
      recordLaunchDispatched(
        started.state,
        started.launches[0]?.attempt_id ?? '',
        started.launches[0]?.delivery_lease_id ?? '',
        deps,
      ),
    ).toThrow('delivery lease has expired');
    expect(started.state.lifecycle.map((event) => event.event_kind)).toEqual([
      'request_started',
    ]);
  });

  it('keeps refined queries private and inherits them across replacements', () => {
    const deps = dependencies();
    const prepared = preparedExecution({
      primaries: [inlineProfile('primary')],
      reserve: [{ profile: inlineProfile('reserve'), eligibleSlots: [0] }],
    });
    let state = createCoordinatorState(prepared, deps);
    state = setRefinedSlotQuery(state, 'slot-0', '  refined private query  ');
    let advanced = startLaunchableAttempts(state, deps);
    expect(advanced.launches[0]?.query).toBe('refined private query');
    state = recordAttemptFinished(
      dispatchLaunches(advanced.state, advanced.launches, deps),
      advanced.launches[0]?.attempt_id ?? '',
      { outcome: 'failed', error: providerFailure(true) },
      deps,
    );
    advanced = advanceCoordination(state, deps);
    expect(advanced.launches[0]?.query).toBe('refined private query');
    expect(prepared.request.query).toBe('original query');
    expect(advanced.state.original_query).toBe('original query');
  });
});

describe('acceptance, deadlines, cancellation, and budgets', () => {
  it('assigns separate inline and background attempt deadlines', () => {
    const start = Date.parse('2026-08-08T12:00:00Z');
    const deps = dependencies(start);
    const state = startAll(
      preparedExecution({
        primaries: [inlineProfile('inline'), durableProfile('durable')],
        inlineAttemptDeadlineMs: 10_000,
        backgroundAttemptDeadlineMs: 20_000,
      }),
      deps,
    );

    expect(state.attempts.map((attempt) => attempt.deadline_at)).toEqual([
      new Date(start + 10_000).toISOString(),
      new Date(start + 20_000).toISOString(),
    ]);
  });

  it('turns durable submission expiry into acceptance_unknown and halts all work', () => {
    const start = Date.parse('2026-08-08T12:00:00Z');
    const deps = dependencies(start);
    const prepared = preparedExecution({
      primaries: [durableProfile('durable'), inlineProfile('inline')],
      reserve: [{ profile: inlineProfile('reserve'), eligibleSlots: [0] }],
      maxConcurrency: 1,
      backgroundAttemptDeadlineMs: 10_000,
    });
    let state = startAll(prepared, deps);
    expect(state.attempts[0]?.status).toBe('submitting');
    deps.setNow(start + 10_000);
    const advanced = advanceCoordination(state, deps);
    state = advanced.state;

    expect(advanced.launches).toEqual([]);
    expect(state.attempts[0]).toMatchObject({
      status: 'acceptance_unknown',
    });
    expect(state.unresolved_acceptances).toEqual([
      expect.objectContaining({
        attempt_id: state.attempts[0]?.attempt_id,
        reason: 'submission_deadline_exceeded',
      }),
    ]);
    expect(state.slots[1]?.status).toBe('unstarted');
    expect(
      state.reserve.every((candidate) => !candidate.claimed_by_slot_id),
    ).toBe(true);
    expect(claimFallbackRound(state, deps).claims).toEqual([]);
    expect(state.used_profile_keys).toContain(
      profileIdentityKey(durableProfile('durable').identity),
    );
  });

  it('applies attempt deadlines before late completion or acceptance callbacks', () => {
    const start = Date.parse('2026-08-08T12:00:00Z');
    const inlineDeps = dependencies(start);
    let inline = startAll(
      preparedExecution({
        primaries: [inlineProfile('inline')],
        inlineAttemptDeadlineMs: 10_000,
      }),
      inlineDeps,
    );
    inlineDeps.setNow(start + 10_000);
    inline = recordAttemptFinished(
      inline,
      inline.attempts[0]?.attempt_id ?? '',
      { outcome: 'succeeded', result_id: 'late-result' },
      inlineDeps,
    );
    expect(inline.attempts[0]?.status).toBe('timed_out');
    expect(inline.slots[0]?.result_id).toBeUndefined();

    const durableDeps = dependencies(start);
    let durable = startAll(
      preparedExecution({
        primaries: [durableProfile('durable')],
        backgroundAttemptDeadlineMs: 10_000,
      }),
      durableDeps,
    );
    durableDeps.setNow(start + 10_000);
    durable = recordSubmissionAccepted(
      durable,
      durable.attempts[0]?.attempt_id ?? '',
      handle(durableProfile('durable'), 'pending'),
      durableDeps,
    );
    expect(durable.attempts[0]?.status).toBe('acceptance_unknown');
    expect(durable.attempts[0]?.durable_handle).toBeUndefined();
  });

  it('retains a timely target callback while advancing an overdue sibling', () => {
    const start = Date.parse('2026-08-08T12:00:00Z');
    const deps = dependencies(start);
    const durable = durableProfile('durable');
    let state = startAll(
      preparedExecution({
        primaries: [inlineProfile('inline'), durable],
        inlineAttemptDeadlineMs: 10_000,
        backgroundAttemptDeadlineMs: 20_000,
      }),
      deps,
    );
    const durableAttempt = state.attempts.find(
      (attempt) => attempt.profile.identity.provider_id === 'durable',
    );
    deps.setNow(start + 10_000);
    state = recordSubmissionAccepted(
      state,
      durableAttempt?.attempt_id ?? '',
      handle(durable, 'pending'),
      deps,
    );
    expect(state.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profile: expect.objectContaining({
            identity: expect.objectContaining({ provider_id: 'inline' }),
          }),
          status: 'timed_out',
        }),
        expect.objectContaining({
          profile: expect.objectContaining({
            identity: expect.objectContaining({ provider_id: 'durable' }),
          }),
          status: 'submitted',
        }),
      ]),
    );
  });

  it('terminalizes fallback-pending slots at the request deadline without overwriting settled failures', () => {
    const start = Date.parse('2026-08-08T12:00:00Z');
    const deps = dependencies(start);
    let state = startAll(
      preparedExecution({
        primaries: [inlineProfile('failed'), inlineProfile('active')],
        reserve: [{ profile: inlineProfile('reserve'), eligibleSlots: [1] }],
        requestDeadlineMs: 10_000,
      }),
      deps,
    );
    const failure = providerFailure(false, 'settled_failure');
    state = recordAttemptFinished(
      state,
      state.attempts[0]?.attempt_id ?? '',
      { outcome: 'failed', error: failure },
      deps,
    );
    state = recordAttemptFinished(
      state,
      state.attempts[1]?.attempt_id ?? '',
      { outcome: 'failed', error: providerFailure(true) },
      deps,
    );
    state = claimFallbackRound(state, deps).state;
    expect(state.slots[1]?.status).toBe('fallback_pending');

    deps.setNow(start + 10_000);
    state = advanceCoordination(state, deps).state;
    expect(state.status).toBe('unsuccessful');
    expect(state.slots[0]).toMatchObject({
      status: 'failed',
      error: { code: 'settled_failure' },
    });
    expect(state.slots[1]).toMatchObject({
      status: 'failed',
      error: { code: 'provider_failed' },
    });
    expect(mapCoordinatorOutcome(state)).toBe('unsuccessful');
  });

  it('times out inline work and launches an eligible fallback without acceptance uncertainty', () => {
    const start = Date.parse('2026-08-08T12:00:00Z');
    const deps = dependencies(start);
    const prepared = preparedExecution({
      primaries: [inlineProfile('inline-primary')],
      reserve: [
        { profile: inlineProfile('inline-reserve'), eligibleSlots: [0] },
      ],
      inlineAttemptDeadlineMs: 10_000,
    });
    const state = startAll(prepared, deps);
    expect(state.attempts[0]?.status).toBe('running');
    deps.setNow(start + 10_000);
    const advanced = advanceCoordination(state, deps);

    expect(advanced.state.attempts[0]).toMatchObject({
      status: 'timed_out',
      error: {
        code: 'attempt_deadline_exceeded',
        fallback_allowed: true,
      },
    });
    expect(advanced.state.unresolved_acceptances).toEqual([]);
    expect(advanced.launches).toHaveLength(1);
    expect(advanced.launches[0]?.profile.identity.provider_id).toBe(
      'inline-reserve',
    );
  });

  it('clamps a late fallback launch to the remaining request deadline', () => {
    const start = Date.parse('2026-08-08T12:00:00Z');
    const deps = dependencies(start);
    let state = startAll(
      preparedExecution({
        primaries: [inlineProfile('primary')],
        reserve: [{ profile: inlineProfile('reserve'), eligibleSlots: [0] }],
        inlineAttemptDeadlineMs: 10_000,
        requestDeadlineMs: 15_000,
      }),
      deps,
    );
    deps.setNow(start + 10_000);
    const advanced = advanceCoordination(state, deps);
    expect(advanced.launches).toHaveLength(1);
    expect(advanced.launches[0]?.deadline_at).toBe(
      new Date(start + 15_000).toISOString(),
    );
    state = dispatchLaunches(advanced.state, advanced.launches, deps);
    expect(state.attempts.at(-1)?.deadline_at).toBe(
      new Date(start + 15_000).toISOString(),
    );
  });

  it('starts process-local work as running and never permits acceptance uncertainty', () => {
    const deps = dependencies();
    const state = startAll(
      preparedExecution({ primaries: [processLocalProfile('local')] }),
      deps,
    );
    expect(state.attempts[0]?.status).toBe('running');
    expect(() =>
      recordAcceptanceUnknown(state, state.attempts[0]?.attempt_id ?? '', deps),
    ).toThrow('Only durable background profiles');
  });

  it('keeps remote uncertainty observable after request deadline and cancellation', () => {
    const start = Date.parse('2026-08-08T12:00:00Z');
    const deadlineDeps = dependencies(start);
    const prepared = preparedExecution({
      primaries: [durableProfile('durable')],
      reserve: [{ profile: inlineProfile('reserve'), eligibleSlots: [0] }],
      requestDeadlineMs: 20_000,
      backgroundAttemptDeadlineMs: 10_000,
    });
    let deadlineState = startAll(prepared, deadlineDeps);
    deadlineDeps.setNow(start + 20_000);
    deadlineState = advanceCoordination(deadlineState, deadlineDeps).state;
    expect(deadlineState.status).toBe('unsuccessful');
    expect(deadlineState.unresolved_acceptances).toEqual([
      expect.objectContaining({ reason: 'request_deadline_exceeded' }),
    ]);
    expect(deadlineState.lifecycle.at(-1)?.event_kind).toBe(
      'request_completed',
    );

    const cancelDeps = dependencies(start);
    let cancelled = startAll(prepared, cancelDeps);
    cancelled = recordAcceptanceUnknown(
      cancelled,
      cancelled.attempts[0]?.attempt_id ?? '',
      cancelDeps,
      'adapter-state-ref-1',
    );
    cancelled = cancelCoordination(cancelled, cancelDeps);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.unresolved_acceptances).toEqual([
      expect.objectContaining({
        reason: 'cancelled_while_acceptance_unknown',
        adapter_state_ref: 'adapter-state-ref-1',
      }),
    ]);
    expect(cancelled.attempts[0]).toMatchObject({
      status: 'cancelled',
      adapter_state_ref: 'adapter-state-ref-1',
    });
    expect(
      cancelled.reserve.every((candidate) => !candidate.claimed_by_slot_id),
    ).toBe(true);
  });

  it('keeps transient poll failures private and nonterminal', () => {
    const deps = dependencies();
    const profile = durableProfile('durable');
    let state = startAll(preparedExecution({ primaries: [profile] }), deps);
    state = recordSubmissionAccepted(
      state,
      state.attempts[0]?.attempt_id ?? '',
      handle(profile, 'pending'),
      deps,
    );
    const lifecycleLength = state.lifecycle.length;
    const pollError: StructuredError = {
      code: 'poll_temporarily_unavailable',
      message: 'The provider status endpoint was temporarily unavailable.',
      category: 'network',
      retryable: true,
      fallback_allowed: false,
    };
    state = recordTransientPollFailure(
      state,
      state.attempts[0]?.attempt_id ?? '',
      pollError,
      deps,
    );

    expect(state.attempts[0]).toMatchObject({
      status: 'submitted',
      transient_poll_error: pollError,
    });
    expect(state.lifecycle).toHaveLength(lifecycleLength);
    expect(state.status).toBe('running');
  });

  it('uses a zero ceiling to suppress paid slots while permitting zero reservations', () => {
    const deps = dependencies();
    const prepared = preparedExecution({
      primaries: [inlineProfile('free'), inlineProfile('paid')],
      estimates: { free: '0', paid: '1' },
      budgets: { max_estimated_cost_microusd: '0' },
    });
    const started = startLaunchableAttempts(
      createCoordinatorState(prepared, deps),
      deps,
    );

    expect(
      started.launches.map((launch) => launch.profile.identity.provider_id),
    ).toEqual(['free']);
    expect(started.state.slots[1]).toMatchObject({
      status: 'cancelled',
      error: {
        code: 'budget_reservation_exceeded',
        category: 'budget',
        fallback_allowed: false,
      },
    });
    expect(started.state.budget.reserved_estimated_cost_microusd).toBe('0');
  });

  it('treats the actual-cost ceiling as a projected hard launch budget', () => {
    const deps = dependencies();
    const started = startLaunchableAttempts(
      createCoordinatorState(
        preparedExecution({
          primaries: [inlineProfile('free'), inlineProfile('paid')],
          estimates: { free: '0', paid: '1' },
          budgets: { max_actual_cost_microusd: '0' },
        }),
        deps,
      ),
      deps,
    );
    expect(
      started.launches.map((launch) => launch.profile.identity.provider_id),
    ).toEqual(['free']);
    expect(started.state.slots[1]?.error?.code).toBe(
      'budget_reservation_exceeded',
    );

    const concurrent = startLaunchableAttempts(
      createCoordinatorState(
        preparedExecution({
          primaries: [inlineProfile('first'), inlineProfile('second')],
          estimates: { first: '6', second: '6' },
          budgets: { max_actual_cost_microusd: '10' },
        }),
        deps,
      ),
      deps,
    );
    expect(
      concurrent.launches.map((launch) => launch.profile.identity.provider_id),
    ).toEqual(['first']);
    expect(concurrent.state.slots[1]?.error?.code).toBe(
      'budget_reservation_exceeded',
    );
  });
});

describe('durable handles and terminal mapping', () => {
  it('validates handle identity/status and permits succeeded-handle retrieval failure', () => {
    const deps = dependencies();
    const profile = durableProfile('durable');
    let state = startAll(preparedExecution({ primaries: [profile] }), deps);
    const attemptId = state.attempts[0]?.attempt_id ?? '';

    expect(() =>
      recordSubmissionAccepted(
        state,
        attemptId,
        handle(profile, 'succeeded'),
        deps,
      ),
    ).toThrow('must be pending or running');
    state = recordSubmissionAccepted(
      state,
      attemptId,
      handle(profile, 'pending'),
      deps,
      'adapter-state-ref',
    );
    const wrongProfileHandle = handle(durableProfile('other'), 'failed');
    expect(() =>
      recordAttemptFinished(
        state,
        attemptId,
        {
          outcome: 'failed',
          error: providerFailure(false),
          durable_handle: wrongProfileHandle,
        },
        deps,
      ),
    ).toThrow('provider must match');
    const wrongTargetProfile = structuredClone(profile);
    wrongTargetProfile.identity.target.primary.target_id =
      'different-durable-target';
    expect(() =>
      recordAttemptFinished(
        state,
        attemptId,
        {
          outcome: 'failed',
          error: providerFailure(false),
          durable_handle: handle(wrongTargetProfile, 'failed'),
        },
        deps,
      ),
    ).toThrow('provider must match');

    const succeededHandle = handle(profile, 'succeeded');
    state = recordAttemptFinished(
      state,
      attemptId,
      {
        outcome: 'failed',
        error: providerFailure(false, 'retrieve_normalization_failed'),
        durable_handle: succeededHandle,
      },
      deps,
    );
    expect(state.attempts[0]).toMatchObject({
      status: 'failed',
      durable_handle: succeededHandle,
      error: { code: 'retrieve_normalization_failed' },
    });
  });

  it('preserves an accepted durable handle when sync execution is later cancelled', () => {
    const deps = dependencies();
    const profile = durableProfile('durable');
    let state = startAll(preparedExecution({ primaries: [profile] }), deps);
    const accepted = handle(profile, 'pending');
    state = recordSubmissionAccepted(
      state,
      state.attempts[0]?.attempt_id ?? '',
      accepted,
      deps,
      'adapter-state-ref',
    );
    state = cancelCoordination(state, deps);

    expect(state.status).toBe('cancelled');
    expect(state.attempts[0]?.durable_handle).toEqual(accepted);
    expect(acceptedDurableHandles(state)).toEqual([accepted]);
    expect(state.lifecycle.at(-1)?.event_kind).toBe('request_cancelled');
    expect(() => LifecycleTraceSchema.parse(state.lifecycle)).not.toThrow();
  });

  it('maps all success, partial success, settled no-success, cancellation, and infrastructure failure', () => {
    const settle = (outcomes: readonly ('succeeded' | 'failed')[]) => {
      const deps = dependencies();
      let state = startAll(
        preparedExecution({
          primaries: outcomes.map((_, index) => inlineProfile(`p-${index}`)),
        }),
        deps,
      );
      for (const [index, attempt] of [...state.attempts].entries()) {
        state = recordAttemptFinished(
          state,
          attempt.attempt_id,
          outcomes[index] === 'succeeded'
            ? { outcome: 'succeeded', result_id: `result-${index}` }
            : { outcome: 'failed', error: providerFailure(false) },
          deps,
        );
      }
      return { state, deps };
    };

    const all = settle(['succeeded', 'succeeded']);
    expect(mapCoordinatorOutcome(all.state)).toBe('succeeded');
    expect(finalizeCoordination(all.state, all.deps).status).toBe('succeeded');

    const partial = settle(['succeeded', 'failed']);
    expect(mapCoordinatorOutcome(partial.state)).toBe('partial');
    expect(finalizeCoordination(partial.state, partial.deps).status).toBe(
      'partial',
    );

    const none = settle(['failed', 'failed']);
    expect(mapCoordinatorOutcome(none.state)).toBe('unsuccessful');
    expect(finalizeCoordination(none.state, none.deps).status).toBe(
      'unsuccessful',
    );

    const cancelDeps = dependencies();
    const cancelled = cancelCoordination(
      startAll(
        preparedExecution({ primaries: [inlineProfile('cancelled')] }),
        cancelDeps,
      ),
      cancelDeps,
    );
    expect(mapCoordinatorOutcome(cancelled)).toBe('cancelled');

    const failureDeps = dependencies();
    const failed = failCoordination(
      startAll(
        preparedExecution({ primaries: [inlineProfile('infra')] }),
        failureDeps,
      ),
      internalFailure(),
      failureDeps,
    );
    expect(mapCoordinatorOutcome(failed)).toBe('failed');
  });

  it('rejects durable handles on inline and process-local attempts', () => {
    for (const profile of [
      inlineProfile('inline-only'),
      processLocalProfile('process-local'),
    ]) {
      const deps = dependencies();
      const state = startAll(preparedExecution({ primaries: [profile] }), deps);
      expect(() =>
        recordAttemptFinished(
          state,
          state.attempts[0]?.attempt_id ?? '',
          {
            outcome: 'succeeded',
            result_id: 'result-1',
            durable_handle: handle(profile, 'succeeded'),
          },
          deps,
        ),
      ).toThrow('durable background attempts');
    }
  });

  it('rejects durable success while the effective accepted handle is still pending', () => {
    const deps = dependencies();
    const profile = durableProfile('durable');
    let state = startAll(preparedExecution({ primaries: [profile] }), deps);
    const attemptId = state.attempts[0]?.attempt_id ?? '';
    state = recordSubmissionAccepted(
      state,
      attemptId,
      handle(profile, 'pending'),
      deps,
    );

    expect(() =>
      recordAttemptFinished(
        state,
        attemptId,
        { outcome: 'succeeded', result_id: 'result-1' },
        deps,
      ),
    ).toThrow('effective handle must be succeeded');
    expect(() =>
      recordAttemptFinished(
        state,
        attemptId,
        {
          outcome: 'succeeded',
          result_id: 'result-1',
          durable_handle: handle(profile, 'running'),
        },
        deps,
      ),
    ).toThrow('incoherent');

    const succeeded = recordAttemptFinished(
      state,
      attemptId,
      {
        outcome: 'succeeded',
        result_id: 'result-1',
        durable_handle: handle(profile, 'succeeded'),
      },
      deps,
    );
    expect(succeeded.attempts[0]).toMatchObject({
      status: 'succeeded',
      durable_handle: { status: 'succeeded' },
    });
  });

  it('rejects non-retryable transient poll failures', () => {
    const deps = dependencies();
    const profile = durableProfile('durable');
    let state = startAll(preparedExecution({ primaries: [profile] }), deps);
    state = recordSubmissionAccepted(
      state,
      state.attempts[0]?.attempt_id ?? '',
      handle(profile, 'pending'),
      deps,
    );
    expect(() =>
      recordTransientPollFailure(
        state,
        state.attempts[0]?.attempt_id ?? '',
        {
          code: 'poll_permanently_broken',
          message: 'The provider status endpoint rejected the handle.',
          category: 'provider',
          retryable: false,
          fallback_allowed: false,
        },
        deps,
      ),
    ).toThrow('retryable');
  });

  it('validates adapter payloads before persistence and resolves definitive rejection', () => {
    const deps = dependencies();
    const profile = durableProfile('durable');
    let state = startAll(
      preparedExecution({
        primaries: [profile],
        reserve: [{ profile: durableProfile('reserve'), eligibleSlots: [0] }],
      }),
      deps,
    );
    const attemptId = state.attempts[0]?.attempt_id ?? '';
    expect(() =>
      recordSubmissionAccepted(
        state,
        attemptId,
        { ...handle(profile, 'pending'), apiKey: 'must-not-persist' },
        deps,
      ),
    ).toThrow();
    expect(() =>
      recordAttemptFinished(
        state,
        attemptId,
        {
          outcome: 'failed',
          error: providerFailure(true),
          actual_cost_microusd: '9'.repeat(65),
        },
        deps,
      ),
    ).toThrow();

    state = recordAcceptanceUnknown(state, attemptId, deps, 'state-ref');
    state = recordAcceptanceRejected(
      state,
      attemptId,
      providerFailure(true, 'definitively_rejected'),
      deps,
    );
    expect(state.unresolved_acceptances).toEqual([]);
    expect(state.attempts[0]).toMatchObject({
      status: 'failed',
      error: { code: 'definitively_rejected' },
    });
    expect(advanceCoordination(state, deps).launches).toHaveLength(1);
  });

  it('applies the canonical 100k character bound to refined slot queries', () => {
    const deps = dependencies();
    const state = createCoordinatorState(
      preparedExecution({ primaries: [inlineProfile('bounded')] }),
      deps,
    );
    const maxQuery = 'q'.repeat(100_000);
    const refined = setRefinedSlotQuery(state, 'slot-0', `  ${maxQuery}  `);
    expect(refined.slots[0]?.refined_query).toHaveLength(100_000);
    expect(() => setRefinedSlotQuery(state, 'slot-0', `${maxQuery}q`)).toThrow(
      'cannot exceed 100000 characters',
    );
    expect(() => setRefinedSlotQuery(state, 'slot-0', '   ')).toThrow(
      'cannot be empty',
    );
  });

  it('rejects zero, negative, and non-integer compare-and-swap attempt budgets immediately', async () => {
    const deps = dependencies();
    const state = startAll(
      preparedExecution({ primaries: [inlineProfile('cas')] }),
      deps,
    );
    const store = new InMemoryCoordinationStateStore();
    await store.create(state);
    for (const invalid of [0, -1, 1.5]) {
      await expect(
        resumeCoordination(store, state.request_id, deps, invalid),
      ).rejects.toThrow('positive integer');
      await expect(
        updateCoordinationState(
          store,
          state.request_id,
          (current) => current,
          invalid,
        ),
      ).rejects.toThrow('positive integer');
    }
  });
});
