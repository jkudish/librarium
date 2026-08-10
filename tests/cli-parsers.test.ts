import { describe, expect, it } from 'vitest';
import {
  CLI_LIMITS,
  parseCompletionShell,
  parseConfigAction,
  parseMode,
  parseParallel,
  parsePositiveDays,
  parseProviders,
  parseResearchQuery,
  parseTimeoutSeconds,
  parseUsdBudget,
} from '../src/cli-parsers.js';

describe('strict CLI parsers', () => {
  it('trims valid research queries and rejects blank or overlong input', () => {
    expect(parseResearchQuery('  useful query  ')).toBe('useful query');
    expect(parseResearchQuery('x'.repeat(CLI_LIMITS.queryLength))).toHaveLength(
      CLI_LIMITS.queryLength,
    );
    expect(() => parseResearchQuery('   ')).toThrow(/blank/);
    expect(() =>
      parseResearchQuery('x'.repeat(CLI_LIMITS.queryLength + 1)),
    ).toThrow(/at most/);
  });

  it('normalizes bounded provider lists without accepting empty slots', () => {
    expect(parseProviders('openai, perplexity')).toEqual([
      'openai',
      'perplexity',
    ]);
    expect(() => parseProviders('openai,,perplexity')).toThrow(/non-empty/);
    expect(
      parseProviders(
        Array.from(
          { length: CLI_LIMITS.providers },
          (_, index) => `provider-${index}`,
        ).join(','),
      ),
    ).toHaveLength(CLI_LIMITS.providers);
    expect(() =>
      parseProviders(
        Array.from(
          { length: CLI_LIMITS.providers + 1 },
          (_, index) => `provider-${index}`,
        ).join(','),
      ),
    ).toThrow(/at most/);
  });

  it('accepts only the three legacy execution modes', () => {
    expect(parseMode('sync')).toBe('sync');
    expect(parseMode('async')).toBe('async');
    expect(parseMode('mixed')).toBe('mixed');
    expect(() => parseMode('background')).toThrow(/sync, async, mixed/);
  });

  it('parses bounded decimal integers without truncation or unsafe values', () => {
    expect(parseParallel('1')).toBe(1);
    expect(parseParallel('64')).toBe(64);
    expect(parseParallel('01')).toBe(1);
    expect(parseParallel('+01')).toBe(1);
    expect(parseTimeoutSeconds('1')).toBe(1);
    expect(parseTimeoutSeconds('604800')).toBe(604_800);
    expect(parsePositiveDays('365')).toBe(365);
    expect(() => parsePositiveDays('0')).toThrow(/between 1/);

    for (const invalid of ['1.5', '1day', '-1', '0']) {
      expect(() => parseParallel(invalid)).toThrow();
    }
    expect(() => parseParallel('65')).toThrow(/between 1 and 64/);
    expect(() => parseTimeoutSeconds('604801')).toThrow(/between/);
    expect(() => parsePositiveDays('9007199254740992')).toThrow(/safe integer/);
  });

  it('converts positive USD decimals without sub-micro rounding', () => {
    expect(parseUsdBudget('2.50')).toBe(2.5);
    expect(parseUsdBudget('.000001')).toBe(0.000001);
    expect(parseUsdBudget('1.234567')).toBe(1.234567);
    expect(parseUsdBudget('01')).toBe(1);
    expect(parseUsdBudget('+01.50')).toBe(1.5);
    expect(parseUsdBudget('1e3')).toBe(1_000);
    expect(parseUsdBudget('1e-6')).toBe(0.000001);
    expect(parseUsdBudget('10e-7')).toBe(0.000001);
    expect(parseUsdBudget('9007199254.740990')).toBe(9007199254.74099);

    for (const invalid of [
      '0',
      '-1',
      '1.2345678',
      '1e-7',
      '11e-7',
      'NaN',
      'Infinity',
      '9007199254.740991',
    ]) {
      expect(() => parseUsdBudget(invalid)).toThrow();
    }
  });

  it('keeps closed shell and config-action vocabularies explicit', () => {
    for (const shell of ['zsh', 'bash', 'fish'] as const) {
      expect(parseCompletionShell(shell)).toBe(shell);
    }
    expect(() => parseCompletionShell('pwsh')).toThrow(/zsh, bash, fish/);
    expect(parseConfigAction('menu')).toBe('menu');
    expect(() => parseConfigAction('edit')).toThrow(/menu/);
  });
});
