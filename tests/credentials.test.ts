import { describe, expect, it } from 'vitest';
import {
  describeCredentialReference,
  hasCredential,
  keychainCredentialName,
  keychainCredentialRef,
  redactCredentialText,
  resolveCredential,
} from '../src/core/credentials.js';

describe('credential references', () => {
  it('describes env, keychain, literal, and missing references', () => {
    expect(describeCredentialReference('$BRAVE_API_KEY')).toEqual({
      source: 'env',
      name: 'BRAVE_API_KEY',
    });
    expect(describeCredentialReference('keychain:BRAVE_API_KEY')).toEqual({
      source: 'keychain',
      name: 'BRAVE_API_KEY',
    });
    expect(describeCredentialReference('literal-key')).toEqual({
      source: 'literal',
    });
    expect(describeCredentialReference(undefined)).toEqual({
      source: 'missing',
    });
  });

  it('builds and parses keychain references', () => {
    const ref = keychainCredentialRef('PERPLEXITY_API_KEY');
    expect(ref).toBe('keychain:PERPLEXITY_API_KEY');
    expect(keychainCredentialName(ref)).toBe('PERPLEXITY_API_KEY');
    expect(keychainCredentialName('$PERPLEXITY_API_KEY')).toBeUndefined();
  });

  it('lets an injected resolver handle keychain references and falls back to env vars', () => {
    const context = {
      env: { EXA_API_KEY: 'env-key' },
      resolveCredential: (value: string) =>
        value === 'keychain:BRAVE_API_KEY' ? 'keychain-key' : undefined,
    };

    expect(resolveCredential('keychain:BRAVE_API_KEY', context)).toBe(
      'keychain-key',
    );
    expect(resolveCredential('$EXA_API_KEY', context)).toBe('env-key');
    expect(hasCredential('keychain:BRAVE_API_KEY', context)).toBe(true);
  });

  it('treats unresolved keychain references as missing credentials', () => {
    const context = {
      resolveCredential: () => undefined,
    };

    expect(
      resolveCredential('keychain:BRAVE_API_KEY', context),
    ).toBeUndefined();
    expect(hasCredential('keychain:BRAVE_API_KEY', context)).toBe(false);
  });

  it('never resolves inherited environment properties as credentials', () => {
    expect(Object.hasOwn(process.env, 'hasOwnProperty')).toBe(false);
    expect(
      resolveCredential('$hasOwnProperty', { env: process.env }),
    ).toBeUndefined();
    expect(hasCredential('$hasOwnProperty', { env: process.env })).toBe(false);

    const inherited = Object.create({
      ACME_API_KEY: 'prototype-key',
    }) as Record<string, string>;
    expect(
      resolveCredential('$ACME_API_KEY', { env: inherited }),
    ).toBeUndefined();
    inherited.ACME_API_KEY = 'own-key';
    expect(resolveCredential('$ACME_API_KEY', { env: inherited })).toBe(
      'own-key',
    );
  });

  it('redacts only supplied credentials and credential URL parameters', () => {
    const sentinel = 'sentinel-resolved-credential';
    const redacted = redactCredentialText(
      `request ${sentinel} failed at https://example.com/run?api_key=other-secret&attempt=4`,
      [sentinel],
    );

    expect(redacted).toContain('request [REDACTED] failed');
    expect(redacted).toContain('api_key=[REDACTED]&attempt=4');
    expect(redacted).not.toContain(sentinel);
    expect(redacted).not.toContain('other-secret');
  });
});
