import { describe, expect, it } from 'vitest';
import {
  BUDGET_SKIP_REASON,
  costMicrousdFromUsd,
  createBudgetTracker,
  decimalUsdFromNumber,
  reportedCostMicrousd,
} from '../src/core/budget.js';

describe('reported cost decimals', () => {
  it.each([
    // toFixed(18) expanded this to 0.741840000000000055.
    [0.74184, '0.74184'],
    [0.07675503499999999, '0.07675503499999999'],
    [12345.6789012345, '12345.6789012345'],
    [1e-7, '0.0000001'],
    [12, '12'],
    // Beyond 18 fractional digits rounds up, never down to zero.
    [5e-324, '0.000000000000000001'],
  ])('writes %d as %s', (value, decimal) => {
    expect(decimalUsdFromNumber(value)).toBe(decimal);
  });

  it('rounds microusd up and prefers the exact provider decimal', () => {
    expect(costMicrousdFromUsd(0.74184)).toBe('741840');
    expect(costMicrousdFromUsd(0.0000011)).toBe('2');
    expect(
      reportedCostMicrousd({ costUsd: 0.1, costUsdDecimal: '0.1000001' }),
    ).toBe('100001');
  });
});

describe('createBudgetTracker', () => {
  it('never trips when no limit is set', () => {
    const tracker = createBudgetTracker(undefined);
    tracker.record({ costUsd: 100 });
    expect(tracker.limitUsd).toBeUndefined();
    expect(tracker.spentUsd).toBe(100);
    expect(tracker.exceeded()).toBe(false);
  });

  it('treats a non-positive limit as no limit', () => {
    expect(createBudgetTracker(0).limitUsd).toBeUndefined();
    expect(createBudgetTracker(-5).limitUsd).toBeUndefined();
    const tracker = createBudgetTracker(0);
    tracker.record({ costUsd: 10 });
    expect(tracker.exceeded()).toBe(false);
  });

  it('accumulates only API-reported costUsd, ignoring tokens-only usage', () => {
    const tracker = createBudgetTracker(1);
    tracker.record({ totalTokens: 100000 });
    tracker.record({ inputTokens: 5, outputTokens: 5 });
    expect(tracker.spentUsd).toBe(0);
    expect(tracker.exceeded()).toBe(false);
  });

  it('counts undefined usage as zero', () => {
    const tracker = createBudgetTracker(1);
    tracker.record(undefined);
    expect(tracker.spentUsd).toBe(0);
    expect(tracker.exceeded()).toBe(false);
  });

  it('trips once accumulated cost reaches the budget (inclusive)', () => {
    const tracker = createBudgetTracker(0.5);
    tracker.record({ costUsd: 0.2 });
    expect(tracker.exceeded()).toBe(false);
    tracker.record({ costUsd: 0.3 });
    expect(tracker.spentUsd).toBeCloseTo(0.5);
    expect(tracker.exceeded()).toBe(true);
  });

  it('ignores negative or non-finite reported costs', () => {
    const tracker = createBudgetTracker(1);
    tracker.record({ costUsd: -3 });
    tracker.record({ costUsd: Number.NaN });
    tracker.record({ costUsd: Number.POSITIVE_INFINITY });
    expect(tracker.spentUsd).toBe(0);
  });

  it('exposes a stable skip reason', () => {
    expect(BUDGET_SKIP_REASON).toContain('budget');
  });
});

describe('budget input validation', () => {
  it('treats NaN and non-finite limits as no budget', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
      const tracker = createBudgetTracker(bad);
      tracker.record({ costUsd: 999 });
      expect(tracker.exceeded()).toBe(false);
      expect(tracker.limitUsd).toBeUndefined();
    }
  });
});
