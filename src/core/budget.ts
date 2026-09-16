import type { MeteringEstimate, ProviderUsage } from '../types.js';

/** Every finite JavaScript number converted to microusd fits in this bound. */
export const MAX_REPORTED_COST_MICROUSD_DIGITS = 315;
/** A coordinator persists at most 256 reported attempt costs. */
export const MAX_AGGREGATE_COST_MICROUSD_DIGITS = 317;

function expandedNonNegativeDecimal(value: number): string {
  const [coefficient, exponentText] = value.toString().toLowerCase().split('e');
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [integer = '0', fraction = ''] = coefficient.split('.');
  const digits = `${integer}${fraction}`;
  const decimalPosition = integer.length + exponent;
  let whole: string;
  let remainder: string;
  if (decimalPosition <= 0) {
    whole = '0';
    remainder = `${'0'.repeat(-decimalPosition)}${digits}`;
  } else if (decimalPosition >= digits.length) {
    whole = `${digits}${'0'.repeat(decimalPosition - digits.length)}`;
    remainder = '';
  } else {
    whole = digits.slice(0, decimalPosition);
    remainder = digits.slice(decimalPosition);
  }
  whole = whole.replace(/^0+(?=\d)/, '');
  remainder = remainder.replace(/0+$/, '');
  return remainder ? `${whole}.${remainder}` : whole;
}

/** Canonical non-exponent USD decimal accepted by the terminal usage schema. */
export function decimalUsdFromNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Usage costs must be finite non-negative numbers.');
  }
  const fixed = value.toFixed(18).replace(/0+$/, '').replace(/\.$/, '');
  return /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(fixed)
    ? fixed
    : expandedNonNegativeDecimal(value);
}

export function costMicrousdFromUsd(
  value: number | undefined,
): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  const [whole, fraction = ''] = expandedNonNegativeDecimal(value).split('.');
  const microusdFraction = fraction.slice(0, 6).padEnd(6, '0');
  const roundsUp = /[1-9]/.test(fraction.slice(6));
  return (
    BigInt(whole) * 1_000_000n +
    BigInt(microusdFraction) +
    (roundsUp ? 1n : 0n)
  ).toString();
}

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
 * the moment it is about to launch. Providers whose estimate would put the
 * accumulated reservation over the ceiling are skipped before they ever run —
 * giving products pre-call budget reservation.
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
   * True when reserving this estimate would put the running total above the
   * configured ceiling. Estimates without a USD figure never overflow it.
   */
  wouldExceed(estimate: MeteringEstimate | undefined): boolean;
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
    wouldExceed(estimate) {
      const cost = estimate?.estimatedCostUsd;
      return (
        limit !== undefined &&
        typeof cost === 'number' &&
        Number.isFinite(cost) &&
        cost > 0 &&
        reserved + cost > limit
      );
    },
    exceeded() {
      return limit !== undefined && reserved >= limit;
    },
  };
}

/** Reason recorded on providers skipped because the estimated budget was reached. */
export const ESTIMATE_BUDGET_SKIP_REASON =
  'skipped: estimated cost budget reached';
