import { describe, expect, it } from 'vitest';
import { normalizeUsage } from '../src/core/dispatcher.js';
import {
  computeLineWidths,
  formatCost,
  formatProviderLine,
  formatRunSummary,
  formatTokens,
  usageLabel,
} from '../src/commands/run-format.js';
import type { ProviderReport } from '../src/types.js';

describe('formatTokens / formatCost', () => {
  it('abbreviates token counts', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(8400)).toBe('8.4k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
  });

  it('formats cost with sensible precision', () => {
    expect(formatCost(0.038)).toBe('$0.038');
    expect(formatCost(0.012)).toBe('$0.012');
    expect(formatCost(1.234)).toBe('$1.23');
  });
});

describe('usageLabel', () => {
  it('prefers API-reported cost over tokens', () => {
    expect(usageLabel({ costUsd: 0.012, totalTokens: 8400 })).toBe('$0.012');
  });

  it('falls back to total tokens, then to input+output', () => {
    expect(usageLabel({ totalTokens: 8400 })).toBe('8.4k tok');
    expect(usageLabel({ inputTokens: 4000, outputTokens: 400 })).toBe(
      '4.4k tok',
    );
    expect(usageLabel({ inputTokens: 4000 })).toBe('4.0k tok');
  });

  it('returns undefined when nothing was reported', () => {
    expect(usageLabel(undefined)).toBeUndefined();
    expect(usageLabel({})).toBeUndefined();
    expect(usageLabel({ raw: { foo: 1 } })).toBeUndefined();
  });
});

describe('normalizeUsage', () => {
  it('passes through adapter-provided usage untouched', () => {
    const usage = { costUsd: 0.01, totalTokens: 5 };
    expect(normalizeUsage({ usage })).toBe(usage);
  });

  it('lifts legacy tokenUsage into the normalized shape', () => {
    expect(normalizeUsage({ tokenUsage: { input: 100, output: 50 } })).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
    expect(normalizeUsage({ tokenUsage: { input: 100 } })).toEqual({
      inputTokens: 100,
    });
  });

  it('returns undefined when nothing is available', () => {
    expect(normalizeUsage({})).toBeUndefined();
    expect(normalizeUsage({ tokenUsage: {} })).toBeUndefined();
  });
});

describe('usage on provider lines and summary', () => {
  const widths = computeLineWidths(['exa'], ['ai-grounded']);

  function makeReport(
    usage?: ProviderReport['usage'],
  ): ProviderReport {
    return {
      id: 'exa',
      tier: 'ai-grounded',
      status: 'success',
      durationMs: 1800,
      wordCount: 100,
      citationCount: 25,
      outputFile: 'exa.md',
      metaFile: 'exa.meta.json',
      usage,
    };
  }

  it('appends a dim usage suffix when reported', () => {
    expect(formatProviderLine(makeReport({ totalTokens: 8400 }), widths, false)).toContain(
      '· 8.4k tok',
    );
    expect(formatProviderLine(makeReport({ costUsd: 0.012 }), widths, false)).toContain(
      '· $0.012',
    );
    expect(formatProviderLine(makeReport(), widths, false)).not.toContain('·');
  });

  it('adds the reported-cost summary line only when at least one provider reported cost', () => {
    const base = {
      succeeded: 5,
      failed: 0,
      pending: 1,
      uniqueSources: 70,
      totalCitations: 90,
      outputDir: '/srv/out',
      color: false,
    };
    const withCost = formatRunSummary({
      ...base,
      reportedCost: { totalUsd: 0.038, reporting: 3, providers: 6 },
    });
    expect(withCost.join('\n')).toContain(
      '▸ reported cost: $0.038 (3 of 6 providers)',
    );
    const without = formatRunSummary(base);
    expect(without.join('\n')).not.toContain('reported cost');
  });
});
