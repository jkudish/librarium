import type { CoordinatorState } from './coordinator.js';

export interface VersionedCoordinationState {
  readonly version: number;
  readonly state: CoordinatorState;
}

export type CoordinationCompareAndSwapResult =
  | {
      readonly ok: true;
      readonly value: VersionedCoordinationState;
    }
  | {
      readonly ok: false;
      readonly current: VersionedCoordinationState | undefined;
    };

export interface CoordinationStateStore {
  load(requestId: string): Promise<VersionedCoordinationState | undefined>;
  create(state: CoordinatorState): Promise<VersionedCoordinationState>;
  compareAndSwap(
    requestId: string,
    expectedVersion: number,
    state: CoordinatorState,
  ): Promise<CoordinationCompareAndSwapResult>;
}

function cloneState(state: CoordinatorState): CoordinatorState {
  return structuredClone(state);
}

export class InMemoryCoordinationStateStore implements CoordinationStateStore {
  readonly #states = new Map<string, VersionedCoordinationState>();

  async load(
    requestId: string,
  ): Promise<VersionedCoordinationState | undefined> {
    const value = this.#states.get(requestId);
    return value
      ? { version: value.version, state: cloneState(value.state) }
      : undefined;
  }

  async create(state: CoordinatorState): Promise<VersionedCoordinationState> {
    if (this.#states.has(state.request_id)) {
      throw new Error(`Coordination state already exists: ${state.request_id}`);
    }
    const stored = { version: 1, state: cloneState(state) };
    this.#states.set(state.request_id, stored);
    return { version: stored.version, state: cloneState(stored.state) };
  }

  async compareAndSwap(
    requestId: string,
    expectedVersion: number,
    state: CoordinatorState,
  ): Promise<CoordinationCompareAndSwapResult> {
    if (state.request_id !== requestId) {
      throw new Error('Coordination state request id cannot change.');
    }
    const current = this.#states.get(requestId);
    if (!current || current.version !== expectedVersion) {
      return {
        ok: false,
        current: current
          ? { version: current.version, state: cloneState(current.state) }
          : undefined,
      };
    }
    const stored = {
      version: current.version + 1,
      state: cloneState(state),
    };
    this.#states.set(requestId, stored);
    return {
      ok: true,
      value: { version: stored.version, state: cloneState(stored.state) },
    };
  }
}

export function assertCompareAndSwapAttemptBudget(maxAttempts: number): void {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(
      'The compare-and-swap attempt budget must be a positive integer.',
    );
  }
}

export async function updateCoordinationState(
  store: CoordinationStateStore,
  requestId: string,
  update: (state: CoordinatorState) => CoordinatorState | undefined,
  maxAttempts = 16,
): Promise<VersionedCoordinationState> {
  assertCompareAndSwapAttemptBudget(maxAttempts);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = await store.load(requestId);
    if (!current) {
      throw new Error(`Coordination state not found: ${requestId}`);
    }
    const next = update(current.state);
    if (!next) return current;
    const swapped = await store.compareAndSwap(
      requestId,
      current.version,
      next,
    );
    if (swapped.ok) return swapped.value;
  }
  throw new Error(
    `Coordination state update exceeded ${maxAttempts} compare-and-swap attempts.`,
  );
}
