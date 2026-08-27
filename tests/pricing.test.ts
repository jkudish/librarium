import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_GROK_MODEL } from '../src/adapters/grok-responses.js';
import { BUILTIN_PROVIDER_DESCRIPTORS } from '../src/adapters/provider-descriptors.js';
import type { ProviderIdentity } from '../src/contracts/domain/index.js';
import { canonicalJson } from '../src/core/catalog-fingerprint.js';
import {
  assertPricingSnapshotFresh,
  budgetEstimateFromQuote,
  type PriceDefinitionInput,
  PricingCatalog,
  PricingCatalogError,
  type PricingSnapshotInput,
  priceDefinitionFingerprint,
  pricingSnapshotFingerprint,
  pricingSnapshotPayload,
  usdDecimalToMicrousd,
  validatePricingSnapshot,
  verifyPricingSnapshotFingerprint,
} from '../src/core/pricing.js';
import { BUILTIN_PRICING_SNAPSHOT } from '../src/core/pricing-snapshot.js';
import { BUILTIN_PROFILE_BINDING_SPECS } from '../src/core/profile-bindings.js';
import { BUILTIN_PROVIDER_CATALOG } from '../src/core/provider-profiles.js';

const NOW = '2026-08-13T00:00:00.000Z';

function identity(
  providerId = 'test-provider',
  profileId = 'chat',
  targetId = 'model-a',
): ProviderIdentity {
  return {
    provider_id: providerId,
    profile_id: profileId,
    target: {
      primary: {
        model_selection: 'configurable',
        kind: 'model',
        target_id: targetId,
      },
    },
  };
}

function definition(
  overrides: Partial<PriceDefinitionInput> = {},
): PriceDefinitionInput {
  return {
    id: 'test-provider.chat.model-a',
    provider_id: 'test-provider',
    profile_id: 'chat',
    effective_target: { kind: 'model', target_id: 'model-a' },
    currency: 'USD',
    completeness: 'complete',
    confidence: 'confirmed',
    expected_units: ['uncached_input_tokens', 'output_tokens'],
    missing_units: [],
    rates: [
      {
        unit: 'uncached_input_tokens',
        amount_decimal: '0.3',
        per_decimal: '1000000',
      },
      {
        unit: 'output_tokens',
        amount_decimal: '2.5',
        per_decimal: '1000000',
      },
    ],
    provenance: {
      source_class: 'frozen_official_snapshot',
      source_reference: 'official:example.com/pricing',
      effective_at: NOW,
      retrieved_at: NOW,
    },
    ...overrides,
  };
}

function snapshot(
  definitions: readonly PriceDefinitionInput[] = [definition()],
  overrides: Partial<PricingSnapshotInput> = {},
): PricingSnapshotInput {
  const candidate: PricingSnapshotInput = {
    schema_version: 1,
    version: 'test.v1',
    reviewed_at: NOW,
    currency: 'USD',
    fingerprint: `sha256:${'0'.repeat(64)}`,
    definitions,
    ...overrides,
  };
  return overrides.fingerprint === undefined
    ? { ...candidate, fingerprint: pricingSnapshotFingerprint(candidate) }
    : candidate;
}

describe('pricing snapshot validation', () => {
  it('covers every implemented built-in profile exactly once', () => {
    const bound = BUILTIN_PROFILE_BINDING_SPECS.map(
      ({ provider_id, profile_id }) => `${provider_id}/${profile_id}`,
    ).sort();
    const priced = BUILTIN_PRICING_SNAPSHOT.definitions
      .map(({ provider_id, profile_id }) => `${provider_id}/${profile_id}`)
      .sort();

    expect(priced).toEqual(bound);
    expect(new Set(priced).size).toBe(40);
    expect(
      BUILTIN_PRICING_SNAPSHOT.definitions.every((entry) =>
        ['complete', 'partial', 'unavailable'].includes(entry.completeness),
      ),
    ).toBe(true);
  });

  it('pins every shipping Grok identity and exact official rate without drift', () => {
    const shippingProfiles = [
      ['grok', 'web'],
      ['grok-x-only', 'x'],
      ['grok-combined', 'combined'],
    ] as const;
    const expectedRates = [
      ['uncached_input_tokens', '2', '1000000'],
      ['output_tokens', '6', '1000000'],
      ['reasoning_tokens', '6', '1000000'],
      ['cache_read_tokens', '0.5', '1000000'],
      ['searches', '5', '1000'],
    ];

    expect(DEFAULT_GROK_MODEL).toBe('grok-4.6');
    for (const [providerId, profileId] of shippingProfiles) {
      const catalog = BUILTIN_PROVIDER_CATALOG.find(
        ({ provider_id }) => provider_id === providerId,
      );
      const descriptor = BUILTIN_PROVIDER_DESCRIPTORS.find(
        ({ id }) => id === providerId,
      );
      const pricing = BUILTIN_PRICING_SNAPSHOT.definitions.find(
        (entry) =>
          entry.provider_id === providerId && entry.profile_id === profileId,
      );

      expect(catalog?.profiles[0]?.target.primary.target_id).toBe('grok-4.6');
      expect(descriptor?.defaultModel).toBe('grok-4.6');
      expect(pricing).toMatchObject({
        id: `${providerId}.${profileId}.grok-4.6`,
        effective_target: { kind: 'model', target_id: 'grok-4.6' },
        provenance: {
          source_class: 'frozen_official_snapshot',
          source_reference: 'official:docs.x.ai/developers/pricing',
        },
      });
      expect(
        pricing?.rates.map(({ unit, amount_decimal, per_decimal }) => [
          unit,
          amount_decimal,
          per_decimal,
        ]),
      ).toEqual(expectedRates);
    }
  });

  it.each(['-1', 'NaN', 'Infinity', '1e309', '', '1.'.padEnd(130, '0')])(
    'rejects malformed, negative, nonfinite, or unsafe rates: %s',
    (amount) => {
      expect(() =>
        validatePricingSnapshot(
          snapshot([
            definition({
              rates: [
                {
                  unit: 'uncached_input_tokens',
                  amount_decimal: amount,
                  per_decimal: '1',
                },
                {
                  unit: 'output_tokens',
                  amount_decimal: '1',
                  per_decimal: '1',
                },
              ],
            }),
          ]),
        ),
      ).toThrow(PricingCatalogError);
    },
  );

  it('rejects zero divisors, mixed currency, malformed completeness, and unsafe units', () => {
    expect(() =>
      validatePricingSnapshot(
        snapshot([
          definition({
            rates: [
              {
                unit: 'uncached_input_tokens',
                amount_decimal: '1',
                per_decimal: '0',
              },
              {
                unit: 'output_tokens',
                amount_decimal: '1',
                per_decimal: '1',
              },
            ],
          }),
        ]),
      ),
    ).toThrow('greater than zero');
    expect(() =>
      validatePricingSnapshot(snapshot([definition({ currency: 'EUR' })])),
    ).toThrow('snapshot currency');
    expect(() =>
      validatePricingSnapshot(
        snapshot([
          definition({
            completeness: 'complete',
            expected_units: [
              'uncached_input_tokens',
              'output_tokens',
              'credits',
            ],
            missing_units: ['credits'],
          }),
        ]),
      ),
    ).toThrow('Complete definitions');
    expect(() =>
      validatePricingSnapshot(
        snapshot([
          definition({
            expected_units: ['unsafe unit'],
            missing_units: ['unsafe unit'],
            rates: [],
            completeness: 'unavailable',
            unknown_reason: 'No rate.',
          }),
        ]),
      ),
    ).toThrow('normalized unit');
    expect(() =>
      validatePricingSnapshot(
        snapshot([
          definition({
            rates: [
              {
                unit: 'uncached_input_tokens',
                amount_decimal: '1',
                per_decimal: '3',
              },
              definition().rates[1],
            ],
          }),
        ]),
      ),
    ).toThrow('non-terminating');
    expect(() =>
      validatePricingSnapshot(
        snapshot([
          definition({
            rates: [
              ...definition().rates,
              { unit: 'credits', amount_decimal: '1', per_decimal: '1' },
            ],
          }),
        ]),
      ),
    ).toThrow('expected units');
  });

  it('rejects normalized identity collisions and conflicting definitions', () => {
    expect(() =>
      validatePricingSnapshot(
        snapshot([
          definition(),
          definition({
            id: 'duplicate',
            provider_id: 'TEST-PROVIDER',
            effective_target: { kind: 'model', target_id: 'MODEL-A' },
          }),
        ]),
      ),
    ).toThrow('normalized identity collision');
  });

  it('rejects credential-bearing, query-bearing, and local source references', () => {
    for (const source_reference of [
      'https://user:secret@example.com/pricing?token=secret',
      'official:example.com/pricing?api_key=secret',
      '/Users/private/pricing.json',
    ]) {
      expect(() =>
        validatePricingSnapshot(
          snapshot([
            definition({
              provenance: {
                ...definition().provenance,
                source_reference,
              },
            }),
          ]),
        ),
      ).toThrow('redacted public identifiers');
    }
  });

  it('detects stale, future, malformed, and fingerprint-drifted snapshots', async () => {
    const valid = snapshot();
    expect(() =>
      assertPricingSnapshotFresh(valid, '2026-08-14T00:00:00.000Z', 86_400_000),
    ).not.toThrow();
    expect(() =>
      assertPricingSnapshotFresh(valid, '2026-08-14T00:00:00.001Z', 86_400_000),
    ).toThrow('stale');
    expect(() =>
      assertPricingSnapshotFresh(valid, '2026-08-12T00:00:00.000Z', 86_400_000),
    ).toThrow('future');
    expect(() =>
      validatePricingSnapshot(snapshot([], { reviewed_at: 'not-a-date' })),
    ).toThrow();
    expect(() =>
      validatePricingSnapshot(
        snapshot(undefined, { reviewed_at: '2026-02-31T00:00:00.000Z' }),
      ),
    ).toThrow('real RFC 3339');
    expect(() =>
      validatePricingSnapshot(
        snapshot([
          definition({
            provenance: {
              ...definition().provenance,
              retrieved_at: '2026-08-14T00:00:00.000Z',
            },
          }),
        ]),
      ),
    ).toThrow('after the snapshot review');
    const fingerprintDrifted = { ...valid, version: '2026-08-13-drifted' };
    expect(() => verifyPricingSnapshotFingerprint(fingerprintDrifted)).toThrow(
      'does not match',
    );
  });

  it('has a stable order-independent SHA-256 fingerprint and detects price drift', async () => {
    const original = snapshot();
    const reordered = snapshot([
      {
        ...definition(),
        expected_units: ['output_tokens', 'uncached_input_tokens'],
        rates: [...definition().rates].reverse(),
      },
    ]);
    const drifted = snapshot([
      {
        ...definition(),
        rates: [
          { ...definition().rates[0], amount_decimal: '0.300001' },
          definition().rates[1],
        ],
      },
    ]);

    expect(pricingSnapshotFingerprint(original)).toBe(
      pricingSnapshotFingerprint(reordered),
    );
    expect(pricingSnapshotFingerprint(drifted)).not.toBe(
      pricingSnapshotFingerprint(original),
    );
    expect(priceDefinitionFingerprint(definition())).toBe(
      priceDefinitionFingerprint({
        ...definition(),
        expected_units: [...definition().expected_units].reverse(),
        rates: [...definition().rates].reverse(),
      }),
    );
  });

  it('pins and verifies the reviewed built-in fingerprint', async () => {
    expect(BUILTIN_PRICING_SNAPSHOT.fingerprint).toBe(
      'sha256:7d0bb6bf5049bb68bdf3c5836fd57eb2f6d73b262911e736f5d36cfb48019d5a',
    );
    expect(pricingSnapshotFingerprint(BUILTIN_PRICING_SNAPSHOT)).toBe(
      'sha256:7d0bb6bf5049bb68bdf3c5836fd57eb2f6d73b262911e736f5d36cfb48019d5a',
    );
    expect(
      `sha256:${createHash('sha256')
        .update(canonicalJson(pricingSnapshotPayload(BUILTIN_PRICING_SNAPSHOT)))
        .digest('hex')}`,
    ).toBe(BUILTIN_PRICING_SNAPSHOT.fingerprint);
    expect(() =>
      verifyPricingSnapshotFingerprint(BUILTIN_PRICING_SNAPSHOT),
    ).not.toThrow();
  });
});

describe('exact pricing and quotes', () => {
  it('calculates exact token costs without floating point arithmetic', () => {
    const quote = new PricingCatalog(snapshot()).quote({
      requested_identity: identity(),
      quantities: {
        uncached_input_tokens: '1000001',
        output_tokens: '3',
      },
    });

    expect(quote).toMatchObject({
      status: 'complete',
      amount_decimal: '0.3000078',
      known_minimum_decimal: '0.3000078',
      known_maximum_decimal: '0.3000078',
      missing_units: [],
    });
    expect(budgetEstimateFromQuote(quote)?.estimated_cost_microusd).toBe(
      '300008',
    );
  });

  it('rounds only at the explicit microusd boundary', () => {
    expect(usdDecimalToMicrousd('0.000001')).toBe('1');
    expect(() => usdDecimalToMicrousd('0.0000001')).toThrow(
      'explicit rounding',
    );
    expect(usdDecimalToMicrousd('0.0000001', 'ceil')).toBe('1');
    expect(usdDecimalToMicrousd('0.0000009', 'floor')).toBe('0');
  });

  it('does not let estimate input reduce a frozen fixed quantity', () => {
    const fixed = definition({
      expected_units: ['requests'],
      fixed_quantities: { requests: '2' },
      rates: [{ unit: 'requests', amount_decimal: '0.004', per_decimal: '1' }],
    });
    const catalog = new PricingCatalog(snapshot([fixed]));
    const estimate = catalog.quote({
      requested_identity: identity(),
      quantities: { requests: '1' },
    });
    const actual = catalog.quote({
      requested_identity: identity(),
      quantities: { requests: '1' },
      quantity_source: 'provider_reported',
    });

    expect(estimate.amount_decimal).toBe('0.008');
    expect(estimate.billable_quantities.requests).toBe('2');
    expect(actual.amount_decimal).toBe('0.004');
    expect(actual.billable_quantities.requests).toBe('1');
  });

  it('exposes complete, partial, and unavailable states and never maps unknown to zero', () => {
    const catalog = new PricingCatalog(snapshot());
    const partial = catalog.quote({
      requested_identity: identity(),
      quantities: { uncached_input_tokens: '10' },
    });
    const unavailable = catalog.quote({
      requested_identity: identity('other-provider'),
    });

    expect(partial).toMatchObject({
      status: 'partial',
      amount_decimal: '0.000003',
      known_minimum_decimal: '0.000003',
      missing_units: ['output_tokens'],
    });
    expect(partial.known_maximum_decimal).toBeUndefined();
    expect(budgetEstimateFromQuote(partial)).toBeUndefined();
    expect(unavailable).toMatchObject({
      status: 'unavailable',
      confidence: 'unknown',
    });
    expect(unavailable.amount_decimal).toBeUndefined();
    expect(budgetEstimateFromQuote(unavailable)).toBeUndefined();

    const unexpectedUnit = catalog.quote({
      requested_identity: identity(),
      quantities: {
        uncached_input_tokens: '10',
        output_tokens: '10',
        credits: '1',
      },
    });
    expect(unexpectedUnit).toMatchObject({
      status: 'partial',
      missing_units: ['credits'],
    });
    expect(budgetEstimateFromQuote(unexpectedUnit)).toBeUndefined();

    const zero = catalog.quote({
      requested_identity: identity(),
      quantities: { uncached_input_tokens: '0', output_tokens: '0' },
    });
    expect(zero).toMatchObject({
      status: 'complete',
      amount_decimal: '0',
      known_minimum_decimal: '0',
      known_maximum_decimal: '0',
    });
  });

  it('prices the effective routed identity while preserving the requested identity', () => {
    const requested = identity('test-provider', 'chat', 'router');
    const catalog = new PricingCatalog(
      snapshot([
        definition(),
        definition({
          id: 'test-provider.chat.model-b',
          effective_target: { kind: 'model', target_id: 'model-b' },
          rates: definition().rates.map((entry) => ({
            ...entry,
            amount_decimal: entry.unit === 'uncached_input_tokens' ? '1' : '10',
          })),
        }),
      ]),
    );
    const quote = catalog.quote({
      requested_identity: requested,
      effective_identity: {
        provider_id: 'test-provider',
        kind: 'model',
        target_id: 'model-b',
      },
      quantities: {
        uncached_input_tokens: '1000000',
        output_tokens: '1000000',
      },
    });

    expect(quote.amount_decimal).toBe('11');
    expect(quote.requested_identity).toEqual(requested);
    expect(quote.effective_identity?.target_id).toBe('model-b');
  });

  it('matches cross-provider effective routing and emits inferred effective identity', () => {
    const routed = definition({
      effective_target: {
        provider_id: 'downstream-provider',
        kind: 'model',
        target_id: 'model-b',
      },
    });
    const catalog = new PricingCatalog(snapshot([routed]));
    const quote = catalog.quote({
      requested_identity: identity(),
      effective_identity: {
        provider_id: 'downstream-provider',
        kind: 'model',
        target_id: 'model-b',
      },
      quantities: {
        uncached_input_tokens: '1',
        output_tokens: '1',
      },
    });
    expect(quote.status).toBe('complete');
    expect(quote.effective_identity?.provider_id).toBe('downstream-provider');

    const inferred = new PricingCatalog(snapshot()).quote({
      requested_identity: identity(),
      quantities: {
        uncached_input_tokens: '1',
        output_tokens: '1',
      },
    });
    expect(inferred.effective_identity).toMatchObject({
      provider_id: 'test-provider',
      target_id: 'model-a',
    });
  });

  it('prevents cache double billing and includes tool, search, media, and research surcharges', () => {
    const expected = [
      'uncached_input_tokens',
      'cache_read_tokens',
      'output_tokens',
      'searches',
      'tool_calls',
      'images',
      'audio_seconds',
      'research_requests',
      'vendor:premium_results',
    ] as const;
    const rates = expected.map((unit) => ({
      unit,
      amount_decimal: unit === 'uncached_input_tokens' ? '2' : '1',
      per_decimal: '1',
    }));
    const quote = new PricingCatalog(
      snapshot([
        definition({ expected_units: expected, rates, missing_units: [] }),
      ]),
    ).quote({
      requested_identity: identity(),
      quantities: {
        // Uncached and cache-read units are disjoint; total input is never billed.
        uncached_input_tokens: '2',
        cache_read_tokens: '3',
        output_tokens: '1',
        searches: '1',
        tool_calls: '1',
        images: '1',
        audio_seconds: '1',
        research_requests: '1',
        'vendor:premium_results': '1',
      },
    });

    expect(quote.status).toBe('complete');
    expect(quote.amount_decimal).toBe('14');
  });

  it('uses configured account rates before official and reviewed fallback rates', () => {
    const official = definition();
    const fallback = definition({
      id: 'fallback',
      provenance: {
        ...official.provenance,
        source_class: 'frozen_reviewed_fallback',
        source_reference: 'reviewed:example.com/fallback',
      },
    });
    const configured = definition({
      id: 'configured',
      provenance: {
        ...official.provenance,
        source_class: 'configured_account_rate',
        source_reference: 'configured:account/rate-card',
      },
      rates: official.rates.map((entry) => ({
        ...entry,
        amount_decimal: '5',
      })),
    });
    const catalog = new PricingCatalog(snapshot([fallback, official]), [
      configured,
    ]);
    const quote = catalog.quote({
      requested_identity: identity(),
      quantities: {
        uncached_input_tokens: '1',
        output_tokens: '1',
      },
    });

    expect(quote.provenance?.source_class).toBe('configured_account_rate');
    expect(quote.amount_decimal).toBe('0.00001');
    expect(quote.provenance?.definition_fingerprint).toBe(
      priceDefinitionFingerprint(configured),
    );
    expect(quote.provenance?.definition_fingerprint).not.toBe(
      priceDefinitionFingerprint(official),
    );
  });

  it('keeps provider-reported actual above computed actual and labels computation truthfully', () => {
    const catalog = new PricingCatalog(snapshot());
    const lookup = {
      requested_identity: identity(),
      provider_reported_units: {
        uncached_input_tokens: '1000000',
        output_tokens: '1000000',
      },
    } as const;
    expect(catalog.actual(lookup)).toMatchObject({
      amount_decimal: '2.8',
      source: 'computed_from_tokens',
      source_class: 'frozen_official_snapshot',
      requested_identity: identity(),
      provenance: {
        snapshot_fingerprint: expect.stringMatching(/^sha256:/),
      },
    });
    expect(
      catalog.actual({
        ...lookup,
        provider_reported_actual: {
          amount_decimal: '1.234',
          currency: 'USD',
          observed_at: NOW,
          source_reference: 'provider:example.com/usage',
        },
      }),
    ).toMatchObject({
      amount_decimal: '1.234',
      source: 'provider_reported',
      source_class: 'provider_reported_actual',
      requested_identity: identity(),
      provenance: {
        observed_at: NOW,
        source_reference: 'provider:example.com/usage',
      },
    });
  });

  it('freezes catalog inputs and keeps canonical output deterministic', () => {
    const mutable = snapshot();
    const catalog = new PricingCatalog(mutable);
    expect(Object.isFrozen(catalog.snapshot)).toBe(true);
    expect(Object.isFrozen(catalog.snapshot.definitions[0])).toBe(true);
    expect(canonicalJson(catalog.snapshot)).toBe(canonicalJson(snapshot()));
  });
});
