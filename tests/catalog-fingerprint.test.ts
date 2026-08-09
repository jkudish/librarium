import { describe, expect, it } from 'vitest';
import {
  CATALOG_FINGERPRINT_PREFIX,
  canonicalJson,
  catalogFingerprint,
  isCatalogFingerprint,
} from '../src/core/catalog-fingerprint.js';

describe('catalog fingerprint -- shape', () => {
  it('emits a versioned algorithm prefix and fixed-width 64-bit hex', () => {
    const fingerprint = catalogFingerprint({ a: 1 });
    expect(fingerprint.startsWith(CATALOG_FINGERPRINT_PREFIX)).toBe(true);
    expect(fingerprint).toMatch(/^fnv1a64\.1:[0-9a-f]{16}$/);
    expect(isCatalogFingerprint(fingerprint)).toBe(true);
  });

  it('pads short hashes to the full 16-character width', () => {
    for (let index = 0; index < 200; index += 1) {
      const fingerprint = catalogFingerprint({ index });
      expect(fingerprint.slice(CATALOG_FINGERPRINT_PREFIX.length)).toHaveLength(
        16,
      );
    }
  });

  it('rejects values that are not this algorithm and version', () => {
    expect(isCatalogFingerprint('fnv1a64.2:0000000000000000')).toBe(false);
    expect(isCatalogFingerprint('fnv1a32.1:00000000')).toBe(false);
    expect(isCatalogFingerprint('0000000000000000')).toBe(false);
    expect(isCatalogFingerprint('fnv1a64.1:0000000000000ABC')).toBe(false);
  });
});

describe('catalog fingerprint -- insertion-order independence', () => {
  it('sorts object keys so declaration order cannot change the value', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(catalogFingerprint({ b: 1, a: 2, c: { z: 1, y: 2 } })).toBe(
      catalogFingerprint({ c: { y: 2, z: 1 }, a: 2, b: 1 }),
    );
  });

  it('keeps array order significant, because roster order is a catalog fact', () => {
    expect(catalogFingerprint(['a', 'b'])).not.toBe(
      catalogFingerprint(['b', 'a']),
    );
  });

  it('omits undefined members so an absent optional equals a missing key', () => {
    expect(catalogFingerprint({ a: 1, b: undefined })).toBe(
      catalogFingerprint({ a: 1 }),
    );
  });
});

describe('catalog fingerprint -- change sensitivity', () => {
  const baseline = {
    revision: 'r1',
    profiles: [
      {
        provider_id: 'perplexity-sonar-pro',
        profile_id: 'grounded',
        corpora: ['web'],
        estimate: { estimated_cost_microusd: '4000' },
        enabled: true,
      },
    ],
  };

  const mutations: readonly [string, unknown][] = [
    [
      'a changed provider id',
      {
        ...baseline,
        profiles: [{ ...baseline.profiles[0], provider_id: 'perplexity' }],
      },
    ],
    [
      'a changed profile id',
      {
        ...baseline,
        profiles: [{ ...baseline.profiles[0], profile_id: 'grounded-web' }],
      },
    ],
    [
      'an added corpus',
      {
        ...baseline,
        profiles: [{ ...baseline.profiles[0], corpora: ['web', 'news'] }],
      },
    ],
    [
      'a one-microusd estimate change',
      {
        ...baseline,
        profiles: [
          {
            ...baseline.profiles[0],
            estimate: { estimated_cost_microusd: '4001' },
          },
        ],
      },
    ],
    [
      'a flipped availability flag',
      {
        ...baseline,
        profiles: [{ ...baseline.profiles[0], enabled: false }],
      },
    ],
    ['an added profile', { ...baseline, profiles: [...baseline.profiles, {}] }],
    ['a changed revision', { ...baseline, revision: 'r2' }],
  ];

  it.each(mutations)('changes for %s', (_label, mutated) => {
    expect(catalogFingerprint(mutated)).not.toBe(catalogFingerprint(baseline));
  });

  it('is stable across repeated calls on equal input', () => {
    expect(catalogFingerprint(baseline)).toBe(
      catalogFingerprint(structuredClone(baseline)),
    );
  });

  it('does not confuse a numeric value with its string spelling', () => {
    expect(catalogFingerprint({ a: 1 })).not.toBe(
      catalogFingerprint({ a: '1' }),
    );
  });
});
