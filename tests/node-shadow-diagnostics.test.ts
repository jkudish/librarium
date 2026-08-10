import { describe, expect, it } from 'vitest';
import {
  emitProductionShadowDiagnostic,
  formatShadowDiagnosticCodes,
} from '../src/node-shadow-diagnostics.js';
import type { Config } from '../src/types.js';

function config(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    defaults: {
      outputDir: './agents/librarium',
      maxParallel: 2,
      timeout: 30,
      asyncTimeout: 300,
      asyncPollInterval: 5,
      mode: 'sync',
      llmWebSearch: true,
    },
    providers: {},
    customProviders: {},
    trustedProviderIds: [],
    groups: {},
    ...overrides,
  };
}

describe('Node production shadow diagnostic', () => {
  it('uses own-key environment credentials and emits code-only bounded output', () => {
    const inherited = Object.create({
      EXA_API_KEY: 'inherited-secret',
    }) as Record<string, string | undefined>;
    const warnings: string[] = [];
    emitProductionShadowDiagnostic(
      {
        config: config({ providers: { exa: { enabled: true } } }),
        env: inherited,
        transport: {
          kind: 'cli',
          input: {
            query: 'private query text',
            providers: ['exa'],
          },
        },
      },
      (message) => warnings.push(message),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^\[librarium\] shadow: issues=\d+ issues_codes=[a-z0-9_,]+; notices=\d+ notices_codes=(?:[a-z0-9_,]+|none)$/,
    );
    expect(warnings[0]).toContain('profile_uncredentialed');
    expect(warnings[0]).not.toContain('/');
    expect(warnings[0]).not.toContain('exa');
    expect(warnings[0]).not.toContain('inherited-secret');
    expect(warnings[0]).not.toContain('private query text');
    expect(warnings[0]!.length).toBeLessThan(2_100);
  });

  it('does not enumerate the environment and admits an own credential', () => {
    let ownKeysCalls = 0;
    const env = new Proxy(
      { EXA_API_KEY: 'own-secret' } as Record<string, string | undefined>,
      {
        ownKeys(target) {
          ownKeysCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    const warnings: string[] = [];
    emitProductionShadowDiagnostic(
      {
        config: config({ providers: { exa: { enabled: true } } }),
        env,
        transport: {
          kind: 'cli',
          input: { query: 'q', providers: ['exa'] },
        },
      },
      (message) => warnings.push(message),
    );
    expect(ownKeysCalls).toBe(0);
    expect(warnings.join()).not.toContain('own-secret');
  });

  it('fails open when provenance lookup or the warning sink throws', () => {
    const brokenConfig = new Proxy(config(), {
      get(target, property, receiver) {
        if (property === 'groups') throw new Error('secret provenance failure');
        return Reflect.get(target, property, receiver);
      },
    });
    const warnings: string[] = [];
    expect(() =>
      emitProductionShadowDiagnostic(
        {
          config: brokenConfig,
          env: {},
          transport: { kind: 'cli', input: { query: 'q' } },
        },
        (message) => warnings.push(message),
      ),
    ).not.toThrow();
    expect(warnings).toEqual(['[librarium] shadow: diagnostic_failed']);
    expect(warnings.join()).not.toContain('provenance');

    expect(() =>
      emitProductionShadowDiagnostic(
        {
          config: config({ providers: { exa: { enabled: true } } }),
          env: {},
          transport: {
            kind: 'cli',
            input: { query: 'q', providers: ['exa'] },
          },
        },
        () => {
          throw new Error('sink unavailable');
        },
      ),
    ).not.toThrow();
  });

  it('deduplicates diagnostic codes while retaining the occurrence count', () => {
    expect(
      formatShadowDiagnosticCodes('issues', [
        { code: 'duplicate_code' },
        { code: 'duplicate_code' },
        { code: 'other_code' },
      ]),
    ).toBe('issues=3 issues_codes=duplicate_code,other_code');
  });

  it('caps sorted diagnostic codes at twelve', () => {
    const values = Array.from({ length: 15 }, (_, index) => ({
      code: `code_${String(index).padStart(2, '0')}`,
    }));
    expect(formatShadowDiagnosticCodes('notices', values)).toBe(
      `notices=15 notices_codes=${values
        .slice(0, 12)
        .map(({ code }) => code)
        .join(',')}`,
    );
  });

  it('replaces invalid diagnostic codes without exposing their contents', () => {
    const summary = formatShadowDiagnosticCodes('issues', [
      { code: 'safe_code' },
      { code: 'SECRET/path\nvalue' },
      { code: 'also-invalid!' },
    ]);
    expect(summary).toBe(
      'issues=3 issues_codes=invalid_diagnostic_code,safe_code',
    );
    expect(summary).not.toContain('SECRET');
    expect(summary).not.toContain('path');
  });
});
