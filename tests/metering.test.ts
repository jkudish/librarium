import { describe, expect, it } from 'vitest';
import { getAllProviders, initializeProviders } from '../src/adapters/index.js';
import {
  createEstimateBudgetTracker,
  ESTIMATE_BUDGET_SKIP_REASON,
} from '../src/core/budget.js';
import {
  buildProviderMetering,
  estimateMetering,
  getMeteringKind,
  meteredProviderIds,
  PRICING_VERSION,
} from '../src/core/metering.js';

describe('metering registry: kinds', () => {
  it('classifies known providers by metering kind', () => {
    expect(getMeteringKind('perplexity-sonar-pro')).toBe('native_cost');
    expect(getMeteringKind('exa')).toBe('native_cost');
    expect(getMeteringKind('openrouter-chat')).toBe('native_cost');
    expect(getMeteringKind('claude')).toBe('native_tokens');
    expect(getMeteringKind('gemini-deep')).toBe('native_tokens');
    expect(getMeteringKind('grok')).toBe('native_tokens');
    expect(getMeteringKind('serpapi')).toBe('request_priced');
    expect(getMeteringKind('brave-search')).toBe('request_priced');
    expect(getMeteringKind('kagi-fastgpt')).toBe('request_priced');
    expect(getMeteringKind('tavily')).toBe('credit_priced');
    expect(getMeteringKind('firecrawl-search')).toBe('credit_priced');
    expect(getMeteringKind('jina-search')).toBe('api_unit_priced');
    expect(getMeteringKind('brave-answers')).toBe('api_unit_priced');
  });

  it('resolves legacy aliases to the canonical kind', () => {
    // perplexity-sonar -> perplexity-sonar-pro (native_cost)
    expect(getMeteringKind('perplexity-sonar')).toBe('native_cost');
  });

  it('defaults unknown/custom providers to manual_unmetered', () => {
    expect(getMeteringKind('totally-made-up')).toBe('manual_unmetered');
  });

  it('lockstep: every built-in provider has a registry entry', async () => {
    await initializeProviders();
    const registered = new Set(meteredProviderIds());
    const missing = getAllProviders()
      .map((p) => p.id)
      .filter((id) => !registered.has(id));
    expect(
      missing,
      `built-in providers missing a metering registry entry: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});

describe('metering registry: estimates', () => {
  it('emits a default USD estimate for flat request-priced providers', () => {
    const est = estimateMetering('serpapi');
    expect(est).toBeDefined();
    expect(est?.estimatedCostUsd).toBe(0.015);
    expect(est?.billableUnits).toBe(1);
    expect(est?.unit).toBe('request');
    expect(est?.costConfidence).toBe('estimated');
    expect(est?.pricingVersion).toBe(PRICING_VERSION);
  });

  it('honors a configured per-request override (confidence: configured)', () => {
    const est = estimateMetering('serpapi', {
      options: { perRequestUsd: 0.02 },
    });
    expect(est?.estimatedCostUsd).toBe(0.02);
    expect(est?.costConfidence).toBe('configured');
  });

  it('emits units WITHOUT a default USD figure for credit-priced providers', () => {
    const est = estimateMetering('tavily');
    expect(est).toBeDefined();
    expect(est?.unit).toBe('credit');
    expect(est?.billableUnits).toBe(2);
    expect(est?.estimatedCostUsd).toBeUndefined();
    expect(est?.costConfidence).toBe('estimated');
  });

  it('computes a USD estimate for credit providers only once a price is configured', () => {
    const est = estimateMetering('tavily', { options: { creditUsd: 0.008 } });
    expect(est?.estimatedCostUsd).toBeCloseTo(0.016);
    expect(est?.costConfidence).toBe('configured');
  });

  it('emits unit metadata without USD for api_unit_priced providers', () => {
    const est = estimateMetering('jina-search');
    expect(est?.unit).toBe('token');
    expect(est?.estimatedCostUsd).toBeUndefined();
  });

  it('does not fabricate a pre-dispatch estimate for Brave Answers search-plus-token pricing', () => {
    const est = estimateMetering('brave-answers');
    expect(est?.unit).toBe('search + token');
    expect(est?.estimatedCostUsd).toBeUndefined();
  });

  it('produces no estimate for native or unmetered providers', () => {
    expect(estimateMetering('claude')).toBeUndefined();
    expect(estimateMetering('perplexity-sonar-pro')).toBeUndefined();
    expect(estimateMetering('totally-made-up')).toBeUndefined();
  });

  it('uses a clearly labeled baseline estimate for Grok token and web-search pricing', () => {
    const est = estimateMetering('grok');
    expect(est).toMatchObject({
      estimatedCostUsd: 0.015,
      billableUnits: 1,
      unit: 'request',
      costConfidence: 'estimated',
      pricingVersion: PRICING_VERSION,
    });
  });

  it('reserves a conservative baseline for Gemini Deep Research tasks', () => {
    const est = estimateMetering('gemini-deep');
    expect(est).toMatchObject({
      estimatedCostUsd: 3,
      billableUnits: 1,
      unit: 'task',
      costConfidence: 'estimated',
      pricingVersion: PRICING_VERSION,
    });
  });

  it('pins the pricing snapshot version (bump deliberately)', () => {
    // Tripwire: changing default prices should bump PRICING_VERSION.
    expect(PRICING_VERSION).toBe('2026-08');
  });
});

describe('buildProviderMetering: estimate vs actual separation', () => {
  it('attaches an estimate but no actual when no usage is in hand', () => {
    const metering = buildProviderMetering('serpapi');
    expect(metering.kind).toBe('request_priced');
    expect(metering.estimate?.estimatedCostUsd).toBe(0.015);
    expect(metering.actual).toBeUndefined();
  });

  it('derives a provider_reported actual lane from reported costUsd', () => {
    const metering = buildProviderMetering('perplexity-sonar-pro', undefined, {
      costUsd: 0.0086,
      totalTokens: 180,
    });
    expect(metering.kind).toBe('native_cost');
    expect(metering.actual).toEqual({
      costUsd: 0.0086,
      source: 'provider_reported',
    });
    // native_cost has no pre-dispatch estimate, and the actual never leaks into
    // an estimate field.
    expect(metering.estimate).toBeUndefined();
  });

  it('never invents an actual lane from tokens-only usage', () => {
    const metering = buildProviderMetering('claude', undefined, {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });
    expect(metering.kind).toBe('native_tokens');
    expect(metering.actual).toBeUndefined();
  });

  it('preserves provider-reported billable units without fabricating USD', () => {
    const metering = buildProviderMetering('firecrawl-search', undefined, {
      billableUnits: 4,
      unit: 'credit',
    });
    expect(metering.kind).toBe('credit_priced');
    expect(metering.actual).toEqual({
      billableUnits: 4,
      source: 'provider_reported',
    });
    expect(metering.actual?.costUsd).toBeUndefined();
  });

  it('defaults unknown providers to manual_unmetered with no estimate/actual', () => {
    const metering = buildProviderMetering('totally-made-up');
    expect(metering).toEqual({ kind: 'manual_unmetered' });
  });
});

describe('createEstimateBudgetTracker', () => {
  it('never trips when no limit is set', () => {
    const tracker = createEstimateBudgetTracker(undefined);
    tracker.reserve({ estimatedCostUsd: 100, costConfidence: 'estimated' });
    expect(tracker.limitUsd).toBeUndefined();
    expect(tracker.reservedUsd).toBe(100);
    expect(tracker.exceeded()).toBe(false);
  });

  it('reserves only a finite positive estimatedCostUsd', () => {
    const tracker = createEstimateBudgetTracker(1);
    tracker.reserve(undefined);
    tracker.reserve({ costConfidence: 'estimated' }); // no USD figure
    tracker.reserve({
      billableUnits: 2,
      unit: 'credit',
      costConfidence: 'estimated',
    });
    tracker.reserve({ estimatedCostUsd: -1, costConfidence: 'estimated' });
    expect(tracker.reservedUsd).toBe(0);
    expect(tracker.exceeded()).toBe(false);
  });

  it('trips once the reservation reaches the ceiling (inclusive)', () => {
    const tracker = createEstimateBudgetTracker(0.03);
    tracker.reserve({ estimatedCostUsd: 0.015, costConfidence: 'estimated' });
    expect(tracker.exceeded()).toBe(false);
    tracker.reserve({ estimatedCostUsd: 0.015, costConfidence: 'estimated' });
    expect(tracker.reservedUsd).toBeCloseTo(0.03);
    expect(tracker.exceeded()).toBe(true);
  });

  it('treats a non-positive limit as no limit', () => {
    expect(createEstimateBudgetTracker(0).limitUsd).toBeUndefined();
    expect(createEstimateBudgetTracker(-2).limitUsd).toBeUndefined();
  });

  it('exposes a stable, distinct skip reason', () => {
    expect(ESTIMATE_BUDGET_SKIP_REASON).toContain('estimated');
    expect(ESTIMATE_BUDGET_SKIP_REASON).not.toBe(
      'skipped: cost budget reached',
    );
  });
});
