import type { ProviderUsage } from '../types.js';

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
    typeof limitUsd === 'number' && limitUsd > 0 ? limitUsd : undefined;
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
