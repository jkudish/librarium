import type { MeteringEstimate, ProviderUsage } from '../types.js';

/**
 * Runtime spend circuit breaker for a dispatch.
 *
 * This is an HONEST budget, not an estimator. Only costs an API actually
 * reported (ProviderUsage.costUsd) count toward it: a provider that reports
 * nothing contributes 0, so the accumulated total is always a lower bound on
 * real spend. Deep-research async costs land at retrieval, long after dispatch
 * returns, and therefore cannot be pre-metered here.
 *
 * Pure and edge-safe: no I/O, no CLI dependencies, so it can live in core.
 */
export interface BudgetTracker {
  /** Budget ceiling in USD, or undefined when no limit is set. */
  readonly limitUsd: number | undefined;
  /** Accumulated API-reported cost so far, in USD. */
  readonly spentUsd: number;
  /**
   * Fold a provider's reported usage into the running total. Usage without a
   * reported costUsd contributes nothing. Returns the new accumulated total.
   */
  record(usage: ProviderUsage | undefined): number;
  /**
   * True once the accumulated reported cost has crossed the budget. Always
   * false when no limit is configured.
   */
  exceeded(): boolean;
}

/**
 * Create a budget tracker. A non-positive or undefined limit yields a tracker
 * that never trips (no circuit breaker), so callers can construct one
 * unconditionally and let `exceeded()` gate behavior.
 */
export function createBudgetTracker(
  limitUsd: number | undefined,
): BudgetTracker {
  const limit =
    typeof limitUsd === 'number' && Number.isFinite(limitUsd) && limitUsd > 0
      ? limitUsd
      : undefined;
  let spent = 0;

  return {
    get limitUsd() {
      return limit;
    },
    get spentUsd() {
      return spent;
    },
    record(usage) {
      const cost = usage?.costUsd;
      if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) {
        spent += cost;
      }
      return spent;
    },
    exceeded() {
      return limit !== undefined && spent >= limit;
    },
  };
}

/** Reason string recorded on providers skipped because the budget was reached. */
export const BUDGET_SKIP_REASON = 'skipped: cost budget reached';

/**
 * Pre-dispatch reservation circuit breaker for a dispatch.
 *
 * Unlike the reported budget (which folds in API-reported cost AFTER a provider
 * returns), this tracker RESERVES each provider's network-free estimated cost at
 * the moment it is about to launch. Once the accumulated reservation crosses the
 * ceiling, not-yet-started providers are skipped before they ever run — giving
 * products pre-call budget reservation.
 *
 * Honest, lower-bound semantics: a provider whose estimate has no USD figure
 * (plan-dependent credits, unmetered providers) reserves 0, so the reserved
 * total is a lower bound on estimated spend — never an inflated guess. Estimated
 * and reported budgets are independent and never reconcile into one number.
 */
export interface EstimateBudgetTracker {
  /** Reservation ceiling in USD, or undefined when no limit is set. */
  readonly limitUsd: number | undefined;
  /** Accumulated reserved estimated cost so far, in USD. */
  readonly reservedUsd: number;
  /**
   * Reserve a provider's estimated cost against the ceiling. Estimates without
   * a finite positive estimatedCostUsd reserve nothing. Returns the new total.
   */
  reserve(estimate: MeteringEstimate | undefined): number;
  /**
   * True once the accumulated reservation has crossed the ceiling. Always false
   * when no limit is configured.
   */
  exceeded(): boolean;
}

/**
 * Create an estimate-reservation tracker. A non-positive or undefined limit
 * yields a tracker that never trips, so callers can construct one
 * unconditionally and let `exceeded()` gate behavior.
 */
export function createEstimateBudgetTracker(
  limitUsd: number | undefined,
): EstimateBudgetTracker {
  const limit =
    typeof limitUsd === 'number' && Number.isFinite(limitUsd) && limitUsd > 0
      ? limitUsd
      : undefined;
  let reserved = 0;

  return {
    get limitUsd() {
      return limit;
    },
    get reservedUsd() {
      return reserved;
    },
    reserve(estimate) {
      const cost = estimate?.estimatedCostUsd;
      if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) {
        reserved += cost;
      }
      return reserved;
    },
    exceeded() {
      return limit !== undefined && reserved >= limit;
    },
  };
}

/** Reason recorded on providers skipped because the estimated budget was reached. */
export const ESTIMATE_BUDGET_SKIP_REASON =
  'skipped: estimated cost budget reached';
