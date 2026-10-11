import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GROK_MODEL } from '../src/adapters/grok-responses.js';
import { BUILTIN_PROVIDER_DESCRIPTORS } from '../src/adapters/provider-descriptors.js';
import type { ProviderIdentity } from '../src/contracts/domain/index.js';
import { canonicalJson } from '../src/core/catalog-fingerprint.js';
import {
  assertPricingSnapshotFresh,
  budgetEstimateFromQuote,
  type PriceDefinitionInput,
  type PriceRate,
  type PriceRateWindow,
  PricingCatalog,
  PricingCatalogError,
  type PricingLookup,
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
  it('covers every implemented built-in profile and no retired profile', () => {
    const bound = BUILTIN_PROFILE_BINDING_SPECS.map(
      ({ provider_id, profile_id }) => `${provider_id}/${profile_id}`,
    ).sort();
    const priced = [
      ...new Set(
        BUILTIN_PRICING_SNAPSHOT.definitions.map(
          ({ provider_id, profile_id }) => `${provider_id}/${profile_id}`,
        ),
      ),
    ].sort();

    expect(priced).toEqual(bound);
    expect(priced).toHaveLength(40);
    expect(priced).not.toContain('searchapi-perplexity/surface');
    // Only tiered research profiles have more than one definition: one per
    // You.com effort, Parallel processor, or Valyu mode.
    const repeated = BUILTIN_PRICING_SNAPSHOT.definitions
      .map(({ provider_id, profile_id }) => `${provider_id}/${profile_id}`)
      .filter((key, index, all) => all.indexOf(key) !== index);
    expect(new Set(repeated)).toEqual(
      new Set(['you-research/research', 'parallel/research', 'valyu/research']),
    );
    expect(
      new Set(BUILTIN_PRICING_SNAPSHOT.definitions.map(({ id }) => id)).size,
    ).toBe(BUILTIN_PRICING_SNAPSHOT.definitions.length);
    expect(
      BUILTIN_PRICING_SNAPSHOT.definitions.every((entry) =>
        ['complete', 'partial', 'unavailable'].includes(entry.completeness),
      ),
    ).toBe(true);
  });

  it('prices the exact default target of every model-default profile', () => {
    const defaults = BUILTIN_PROVIDER_CATALOG.flatMap((entry) =>
      entry.profiles
        .filter(
          ({ status, target }) =>
            status === 'implemented' &&
            target.primary.model_selection === 'configurable' &&
            target.primary.kind === 'model',
        )
        .map(
          ({ profile_id, target }) =>
            `${entry.provider_id}/${profile_id} ${target.primary.target_id}`,
        ),
    );
    const priced = BUILTIN_PRICING_SNAPSHOT.definitions.map(
      ({ provider_id, profile_id, effective_target }) =>
        `${provider_id}/${profile_id} ${effective_target?.target_id}`,
    );

    expect(defaults).toEqual(
      expect.arrayContaining([
        'openai-research/research gpt-6.1-sol',
        'openai-chat/chat gpt-6-luna',
        'openrouter/grounded openai/gpt-6-luna',
        'openrouter/chat openai/gpt-6-luna',
        'gemini-grounded/grounded gemini-3.8-flash',
        'gemini-chat/chat gemini-3.8-flash',
        'grok/web grok-4.7',
        'grok-x-only/x grok-4.7',
        'grok-combined/combined grok-4.7',
        'claude/chat claude-sonnet-5-5',
      ]),
    );
    expect(priced).toEqual(expect.arrayContaining(defaults));
  });

  it.each([
    [
      'openai-research.research.gpt-6.1-sol',
      'official:developers.openai.com/api/docs/models/gpt-6.1-sol',
      [
        ['uncached_input_tokens', '2', '1000000'],
        ['output_tokens', '10', '1000000'],
        ['reasoning_tokens', '10', '1000000'],
        ['cache_read_tokens', '0.1', '1000000'],
        ['cache_write_tokens', '2.5', '1000000'],
        ['searches', '10', '1000'],
      ],
    ],
    [
      'openai-chat.chat.gpt-6-luna',
      'official:developers.openai.com/api/docs/models/gpt-6-luna',
      [
        ['uncached_input_tokens', '0.1', '1000000'],
        ['output_tokens', '0.5', '1000000'],
        ['reasoning_tokens', '0.5', '1000000'],
        ['cache_read_tokens', '0.01', '1000000'],
        ['cache_write_tokens', '0.125', '1000000'],
        ['searches', '10', '1000'],
      ],
    ],
    ...(['grounded', 'chat'] as const).map(
      (profileId) =>
        [
          `openrouter.${profileId}.openai/gpt-6-luna`,
          'official:openrouter.ai/openai/gpt-6-luna',
          [
            ['uncached_input_tokens', '0.1', '1000000'],
            ['output_tokens', '0.5', '1000000'],
            ['reasoning_tokens', '0.5', '1000000'],
            ['cache_read_tokens', '0.01', '1000000'],
            ['cache_write_tokens', '0.125', '1000000'],
            ['searches', '7', '1000'],
          ],
        ] as const,
    ),
    [
      'claude.chat.claude-sonnet-5-5',
      'official:platform.claude.com/docs/en/about-claude/pricing',
      [
        ['uncached_input_tokens', '2', '1000000'],
        ['output_tokens', '10', '1000000'],
        ['cache_read_tokens', '0.1', '1000000'],
        ['cache_write_tokens', '2.5', '1000000'],
      ],
    ],
  ] as const)('pins the sourced %s rates', (id, reference, rates) => {
    const pricing = BUILTIN_PRICING_SNAPSHOT.definitions.find(
      (entry) => entry.id === id,
    );
    expect(pricing).toMatchObject({
      completeness: 'partial',
      provenance: {
        source_class: 'frozen_official_snapshot',
        source_reference: reference,
        retrieved_at: '2026-10-11T00:00:00.000Z',
      },
    });
    expect(
      pricing?.rates.map(({ unit, amount_decimal, per_decimal }) => [
        unit,
        amount_decimal,
        per_decimal,
      ]),
    ).toEqual(rates);
  });

  it('pins the web-only Grok identity and exact official rate without drift', () => {
    const catalog = BUILTIN_PROVIDER_CATALOG.find(
      ({ provider_id }) => provider_id === 'grok',
    );
    const descriptor = BUILTIN_PROVIDER_DESCRIPTORS.find(
      ({ id }) => id === 'grok',
    );
    const pricing = BUILTIN_PRICING_SNAPSHOT.definitions.find(
      (entry) => entry.provider_id === 'grok' && entry.profile_id === 'web',
    );

    expect(DEFAULT_GROK_MODEL).toBe('grok-4.7');
    expect(catalog?.profiles[0]?.target.primary.target_id).toBe('grok-4.7');
    expect(descriptor?.defaultModel).toBe('grok-4.7');
    expect(pricing).toMatchObject({
      id: 'grok.web.grok-4.7',
      completeness: 'complete',
      effective_target: { kind: 'model', target_id: 'grok-4.7' },
      provenance: {
        source_class: 'frozen_official_snapshot',
        source_reference: 'official:docs.x.ai/developers/pricing',
        retrieved_at: '2026-10-11T00:00:00.000Z',
      },
    });
    expect(
      pricing?.rates.map(({ unit, amount_decimal, per_decimal }) => [
        unit,
        amount_decimal,
        per_decimal,
      ]),
    ).toEqual([
      ['uncached_input_tokens', '2', '1000000'],
      ['output_tokens', '6', '1000000'],
      ['reasoning_tokens', '6', '1000000'],
      ['cache_read_tokens', '0.5', '1000000'],
      ['searches', '5', '1000'],
    ]);
  });

  it.each([
    ['grok-x-only', 'x'],
    ['grok-combined', 'combined'],
  ] as const)(
    'makes %s unpriceable because X Search bills per item fetched',
    (providerId, profileId) => {
      const pricing = BUILTIN_PRICING_SNAPSHOT.definitions.find(
        (entry) =>
          entry.provider_id === providerId && entry.profile_id === profileId,
      );
      expect(pricing).toMatchObject({
        id: `${providerId}.${profileId}.grok-4.7`,
        completeness: 'unavailable',
        confidence: 'unknown',
        effective_target: { kind: 'model', target_id: 'grok-4.7' },
        rates: [],
        provenance: {
          source_reference: 'official:docs.x.ai/developers/pricing',
          retrieved_at: '2026-10-11T00:00:00.000Z',
        },
      });
      expect(pricing?.missing_units).toEqual(
        expect.arrayContaining(['xai:x_posts', 'xai:x_profiles']),
      );
      expect(pricing?.unknown_reason).toMatch(/per post and profile fetched/);

      const quote = new PricingCatalog(BUILTIN_PRICING_SNAPSHOT).quote({
        requested_identity: {
          provider_id: providerId,
          profile_id: profileId,
          target: {
            primary: {
              model_selection: 'configurable',
              kind: 'model',
              target_id: 'grok-4.7',
            },
          },
        },
      });
      expect(quote.status).toBe('unavailable');
      expect(budgetEstimateFromQuote(quote)).toBeUndefined();
    },
  );

  it.each([
    ['lite', '12000'],
    ['standard', '50000'],
    ['deep', '100000'],
    ['exhaustive', '450000'],
    ['frontier', '1200000'],
  ])(
    'prices You.com research effort %s from the official per-tier rate',
    (effort, microusd) => {
      const pricing = BUILTIN_PRICING_SNAPSHOT.definitions.find(
        (entry) =>
          entry.provider_id === 'you-research' &&
          entry.profile_id === 'research' &&
          entry.effective_target?.target_id === effort,
      );
      expect(pricing).toMatchObject({
        id: `you-research.research.${effort}`,
        completeness: 'complete',
        effective_target: { kind: 'preset', target_id: effort },
        provenance: {
          source_reference: 'official:you.com/pricing',
          retrieved_at: '2026-10-09T00:00:00.000Z',
        },
      });
      const quote = new PricingCatalog(BUILTIN_PRICING_SNAPSHOT).quote({
        requested_identity: {
          provider_id: 'you-research',
          profile_id: 'research',
          target: {
            primary: {
              model_selection: 'configurable',
              kind: 'preset',
              target_id: effort,
            },
          },
        },
      });
      expect(budgetEstimateFromQuote(quote)?.estimated_cost_microusd).toBe(
        microusd,
      );
    },
  );

  it.each([
    ['parallel', 'lite', '5000'],
    ['parallel', 'base', '10000'],
    ['parallel', 'core', '25000'],
    ['parallel', 'core2x', '50000'],
    ['parallel', 'pro', '100000'],
    ['parallel', 'ultra', '300000'],
    ['parallel', 'ultra2x', '600000'],
    ['parallel', 'ultra4x', '1200000'],
    ['parallel', 'ultra8x', '2400000'],
    ['valyu', 'fast', '100000'],
    ['valyu', 'standard', '500000'],
    ['valyu', 'heavy', '2500000'],
    ['valyu', 'max', '15000000'],
  ])(
    'prices %s research tier %s from the official per-run rate (#4856)',
    (providerId, tier, microusd) => {
      const quote = new PricingCatalog(BUILTIN_PRICING_SNAPSHOT).quote({
        requested_identity: {
          provider_id: providerId,
          profile_id: 'research',
          target: {
            primary: {
              model_selection: 'configurable',
              kind: 'preset',
              target_id: tier,
            },
          },
        },
      });
      expect(budgetEstimateFromQuote(quote)?.estimated_cost_microusd).toBe(
        microusd,
      );
    },
  );

  it.each([
    ['parallel', 'pro-fast'],
    ['parallel', 'ultra-fast'],
    ['valyu', 'lite'],
  ])('has no price for the unlisted %s tier %s', (providerId, tier) => {
    const quote = new PricingCatalog(BUILTIN_PRICING_SNAPSHOT).quote({
      requested_identity: {
        provider_id: providerId,
        profile_id: 'research',
        target: {
          primary: {
            model_selection: 'configurable',
            kind: 'preset',
            target_id: tier,
          },
        },
      },
    });
    expect(budgetEstimateFromQuote(quote)).toBeUndefined();
  });

  it('does not invent a You.com research price for an unknown effort tier', () => {
    const quote = new PricingCatalog(BUILTIN_PRICING_SNAPSHOT).quote({
      requested_identity: {
        provider_id: 'you-research',
        profile_id: 'research',
        target: {
          primary: {
            model_selection: 'configurable',
            kind: 'preset',
            target_id: 'ultra',
          },
        },
      },
    });
    expect(budgetEstimateFromQuote(quote)).toBeUndefined();
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
      'sha256:98894e5f129d8971df223e6a0778cbc2f2b9b165767fb1948df85c8bbfeddcfb',
    );
    expect(pricingSnapshotFingerprint(BUILTIN_PRICING_SNAPSHOT)).toBe(
      'sha256:98894e5f129d8971df223e6a0778cbc2f2b9b165767fb1948df85c8bbfeddcfb',
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

describe('dated rate windows', () => {
  const BOUNDARY = '2027-01-01T00:00:00.000Z';

  function perMillion(input: string, output: string): PriceRate[] {
    return [
      {
        unit: 'uncached_input_tokens',
        amount_decimal: input,
        per_decimal: '1000000',
      },
      { unit: 'output_tokens', amount_decimal: output, per_decimal: '1000000' },
    ];
  }

  function windowed(
    windows: readonly PriceRateWindow[],
    overrides: Partial<PriceDefinitionInput> = {},
  ): PriceDefinitionInput {
    return definition({ rates: [], rate_windows: windows, ...overrides });
  }

  /** Introductory rates until 2027, doubled from then: Gemini Flash's schedule. */
  const doubling = windowed([
    { effective_until: BOUNDARY, rates: perMillion('0.75', '3.75') },
    { effective_from: BOUNDARY, rates: perMillion('1.5', '7.5') },
  ]);

  function quoteAt(
    priced: Partial<Pick<PricingLookup, 'priced_at' | 'priced_until'>>,
    pricing: PriceDefinitionInput = doubling,
    quantities: Record<string, string> = {
      uncached_input_tokens: '1000000',
      output_tokens: '100000',
    },
  ) {
    return new PricingCatalog(snapshot([pricing])).quote({
      requested_identity: identity(),
      quantities,
      ...priced,
    });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [
      'overlap',
      [
        {
          effective_until: '2027-01-02T00:00:00.000Z',
          rates: perMillion('1', '1'),
        },
        { effective_from: BOUNDARY, rates: perMillion('2', '2') },
      ],
    ],
    [
      'gap',
      [
        { effective_until: BOUNDARY, rates: perMillion('1', '1') },
        {
          effective_from: '2027-01-02T00:00:00.000Z',
          rates: perMillion('2', '2'),
        },
      ],
    ],
    [
      'out of order',
      [
        { effective_from: BOUNDARY, rates: perMillion('2', '2') },
        { effective_until: BOUNDARY, rates: perMillion('1', '1') },
      ],
    ],
    [
      'open inner bound',
      [
        { rates: perMillion('1', '1') },
        { effective_from: BOUNDARY, rates: perMillion('2', '2') },
      ],
    ],
    [
      'different units',
      [
        { effective_until: BOUNDARY, rates: perMillion('1', '1') },
        { effective_from: BOUNDARY, rates: perMillion('2', '2').slice(0, 1) },
      ],
    ],
    [
      'inverted',
      [
        {
          effective_from: BOUNDARY,
          effective_until: BOUNDARY,
          rates: perMillion('1', '1'),
        },
      ],
    ],
    [
      'non-UTC bound',
      [
        {
          effective_until: '2027-01-01T00:00:00+00:00',
          rates: perMillion('1', '1'),
        },
      ],
    ],
    ['empty', []],
  ] as const)('rejects %s windows', (_label, windows) => {
    expect(() =>
      validatePricingSnapshot(snapshot([windowed(windows)])),
    ).toThrow(PricingCatalogError);
  });

  it('rejects rates beside windows and intervals that end before they start', () => {
    expect(() =>
      validatePricingSnapshot(
        snapshot([
          windowed(doubling.rate_windows ?? [], {
            rates: perMillion('1', '1'),
          }),
        ]),
      ),
    ).toThrow('carries its rates in its windows');
    expect(() =>
      quoteAt({
        priced_at: BOUNDARY,
        priced_until: '2026-12-31T00:00:00.000Z',
      }),
    ).toThrow('cannot end before it starts');
  });

  it('prices an instant at the window in effect, switching exactly at the boundary', () => {
    const lastMillisecond = quoteAt({ priced_at: '2026-12-31T23:59:59.999Z' });
    const firstInstant = quoteAt({ priced_at: BOUNDARY });

    expect(lastMillisecond.amount_decimal).toBe('1.125');
    expect(lastMillisecond.status).toBe('complete');
    expect(lastMillisecond.provenance?.rate_windows).toEqual([
      { effective_until: BOUNDARY },
    ]);
    expect(firstInstant.amount_decimal).toBe('2.25');
    expect(firstInstant.provenance?.rate_windows).toEqual([
      { effective_from: BOUNDARY },
    ]);
  });

  it('prices a computed actual cost at the time the request ran, or now', () => {
    const catalog = new PricingCatalog(snapshot([doubling]));
    const actual = (priced_at?: string) =>
      catalog.actual({
        requested_identity: identity(),
        provider_reported_units: {
          uncached_input_tokens: '1000000',
          output_tokens: '0',
        },
        ...(priced_at && { priced_at }),
      })?.amount_decimal;

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-01T01:00:00.000Z'));

    expect(actual('2026-12-31T23:00:00.000Z')).toBe('0.75');
    expect(actual()).toBe('1.5');
  });

  it('bounds an interval by the highest rate of each unit across every overlapping window', () => {
    // Input is dearest in the first window and output in the second, so
    // picking one whole window would understate one of them.
    const pricing = windowed([
      { effective_until: BOUNDARY, rates: perMillion('4', '1') },
      {
        effective_from: BOUNDARY,
        effective_until: '2027-02-01T00:00:00.000Z',
        rates: perMillion('2', '3'),
      },
      {
        effective_from: '2027-02-01T00:00:00.000Z',
        rates: perMillion('9', '9'),
      },
    ]);
    const quantities = {
      uncached_input_tokens: '1000000',
      output_tokens: '1000000',
    };
    const estimate = (priced_until: string) =>
      quoteAt(
        { priced_at: '2026-12-31T12:00:00.000Z', priced_until },
        pricing,
        quantities,
      );

    const spanning = estimate('2027-01-01T12:00:00.000Z');
    expect(spanning.amount_decimal).toBe('7');
    expect(spanning.known_maximum_decimal).toBe('7');
    expect(spanning.provenance?.rate_windows).toEqual([
      { effective_until: BOUNDARY },
      { effective_from: BOUNDARY, effective_until: '2027-02-01T00:00:00.000Z' },
    ]);
    expect(estimate(BOUNDARY).amount_decimal).toBe('5');
    expect(estimate('2027-02-01T00:00:00.001Z').amount_decimal).toBe('18');
  });

  it('bounds an interval that starts now when only the deadline is known', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-31T23:00:00.000Z'));

    expect(
      quoteAt({ priced_until: '2026-12-31T23:30:00.000Z' }).amount_decimal,
    ).toBe('1.125');
    expect(
      quoteAt({ priced_until: '2027-01-01T00:30:00.000Z' }).amount_decimal,
    ).toBe('2.25');
  });

  it('quotes unavailable instead of guessing outside the declared windows', () => {
    const bounded = windowed([
      {
        effective_from: '2026-01-01T00:00:00.000Z',
        effective_until: BOUNDARY,
        rates: perMillion('1', '1'),
      },
    ]);

    for (const priced of [
      { priced_at: '2025-12-31T23:59:59.999Z' },
      { priced_at: BOUNDARY },
      {
        priced_at: '2026-12-31T00:00:00.000Z',
        priced_until: '2027-01-01T00:00:00.001Z',
      },
    ]) {
      const quote = quoteAt(priced, bounded);
      expect(quote.status).toBe('unavailable');
      expect(quote.amount_decimal).toBeUndefined();
      expect(quote.confidence).toBe('unknown');
      expect(quote.missing_units).toEqual([
        'output_tokens',
        'uncached_input_tokens',
      ]);
      expect(budgetEstimateFromQuote(quote)).toBeUndefined();
    }
    expect(
      quoteAt(
        { priced_at: '2026-12-31T00:00:00.000Z', priced_until: BOUNDARY },
        bounded,
      ).amount_decimal,
    ).toBe('1.1');
  });

  it('resolves definitions without windows exactly as before, at any time', () => {
    // Pinned from release/v2-candidate before rate windows existed.
    expect(pricingSnapshotFingerprint(snapshot())).toBe(
      'sha256:6b198bde9bca55a646f57805e627b12a389da6c33695a071ba24e37fe7d17bf0',
    );
    expect(priceDefinitionFingerprint(definition())).toBe(
      'sha256:b040fb0628ef8f40339b15d29041aa6844006ffa4f108500921930759a6939e8',
    );
    const timeless = quoteAt({}, definition());
    expect(timeless.amount_decimal).toBe('0.55');
    expect(timeless.provenance).not.toHaveProperty('rate_windows');
    for (const priced of [
      { priced_at: '2020-01-01T00:00:00.000Z' },
      { priced_at: BOUNDARY, priced_until: '2031-01-01T00:00:00.000Z' },
      { priced_until: '2031-01-01T00:00:00.000Z' },
    ]) {
      expect(quoteAt(priced, definition())).toEqual(timeless);
    }
  });

  it('fingerprints window rates independently of their order', () => {
    const reordered = windowed(
      (doubling.rate_windows ?? []).map((window) => ({
        ...window,
        rates: [...window.rates].reverse(),
      })),
    );
    const changed = windowed([
      { effective_until: BOUNDARY, rates: perMillion('0.75', '3.75') },
      { effective_from: BOUNDARY, rates: perMillion('1.5', '7.51') },
    ]);

    expect(priceDefinitionFingerprint(reordered)).toBe(
      priceDefinitionFingerprint(doubling),
    );
    expect(pricingSnapshotFingerprint(snapshot([reordered]))).toBe(
      pricingSnapshotFingerprint(snapshot([doubling])),
    );
    expect(priceDefinitionFingerprint(changed)).not.toBe(
      priceDefinitionFingerprint(doubling),
    );
  });

  it.each([
    ['gemini-chat', 'chat'],
    ['gemini-grounded', 'grounded'],
  ])(
    "prices %s with Gemini 3.8 Flash at Google's introductory rates until 2027, then double",
    (providerId, profileId) => {
      const gemini = BUILTIN_PRICING_SNAPSHOT.definitions.find(
        ({ id }) => id === `${providerId}.${profileId}.gemini-3.8-flash`,
      );
      expect(gemini?.rates).toEqual([]);
      expect(gemini?.rate_windows).toEqual([
        {
          effective_until: BOUNDARY,
          rates: [
            {
              unit: 'uncached_input_tokens',
              amount_decimal: '0.75',
              per_decimal: '1000000',
            },
            {
              unit: 'output_tokens',
              amount_decimal: '3.75',
              per_decimal: '1000000',
            },
            {
              unit: 'cache_read_tokens',
              amount_decimal: '0.075',
              per_decimal: '1000000',
            },
            { unit: 'searches', amount_decimal: '14', per_decimal: '1000' },
          ],
        },
        {
          effective_from: BOUNDARY,
          rates: [
            {
              unit: 'uncached_input_tokens',
              amount_decimal: '1.5',
              per_decimal: '1000000',
            },
            {
              unit: 'output_tokens',
              amount_decimal: '7.5',
              per_decimal: '1000000',
            },
            {
              unit: 'cache_read_tokens',
              amount_decimal: '0.15',
              per_decimal: '1000000',
            },
            { unit: 'searches', amount_decimal: '14', per_decimal: '1000' },
          ],
        },
      ]);

      const catalog = new PricingCatalog(BUILTIN_PRICING_SNAPSHOT);
      const quote = (
        priced: Partial<Pick<PricingLookup, 'priced_at' | 'priced_until'>>,
      ) =>
        catalog.quote({
          requested_identity: identity(
            providerId,
            profileId,
            'gemini-3.8-flash',
          ),
          conditions: { account_plan: 'payg', billing_mode: 'standard' },
          quantities: {
            uncached_input_tokens: '2000000',
            output_tokens: '300000',
            cache_read_tokens: '50000',
            searches: '2',
          },
          ...priced,
        });

      expect(
        quote({ priced_at: '2026-12-31T23:59:59.999Z' }).amount_decimal,
      ).toBe('2.65675');
      expect(quote({ priced_at: BOUNDARY }).amount_decimal).toBe('5.2855');
      const acrossNewYear = quote({
        priced_at: '2026-12-31T23:00:00.000Z',
        priced_until: '2027-01-01T01:00:00.000Z',
      });
      expect(acrossNewYear.known_maximum_decimal).toBe('5.2855');
      expect(acrossNewYear.provenance?.rate_windows).toHaveLength(2);
    },
  );
});
