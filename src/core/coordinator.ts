import type {
  DurableHandle,
  ExecutionProfile,
  StructuredError,
} from '../contracts/domain/index.js';
import type { LifecycleEvent } from '../contracts/interchange/lifecycle.js';
import { INTERCHANGE_VERSION } from '../contracts/interchange/request.js';
import {
  assertCompareAndSwapAttemptBudget,
  type CoordinationStateStore,
  type VersionedCoordinationState,
} from './coordinator-store.js';
import {
  type AdapterBindingIdentity,
  type PreparedResearchExecution,
  profileIdentityKey,
} from './execution-plan.js';
import { RESEARCH_REQUEST_LIMITS } from './research-request.js';

export type CoordinatorTerminalOutcome =
  | 'succeeded'
  | 'partial'
  | 'unsuccessful'
  | 'cancelled'
  | 'failed';

export type CoordinatorStatus = 'running' | CoordinatorTerminalOutcome;

export type CoordinatorAttemptStatus =
  | 'submitting'
  | 'acceptance_unknown'
  | 'submitted'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export type CoordinatorSlotStatus =
  | 'unstarted'
  | 'fallback_pending'
  | CoordinatorAttemptStatus;

export interface CoordinatorBudgetState {
  max_estimated_cost_microusd?: string;
  max_actual_cost_microusd?: string;
  reserved_estimated_cost_microusd: string;
  actual_cost_microusd: string;
}

export interface CoordinatorSlotState {
  slot_id: string;
  position: number;
  primary: ExecutionProfile;
  status: CoordinatorSlotStatus;
  deadline_at: string;
  refined_query?: string;
  latest_attempt_id?: string;
  result_id?: string;
  error?: StructuredError;
  fallback_exhausted: boolean;
}

export interface CoordinatorAttemptState {
  attempt_id: string;
  slot_id: string;
  attempt_number: number;
  round: number;
  profile: ExecutionProfile;
  status: CoordinatorAttemptStatus;
  query: string;
  started_at: string;
  deadline_at: string;
  finished_at?: string;
  replaces_attempt_id?: string;
  candidate_id?: string;
  adapter_state_ref?: string;
  durable_handle?: DurableHandle;
  transient_poll_error?: StructuredError;
  result_id?: string;
  error?: StructuredError;
  reserved_estimated_cost_microusd: string;
  actual_cost_microusd?: string;
}

export interface CoordinatorReserveCandidate {
  candidate_id: string;
  position: number;
  profile: ExecutionProfile;
  eligible_slot_ids: string[];
  claimed_by_slot_id?: string;
}

export interface PendingFallbackLaunch {
  attempt_id: string;
  slot_id: string;
  attempt_number: number;
  round: number;
  candidate_id: string;
  replaces_attempt_id: string;
}

export interface CoordinatorCancellation {
  requested_at: string;
  error?: StructuredError;
}

export interface UnresolvedAcceptance {
  attempt_id: string;
  profile_key: string;
  observed_at: string;
  reason:
    | 'submission_response_uncertain'
    | 'submission_deadline_exceeded'
    | 'request_deadline_exceeded'
    | 'cancelled_while_acceptance_unknown'
    | 'infrastructure_failure_while_acceptance_unknown';
  adapter_state_ref?: string;
}

export interface CoordinatorState {
  request_id: string;
  mode: 'sync' | 'async';
  original_query: string;
  status: CoordinatorStatus;
  created_at: string;
  request_deadline_at: string;
  inline_attempt_deadline_ms: number;
  background_attempt_deadline_ms: number;
  poll_interval_ms: number;
  max_concurrency: number;
  catalog_revision: string;
  catalog_digest: string;
  slots: CoordinatorSlotState[];
  attempts: CoordinatorAttemptState[];
  reserve: CoordinatorReserveCandidate[];
  pending_fallbacks: PendingFallbackLaunch[];
  claimed_candidate_ids: string[];
  used_profile_keys: string[];
  unresolved_acceptances: UnresolvedAcceptance[];
  profile_plans_by_identity: PreparedResearchExecution['profile_plans_by_identity'];
  budget: CoordinatorBudgetState;
  cancellation?: CoordinatorCancellation;
  infrastructure_error?: StructuredError;
  lifecycle_sequence: number;
  lifecycle: LifecycleEvent[];
}

export interface CoordinatorClock {
  now(): number;
}

export interface CoordinatorIdGenerator {
  next(scope: 'attempt' | 'event'): string;
}

export interface CoordinatorDependencies {
  readonly clock: CoordinatorClock;
  readonly ids: CoordinatorIdGenerator;
}

export interface AttemptLaunch {
  readonly attempt_id: string;
  readonly slot_id: string;
  readonly profile: ExecutionProfile;
  readonly binding: AdapterBindingIdentity;
  readonly query: string;
  readonly deadline_at: string;
}

export interface CoordinatorAdvanceResult {
  readonly state: CoordinatorState;
  readonly launches: readonly AttemptLaunch[];
}

export type AttemptFinishedInput =
  | {
      readonly outcome: 'succeeded';
      readonly result_id: string;
      readonly durable_handle?: DurableHandle;
      readonly actual_cost_microusd?: string;
    }
  | {
      readonly outcome: 'failed' | 'timed_out';
      readonly error: StructuredError;
      readonly durable_handle?: DurableHandle;
      readonly actual_cost_microusd?: string;
    }
  | {
      readonly outcome: 'cancelled';
      readonly error?: StructuredError;
      readonly durable_handle?: DurableHandle;
      readonly actual_cost_microusd?: string;
    };

const ACTIVE_ATTEMPT_STATUSES = new Set<CoordinatorAttemptStatus>([
  'submitting',
  'submitted',
  'running',
]);

const TERMINAL_ATTEMPT_STATUSES = new Set<CoordinatorAttemptStatus>([
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
]);

const TERMINAL_SLOT_STATUSES = new Set<CoordinatorSlotStatus>([
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
]);

function cloneState(state: CoordinatorState): CoordinatorState {
  return structuredClone(state);
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function exactAdd(left: string, right: string): string {
  return (BigInt(left) + BigInt(right)).toString();
}

function exactGreaterThan(left: string, right: string): boolean {
  return BigInt(left) > BigInt(right);
}

function appendLifecycle(state: CoordinatorState, event: LifecycleEvent): void {
  state.lifecycle.push(event);
  state.lifecycle_sequence += 1;
}

function eventBase(
  state: CoordinatorState,
  dependencies: CoordinatorDependencies,
  occurredAt: string,
) {
  return {
    interchange_version: INTERCHANGE_VERSION,
    message_type: 'lifecycle_event' as const,
    event_id: dependencies.ids.next('event'),
    request_id: state.request_id,
    sequence: state.lifecycle_sequence,
    occurred_at: occurredAt,
  };
}

function appendAttemptStarted(
  state: CoordinatorState,
  attempt: CoordinatorAttemptState,
  dependencies: CoordinatorDependencies,
): void {
  appendLifecycle(state, {
    ...eventBase(state, dependencies, attempt.started_at),
    slot_id: attempt.slot_id,
    attempt_id: attempt.attempt_id,
    event_kind: 'attempt_started',
    data: {
      provider: attempt.profile.identity,
      attempt_number: attempt.attempt_number,
    },
  });
}

function appendAttemptFinished(
  state: CoordinatorState,
  attempt: CoordinatorAttemptState,
  dependencies: CoordinatorDependencies,
): void {
  const base = {
    ...eventBase(
      state,
      dependencies,
      attempt.finished_at ?? iso(dependencies.clock.now()),
    ),
    slot_id: attempt.slot_id,
    attempt_id: attempt.attempt_id,
    event_kind: 'attempt_finished' as const,
  };
  if (attempt.status === 'succeeded') {
    appendLifecycle(state, { ...base, data: { outcome: 'succeeded' } });
  } else if (attempt.status === 'failed' || attempt.status === 'timed_out') {
    if (!attempt.error) {
      throw new Error('Failed and timed-out attempts require an error.');
    }
    appendLifecycle(state, {
      ...base,
      data: { outcome: attempt.status, error: attempt.error },
    });
  } else if (attempt.status === 'cancelled') {
    appendLifecycle(state, {
      ...base,
      data: { outcome: 'cancelled', error: attempt.error },
    });
  } else {
    throw new Error(`Attempt ${attempt.attempt_id} is not terminal.`);
  }
}

function budgetError(): StructuredError {
  return {
    code: 'budget_reservation_exceeded',
    message: 'The exact runtime budget does not permit this unstarted slot.',
    category: 'budget',
    retryable: false,
    fallback_allowed: false,
  };
}

function cancellationError(): StructuredError {
  return {
    code: 'request_cancelled',
    message: 'The request was cancelled by the caller.',
    category: 'cancelled',
    retryable: false,
    fallback_allowed: false,
  };
}

function attemptDeadlineError(): StructuredError {
  return {
    code: 'attempt_deadline_exceeded',
    message: 'The attempt exceeded its absolute deadline.',
    category: 'timeout',
    retryable: true,
    fallback_allowed: true,
  };
}

function requestDeadlineError(): StructuredError {
  return {
    code: 'request_deadline_exceeded',
    message: 'The request exceeded its absolute deadline.',
    category: 'timeout',
    retryable: false,
    fallback_allowed: false,
  };
}

function validateHandleProvider(
  attempt: CoordinatorAttemptState,
  handle: DurableHandle,
): void {
  if (
    profileIdentityKey(handle.provider) !==
    profileIdentityKey(attempt.profile.identity)
  ) {
    throw new Error('Durable handle provider must match the attempt profile.');
  }
}

function validateTerminalHandleStatus(
  outcome: AttemptFinishedInput['outcome'],
  handle: DurableHandle,
): void {
  const coherent =
    (outcome === 'succeeded' && handle.status === 'succeeded') ||
    (outcome === 'failed' &&
      (handle.status === 'failed' || handle.status === 'succeeded')) ||
    outcome === 'cancelled' ||
    outcome === 'timed_out';
  if (!coherent) {
    throw new Error(
      `Durable handle status ${handle.status} is incoherent with ${outcome}.`,
    );
  }
}

function rememberUnresolvedAcceptance(
  state: CoordinatorState,
  attempt: CoordinatorAttemptState,
  observedAt: string,
  reason: UnresolvedAcceptance['reason'],
): void {
  const existing = state.unresolved_acceptances.find(
    (entry) => entry.attempt_id === attempt.attempt_id,
  );
  const marker: UnresolvedAcceptance = {
    attempt_id: attempt.attempt_id,
    profile_key: profileIdentityKey(attempt.profile.identity),
    observed_at: observedAt,
    reason,
    adapter_state_ref: attempt.adapter_state_ref,
  };
  if (existing) Object.assign(existing, marker);
  else state.unresolved_acceptances.push(marker);
}

function profilePlanFor(state: CoordinatorState, profile: ExecutionProfile) {
  const key = profileIdentityKey(profile.identity);
  const plan = state.profile_plans_by_identity[key];
  if (!plan) {
    throw new Error(`Missing prepared profile plan for ${key}.`);
  }
  return plan;
}

function reservationFor(
  state: CoordinatorState,
  profile: ExecutionProfile,
): string {
  return (
    profilePlanFor(state, profile).estimate?.estimated_cost_microusd ?? '0'
  );
}

function budgetPermitsLaunch(
  state: CoordinatorState,
  reservation: string,
): boolean {
  const estimatedLimit = state.budget.max_estimated_cost_microusd;
  if (
    estimatedLimit !== undefined &&
    exactGreaterThan(
      exactAdd(state.budget.reserved_estimated_cost_microusd, reservation),
      estimatedLimit,
    )
  ) {
    return false;
  }
  const actualLimit = state.budget.max_actual_cost_microusd;
  return !(
    actualLimit !== undefined &&
    exactGreaterThan(state.budget.actual_cost_microusd, actualLimit)
  );
}

function availableConcurrency(state: CoordinatorState): number {
  const active = state.attempts.filter((attempt) =>
    ACTIVE_ATTEMPT_STATUSES.has(attempt.status),
  ).length;
  return Math.max(0, state.max_concurrency - active);
}

function hasAcceptanceUnknown(state: CoordinatorState): boolean {
  return state.attempts.some(
    (attempt) => attempt.status === 'acceptance_unknown',
  );
}

function canHaveRemoteAcceptanceUncertainty(
  profile: ExecutionProfile,
): boolean {
  return (
    profile.invocation === 'background' && profile.resumability === 'durable'
  );
}

function attemptFor(
  state: CoordinatorState,
  attemptId: string,
): CoordinatorAttemptState {
  const attempt = state.attempts.find(
    (candidate) => candidate.attempt_id === attemptId,
  );
  if (!attempt) throw new Error(`Unknown attempt: ${attemptId}`);
  return attempt;
}

function slotFor(
  state: CoordinatorState,
  slotId: string,
): CoordinatorSlotState {
  const slot = state.slots.find((candidate) => candidate.slot_id === slotId);
  if (!slot) throw new Error(`Unknown slot: ${slotId}`);
  return slot;
}

function latestAttempt(
  state: CoordinatorState,
  slot: CoordinatorSlotState,
): CoordinatorAttemptState | undefined {
  return slot.latest_attempt_id
    ? state.attempts.find(
        (attempt) => attempt.attempt_id === slot.latest_attempt_id,
      )
    : undefined;
}

function requestStartedEvent(
  state: CoordinatorState,
  dependencies: CoordinatorDependencies,
): LifecycleEvent {
  return {
    ...eventBase(state, dependencies, state.created_at),
    event_kind: 'request_started',
    data: { mode: state.mode },
  };
}

export function createCoordinatorState(
  prepared: PreparedResearchExecution,
  dependencies: CoordinatorDependencies,
): CoordinatorState {
  const createdAtMs = dependencies.clock.now();
  const createdAt = iso(createdAtMs);
  const requestDeadlineAt = iso(
    createdAtMs + prepared.policy.limits.request_deadline_ms,
  );
  const state: CoordinatorState = {
    request_id: prepared.request.request_id,
    mode: prepared.request.mode,
    original_query: prepared.request.query,
    status: 'running',
    created_at: createdAt,
    request_deadline_at: requestDeadlineAt,
    inline_attempt_deadline_ms:
      prepared.policy.limits.inline_attempt_deadline_ms,
    background_attempt_deadline_ms:
      prepared.policy.limits.background_attempt_deadline_ms,
    poll_interval_ms: prepared.policy.limits.poll_interval_ms,
    max_concurrency: prepared.policy.limits.max_concurrency,
    catalog_revision: prepared.catalog.revision,
    catalog_digest: prepared.catalog.digest,
    slots: prepared.request.slots.map((slot) => ({
      slot_id: slot.slot_id,
      position: slot.position,
      primary: slot.primary,
      status: 'unstarted',
      deadline_at: requestDeadlineAt,
      fallback_exhausted: false,
    })),
    attempts: [],
    reserve: prepared.request.fallback_reserve.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      position: candidate.position,
      profile: candidate.profile,
      eligible_slot_ids: [...candidate.eligible_slot_ids],
    })),
    pending_fallbacks: [],
    claimed_candidate_ids: [],
    used_profile_keys: [],
    unresolved_acceptances: [],
    profile_plans_by_identity: structuredClone(
      prepared.profile_plans_by_identity,
    ),
    budget: {
      max_estimated_cost_microusd:
        prepared.policy.budgets?.max_estimated_cost_microusd,
      max_actual_cost_microusd:
        prepared.policy.budgets?.max_actual_cost_microusd,
      reserved_estimated_cost_microusd: '0',
      actual_cost_microusd: '0',
    },
    lifecycle_sequence: 0,
    lifecycle: [],
  };
  appendLifecycle(state, requestStartedEvent(state, dependencies));
  return state;
}

export function setRefinedSlotQuery(
  state: CoordinatorState,
  slotId: string,
  query: string,
): CoordinatorState {
  const next = cloneState(state);
  const slot = slotFor(next, slotId);
  if (slot.latest_attempt_id || slot.status !== 'unstarted') {
    throw new Error('A refined query must be set before the slot starts.');
  }
  const normalized = query.trim();
  if (normalized.length === 0) {
    throw new Error('A refined query cannot be empty.');
  }
  if (normalized.length > RESEARCH_REQUEST_LIMITS.queryLength) {
    throw new Error(
      `A refined query cannot exceed ${RESEARCH_REQUEST_LIMITS.queryLength} characters.`,
    );
  }
  slot.refined_query = normalized;
  return next;
}

function suppressSlotForBudget(
  state: CoordinatorState,
  slot: CoordinatorSlotState,
): void {
  const error = budgetError();
  slot.status = 'cancelled';
  slot.error = error;
  slot.fallback_exhausted = true;
  state.pending_fallbacks = state.pending_fallbacks.filter(
    (pending) => pending.slot_id !== slot.slot_id,
  );
}

function startAttempt(
  state: CoordinatorState,
  slot: CoordinatorSlotState,
  attempt: Omit<
    CoordinatorAttemptState,
    | 'status'
    | 'query'
    | 'started_at'
    | 'deadline_at'
    | 'reserved_estimated_cost_microusd'
  >,
  dependencies: CoordinatorDependencies,
): AttemptLaunch | undefined {
  const reservation = reservationFor(state, attempt.profile);
  if (!budgetPermitsLaunch(state, reservation)) {
    suppressSlotForBudget(state, slot);
    return undefined;
  }

  const startedAtMs = dependencies.clock.now();
  const requestDeadlineMs = Date.parse(state.request_deadline_at);
  const attemptDeadlineMs =
    attempt.profile.invocation === 'inline'
      ? state.inline_attempt_deadline_ms
      : state.background_attempt_deadline_ms;
  const started: CoordinatorAttemptState = {
    ...attempt,
    status: canHaveRemoteAcceptanceUncertainty(attempt.profile)
      ? 'submitting'
      : 'running',
    query: slot.refined_query ?? state.original_query,
    started_at: iso(startedAtMs),
    deadline_at: iso(
      Math.min(startedAtMs + attemptDeadlineMs, requestDeadlineMs),
    ),
    reserved_estimated_cost_microusd: reservation,
  };
  state.attempts.push(started);
  slot.status = started.status;
  slot.latest_attempt_id = started.attempt_id;
  slot.error = undefined;
  slot.result_id = undefined;
  const key = profileIdentityKey(started.profile.identity);
  if (!state.used_profile_keys.includes(key)) state.used_profile_keys.push(key);
  state.budget.reserved_estimated_cost_microusd = exactAdd(
    state.budget.reserved_estimated_cost_microusd,
    reservation,
  );
  appendAttemptStarted(state, started, dependencies);
  return {
    attempt_id: started.attempt_id,
    slot_id: started.slot_id,
    profile: started.profile,
    binding: profilePlanFor(state, started.profile).binding,
    query: started.query,
    deadline_at: started.deadline_at,
  };
}

export function startLaunchableAttempts(
  state: CoordinatorState,
  dependencies: CoordinatorDependencies,
): CoordinatorAdvanceResult {
  if (
    state.status !== 'running' ||
    state.cancellation ||
    hasAcceptanceUnknown(state)
  ) {
    return { state, launches: [] };
  }

  const next = cloneState(state);
  let changed = false;
  let capacity = availableConcurrency(next);
  if (capacity === 0) return { state, launches: [] };
  const launches: AttemptLaunch[] = [];

  const pending = [...next.pending_fallbacks].sort(
    (left, right) =>
      slotFor(next, left.slot_id).position -
      slotFor(next, right.slot_id).position,
  );
  for (const fallback of pending) {
    if (capacity === 0) break;
    const slot = slotFor(next, fallback.slot_id);
    const candidate = next.reserve.find(
      (entry) => entry.candidate_id === fallback.candidate_id,
    );
    if (!candidate) {
      throw new Error(`Missing fallback candidate ${fallback.candidate_id}.`);
    }
    next.pending_fallbacks = next.pending_fallbacks.filter(
      (entry) => entry.attempt_id !== fallback.attempt_id,
    );
    changed = true;
    const launch = startAttempt(
      next,
      slot,
      {
        attempt_id: fallback.attempt_id,
        slot_id: fallback.slot_id,
        attempt_number: fallback.attempt_number,
        round: fallback.round,
        profile: candidate.profile,
        replaces_attempt_id: fallback.replaces_attempt_id,
        candidate_id: fallback.candidate_id,
      },
      dependencies,
    );
    if (launch) {
      launches.push(launch);
      capacity -= 1;
    }
  }

  if (next.pending_fallbacks.length > 0 || capacity === 0) {
    return { state: next, launches };
  }

  for (const slot of [...next.slots].sort(
    (left, right) => left.position - right.position,
  )) {
    if (capacity === 0) break;
    if (slot.status !== 'unstarted') continue;
    changed = true;
    const launch = startAttempt(
      next,
      slot,
      {
        attempt_id: dependencies.ids.next('attempt'),
        slot_id: slot.slot_id,
        attempt_number: 1,
        round: 0,
        profile: slot.primary,
      },
      dependencies,
    );
    if (launch) {
      launches.push(launch);
      capacity -= 1;
    }
  }
  return { state: changed ? next : state, launches };
}

export function recordSubmissionAccepted(
  state: CoordinatorState,
  attemptId: string,
  handle: DurableHandle,
  dependencies: CoordinatorDependencies,
  adapterStateRef?: string,
): CoordinatorState {
  const next = cloneState(state);
  const attempt = attemptFor(next, attemptId);
  if (!canHaveRemoteAcceptanceUncertainty(attempt.profile)) {
    throw new Error('Only durable background profiles can be submitted.');
  }
  if (
    attempt.status !== 'submitting' &&
    attempt.status !== 'acceptance_unknown'
  ) {
    throw new Error(
      'Only a submitting or acceptance-unknown attempt can be accepted.',
    );
  }
  validateHandleProvider(attempt, handle);
  if (handle.status !== 'pending' && handle.status !== 'running') {
    throw new Error(
      'A newly accepted durable handle must be pending or running.',
    );
  }
  attempt.status = 'submitted';
  attempt.durable_handle = handle;
  attempt.adapter_state_ref = adapterStateRef ?? attempt.adapter_state_ref;
  attempt.transient_poll_error = undefined;
  next.unresolved_acceptances = next.unresolved_acceptances.filter(
    (entry) => entry.attempt_id !== attempt.attempt_id,
  );
  slotFor(next, attempt.slot_id).status = 'submitted';
  appendLifecycle(next, {
    ...eventBase(next, dependencies, iso(dependencies.clock.now())),
    slot_id: attempt.slot_id,
    attempt_id: attempt.attempt_id,
    event_kind: 'durable_task_submitted',
    data: { handle },
  });
  return next;
}

export function recordAttemptRunning(
  state: CoordinatorState,
  attemptId: string,
): CoordinatorState {
  const next = cloneState(state);
  const attempt = attemptFor(next, attemptId);
  if (!canHaveRemoteAcceptanceUncertainty(attempt.profile)) {
    throw new Error(
      'Only durable background submissions can transition from submitted to running.',
    );
  }
  if (attempt.status !== 'submitted') {
    throw new Error('Only a submitted attempt can transition to running.');
  }
  attempt.status = 'running';
  attempt.transient_poll_error = undefined;
  slotFor(next, attempt.slot_id).status = 'running';
  return next;
}

export function recordAcceptanceUnknown(
  state: CoordinatorState,
  attemptId: string,
  dependencies: CoordinatorDependencies,
  adapterStateRef?: string,
  reason: UnresolvedAcceptance['reason'] = 'submission_response_uncertain',
): CoordinatorState {
  const next = cloneState(state);
  const attempt = attemptFor(next, attemptId);
  if (!canHaveRemoteAcceptanceUncertainty(attempt.profile)) {
    throw new Error(
      'Only durable background profiles can have unknown acceptance.',
    );
  }
  if (attempt.status !== 'submitting') {
    throw new Error('Only a submitting attempt can become acceptance-unknown.');
  }
  attempt.status = 'acceptance_unknown';
  attempt.adapter_state_ref = adapterStateRef;
  slotFor(next, attempt.slot_id).status = 'acceptance_unknown';
  rememberUnresolvedAcceptance(
    next,
    attempt,
    iso(dependencies.clock.now()),
    reason,
  );
  return next;
}

export function recordTransientPollFailure(
  state: CoordinatorState,
  attemptId: string,
  error: StructuredError,
): CoordinatorState {
  const next = cloneState(state);
  const attempt = attemptFor(next, attemptId);
  if (!canHaveRemoteAcceptanceUncertainty(attempt.profile)) {
    throw new Error('Transient poll failures require durable background work.');
  }
  if (attempt.status !== 'submitted' && attempt.status !== 'running') {
    throw new Error('Transient poll failures require an accepted attempt.');
  }
  if (!error.retryable) {
    throw new Error('Transient poll failures must carry a retryable error.');
  }
  attempt.transient_poll_error = error;
  return next;
}

export function recordAttemptFinished(
  state: CoordinatorState,
  attemptId: string,
  input: AttemptFinishedInput,
  dependencies: CoordinatorDependencies,
): CoordinatorState {
  const next = cloneState(state);
  const attempt = attemptFor(next, attemptId);
  if (
    TERMINAL_ATTEMPT_STATUSES.has(attempt.status) ||
    attempt.status === 'acceptance_unknown'
  ) {
    throw new Error('The attempt cannot transition to a terminal outcome.');
  }
  if (input.durable_handle) {
    if (!canHaveRemoteAcceptanceUncertainty(attempt.profile)) {
      throw new Error(
        'Durable handles are permitted only on durable background attempts.',
      );
    }
    validateHandleProvider(attempt, input.durable_handle);
    validateTerminalHandleStatus(input.outcome, input.durable_handle);
  }
  const effectiveHandle = input.durable_handle ?? attempt.durable_handle;
  if (
    input.outcome === 'succeeded' &&
    effectiveHandle &&
    effectiveHandle.status !== 'succeeded'
  ) {
    throw new Error(
      `A succeeded durable attempt cannot retain a ${effectiveHandle.status} handle; the effective handle must be succeeded.`,
    );
  }
  attempt.status = input.outcome;
  attempt.finished_at = iso(dependencies.clock.now());
  attempt.durable_handle = input.durable_handle ?? attempt.durable_handle;
  attempt.transient_poll_error = undefined;
  attempt.actual_cost_microusd = input.actual_cost_microusd;
  if (input.actual_cost_microusd !== undefined) {
    if (!/^(?:0|[1-9]\d*)$/.test(input.actual_cost_microusd)) {
      throw new Error(
        'Actual cost must be an exact non-negative integer string.',
      );
    }
    next.budget.actual_cost_microusd = exactAdd(
      next.budget.actual_cost_microusd,
      input.actual_cost_microusd,
    );
  }
  const slot = slotFor(next, attempt.slot_id);
  slot.status = input.outcome;
  slot.error = 'error' in input ? input.error : undefined;
  if (input.outcome === 'succeeded') {
    attempt.result_id = input.result_id;
    slot.result_id = input.result_id;
  } else if (input.outcome === 'failed' || input.outcome === 'timed_out') {
    attempt.error = input.error;
  } else {
    attempt.error = input.error;
    slot.fallback_exhausted = true;
  }
  appendAttemptFinished(next, attempt, dependencies);
  return next;
}

export interface FallbackRoundResult {
  readonly state: CoordinatorState;
  readonly claims: readonly PendingFallbackLaunch[];
}

export function claimFallbackRound(
  state: CoordinatorState,
  dependencies: CoordinatorDependencies,
): FallbackRoundResult {
  if (
    state.status !== 'running' ||
    state.cancellation ||
    hasAcceptanceUnknown(state) ||
    state.pending_fallbacks.length > 0 ||
    state.slots.some((slot) => slot.status === 'unstarted') ||
    state.attempts.some((attempt) =>
      ACTIVE_ATTEMPT_STATUSES.has(attempt.status),
    )
  ) {
    return { state, claims: [] };
  }

  const next = cloneState(state);
  const currentRound = Math.max(
    -1,
    ...next.attempts.map((attempt) => attempt.round),
  );
  const failedSlots = next.slots
    .filter((slot) => {
      const attempt = latestAttempt(next, slot);
      return (
        !slot.fallback_exhausted &&
        attempt?.round === currentRound &&
        (attempt.status === 'failed' || attempt.status === 'timed_out') &&
        attempt.error?.fallback_allowed === true
      );
    })
    .sort((left, right) => left.position - right.position);
  if (failedSlots.length === 0) return { state, claims: [] };
  const claims: PendingFallbackLaunch[] = [];

  for (const slot of failedSlots) {
    const replaced = latestAttempt(next, slot);
    if (!replaced) continue;
    const candidate = [...next.reserve]
      .sort((left, right) => left.position - right.position)
      .find(
        (entry) =>
          entry.claimed_by_slot_id === undefined &&
          entry.eligible_slot_ids.includes(slot.slot_id) &&
          !next.used_profile_keys.includes(
            profileIdentityKey(entry.profile.identity),
          ),
      );
    if (!candidate) {
      slot.fallback_exhausted = true;
      continue;
    }

    const pending: PendingFallbackLaunch = {
      attempt_id: dependencies.ids.next('attempt'),
      slot_id: slot.slot_id,
      attempt_number: replaced.attempt_number + 1,
      round: currentRound + 1,
      candidate_id: candidate.candidate_id,
      replaces_attempt_id: replaced.attempt_id,
    };
    candidate.claimed_by_slot_id = slot.slot_id;
    next.claimed_candidate_ids.push(candidate.candidate_id);
    next.used_profile_keys.push(profileIdentityKey(candidate.profile.identity));
    next.pending_fallbacks.push(pending);
    slot.status = 'fallback_pending';
    appendLifecycle(next, {
      ...eventBase(next, dependencies, iso(dependencies.clock.now())),
      slot_id: slot.slot_id,
      attempt_id: pending.attempt_id,
      event_kind: 'fallback_selected',
      data: {
        failed_attempt_id: replaced.attempt_id,
        replacement_attempt_id: pending.attempt_id,
        candidate_id: pending.candidate_id,
      },
    });
    claims.push(pending);
  }
  return { state: next, claims };
}

export function cancelCoordination(
  state: CoordinatorState,
  dependencies: CoordinatorDependencies,
  error: StructuredError = cancellationError(),
): CoordinatorState {
  if (state.status !== 'running') return state;
  const next = cloneState(state);
  const cancelledAt = iso(dependencies.clock.now());
  next.cancellation = { requested_at: cancelledAt, error };

  for (const attempt of next.attempts) {
    if (TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) continue;
    if (
      canHaveRemoteAcceptanceUncertainty(attempt.profile) &&
      (attempt.status === 'submitting' ||
        attempt.status === 'acceptance_unknown')
    ) {
      rememberUnresolvedAcceptance(
        next,
        attempt,
        cancelledAt,
        'cancelled_while_acceptance_unknown',
      );
    }
    attempt.status = 'cancelled';
    attempt.finished_at = cancelledAt;
    attempt.error = error;
    appendAttemptFinished(next, attempt, dependencies);
  }
  for (const slot of next.slots) {
    if (slot.status === 'succeeded') continue;
    slot.status = 'cancelled';
    slot.error = error;
    slot.fallback_exhausted = true;
  }
  next.pending_fallbacks = [];
  next.status = 'cancelled';
  appendLifecycle(next, {
    ...eventBase(next, dependencies, cancelledAt),
    event_kind: 'request_cancelled',
    data: { error },
  });
  return next;
}

export function failCoordination(
  state: CoordinatorState,
  error: StructuredError,
  dependencies: CoordinatorDependencies,
): CoordinatorState {
  if (state.status !== 'running') return state;
  const next = cloneState(state);
  const failedAt = iso(dependencies.clock.now());
  next.infrastructure_error = error;
  for (const attempt of next.attempts) {
    if (TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) continue;
    if (
      canHaveRemoteAcceptanceUncertainty(attempt.profile) &&
      (attempt.status === 'submitting' ||
        attempt.status === 'acceptance_unknown')
    ) {
      rememberUnresolvedAcceptance(
        next,
        attempt,
        failedAt,
        'infrastructure_failure_while_acceptance_unknown',
      );
    }
    attempt.status = 'failed';
    attempt.finished_at = failedAt;
    attempt.error = error;
    appendAttemptFinished(next, attempt, dependencies);
  }
  for (const slot of next.slots) {
    if (slot.status === 'succeeded') continue;
    slot.status = 'failed';
    slot.error = error;
    slot.fallback_exhausted = true;
  }
  next.pending_fallbacks = [];
  next.status = 'failed';
  appendLifecycle(next, {
    ...eventBase(next, dependencies, failedAt),
    event_kind: 'request_failed',
    data: { error },
  });
  return next;
}

export function mapCoordinatorOutcome(
  state: CoordinatorState,
): CoordinatorTerminalOutcome | undefined {
  if (state.cancellation || state.status === 'cancelled') return 'cancelled';
  if (state.infrastructure_error || state.status === 'failed') return 'failed';
  if (state.slots.some((slot) => !TERMINAL_SLOT_STATUSES.has(slot.status))) {
    return undefined;
  }
  const succeeded = state.slots.filter(
    (slot) => slot.status === 'succeeded',
  ).length;
  if (succeeded === state.slots.length) return 'succeeded';
  if (succeeded > 0) return 'partial';
  return 'unsuccessful';
}

/**
 * Applies absolute request and attempt deadlines inside the reducer. Submission
 * expiry becomes acceptance uncertainty because a lost submit response cannot
 * prove the provider rejected the work. Request expiry ends local execution,
 * prohibits fallback, and retains an unresolved marker for such attempts.
 */
export function advanceDeadlines(
  state: CoordinatorState,
  dependencies: CoordinatorDependencies,
): CoordinatorState {
  if (state.status !== 'running') return state;
  const nowMs = dependencies.clock.now();
  const now = iso(nowMs);

  if (nowMs >= Date.parse(state.request_deadline_at)) {
    const next = cloneState(state);
    const error = requestDeadlineError();
    for (const attempt of next.attempts) {
      if (TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) continue;
      if (
        canHaveRemoteAcceptanceUncertainty(attempt.profile) &&
        (attempt.status === 'submitting' ||
          attempt.status === 'acceptance_unknown')
      ) {
        rememberUnresolvedAcceptance(
          next,
          attempt,
          now,
          'request_deadline_exceeded',
        );
      }
      attempt.status = 'timed_out';
      attempt.finished_at = now;
      attempt.error = error;
      attempt.transient_poll_error = undefined;
      const slot = slotFor(next, attempt.slot_id);
      slot.status = 'timed_out';
      slot.error = error;
      slot.fallback_exhausted = true;
      appendAttemptFinished(next, attempt, dependencies);
    }
    for (const slot of next.slots) {
      if (slot.status === 'succeeded') continue;
      if (!slot.latest_attempt_id) slot.status = 'cancelled';
      slot.error = error;
      slot.fallback_exhausted = true;
    }
    next.pending_fallbacks = [];
    const succeeded = next.slots.filter(
      (slot) => slot.status === 'succeeded',
    ).length;
    const outcome: Exclude<CoordinatorTerminalOutcome, 'cancelled' | 'failed'> =
      succeeded === next.slots.length
        ? 'succeeded'
        : succeeded > 0
          ? 'partial'
          : 'unsuccessful';
    next.status = outcome;
    appendLifecycle(next, {
      ...eventBase(next, dependencies, now),
      event_kind: 'request_completed',
      data: { outcome },
    });
    return next;
  }

  let next = state;
  for (const current of state.attempts) {
    if (
      nowMs < Date.parse(current.deadline_at) ||
      TERMINAL_ATTEMPT_STATUSES.has(current.status) ||
      current.status === 'acceptance_unknown'
    ) {
      continue;
    }
    if (current.status === 'submitting') {
      next = recordAcceptanceUnknown(
        next,
        current.attempt_id,
        dependencies,
        current.adapter_state_ref,
        'submission_deadline_exceeded',
      );
    } else {
      next = recordAttemptFinished(
        next,
        current.attempt_id,
        { outcome: 'timed_out', error: attemptDeadlineError() },
        dependencies,
      );
    }
  }
  return next;
}

function hasFallbackOpportunity(state: CoordinatorState): boolean {
  return state.slots.some((slot) => {
    const attempt = latestAttempt(state, slot);
    if (
      slot.fallback_exhausted ||
      !attempt ||
      (attempt.status !== 'failed' && attempt.status !== 'timed_out') ||
      attempt.error?.fallback_allowed !== true
    ) {
      return false;
    }
    return state.reserve.some(
      (candidate) =>
        candidate.claimed_by_slot_id === undefined &&
        candidate.eligible_slot_ids.includes(slot.slot_id) &&
        !state.used_profile_keys.includes(
          profileIdentityKey(candidate.profile.identity),
        ),
    );
  });
}

export function finalizeCoordination(
  state: CoordinatorState,
  dependencies: CoordinatorDependencies,
): CoordinatorState {
  if (state.status !== 'running') return state;
  if (
    hasAcceptanceUnknown(state) ||
    state.pending_fallbacks.length > 0 ||
    state.attempts.some((attempt) =>
      ACTIVE_ATTEMPT_STATUSES.has(attempt.status),
    ) ||
    state.slots.some((slot) => slot.status === 'unstarted') ||
    hasFallbackOpportunity(state)
  ) {
    return state;
  }
  const outcome = mapCoordinatorOutcome(state);
  if (!outcome || outcome === 'cancelled' || outcome === 'failed') return state;
  const next = cloneState(state);
  next.status = outcome;
  appendLifecycle(next, {
    ...eventBase(next, dependencies, iso(dependencies.clock.now())),
    event_kind: 'request_completed',
    data: { outcome },
  });
  return next;
}

export function advanceCoordination(
  state: CoordinatorState,
  dependencies: CoordinatorDependencies,
): CoordinatorAdvanceResult {
  let next = advanceDeadlines(state, dependencies);
  if (next.status !== 'running') return { state: next, launches: [] };
  if (
    next.status === 'running' &&
    !hasAcceptanceUnknown(next) &&
    next.pending_fallbacks.length === 0 &&
    next.slots.every((slot) => slot.status !== 'unstarted') &&
    !next.attempts.some((attempt) =>
      ACTIVE_ATTEMPT_STATUSES.has(attempt.status),
    )
  ) {
    next = claimFallbackRound(next, dependencies).state;
  }
  const started = startLaunchableAttempts(next, dependencies);
  if (started.launches.length > 0) return started;
  return {
    state: finalizeCoordination(started.state, dependencies),
    launches: [],
  };
}

export async function resumeCoordination(
  store: CoordinationStateStore,
  requestId: string,
  dependencies: CoordinatorDependencies,
  maxAttempts = 16,
): Promise<
  VersionedCoordinationState & { readonly launches: readonly AttemptLaunch[] }
> {
  assertCompareAndSwapAttemptBudget(maxAttempts);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = await store.load(requestId);
    if (!current) {
      throw new Error(`Coordination state not found: ${requestId}`);
    }
    const advanced = advanceCoordination(current.state, dependencies);
    if (advanced.state === current.state) {
      return { ...current, launches: advanced.launches };
    }
    const swapped = await store.compareAndSwap(
      requestId,
      current.version,
      advanced.state,
    );
    if (swapped.ok) {
      return { ...swapped.value, launches: advanced.launches };
    }
  }
  throw new Error(
    `Coordination resume exceeded ${maxAttempts} compare-and-swap attempts.`,
  );
}

export function acceptedDurableHandles(
  state: CoordinatorState,
): readonly DurableHandle[] {
  return state.attempts.flatMap((attempt) =>
    attempt.durable_handle ? [structuredClone(attempt.durable_handle)] : [],
  );
}
