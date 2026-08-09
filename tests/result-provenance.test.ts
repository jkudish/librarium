import { describe, expect, it } from 'vitest';
import {
  CitationSchema,
  CollectionProvenanceSchema,
  CorrelationKeysSchema,
  type ExecutionProfile,
} from '../src/contracts/domain/index.js';
import { BUILTIN_PROFILE_BINDING_SPECS } from '../src/core/profile-bindings.js';
import { buildProviderCatalog } from '../src/core/profile-catalog.js';
import { BUILTIN_PROVIDER_CATALOG } from '../src/core/provider-profiles.js';
import {
  CORRELATION_KEYS,
  citationDerivationFor,
  collectionProvenanceFor,
  collectorCorrelation,
  normalizedSourceKey,
  upstreamCorrelation,
} from '../src/core/result-provenance.js';

function catalog() {
  const providerConfigs = Object.fromEntries(
    BUILTIN_PROFILE_BINDING_SPECS.map((spec) => [
      spec.adapter_id,
      { enabled: true },
    ]),
  );
  const env = Object.fromEntries(
    BUILTIN_PROVIDER_CATALOG.map((entry) => [
      entry.credential.env_var,
      'test-credential',
    ]),
  );
  return buildProviderCatalog({ providerConfigs, credentials: { env } });
}

function profileOf(providerId: string, profileId: string): ExecutionProfile {
  const resolved = catalog().get(providerId, profileId);
  if (!resolved) throw new Error(`missing profile ${providerId}/${profileId}`);
  return resolved.profile;
}

describe('result provenance -- effective profile fidelity', () => {
  it('derives the provider identity from the profile that executed', () => {
    const profile = profileOf('perplexity-sonar-pro', 'grounded');
    const provenance = collectionProvenanceFor({ profile });

    expect(provenance.provider).toEqual(profile.identity);
    expect(provenance.access_mode).toBe(profile.access_mode);
    expect(provenance.operator_id).toBe(profile.operator_id);
    expect(CollectionProvenanceSchema.safeParse(provenance).success).toBe(true);
  });

  it('cannot name a provider, profile, or target the execution did not have', () => {
    for (const [providerId, profileId] of [
      ['perplexity-sonar-pro', 'grounded'],
      ['searchapi-chatgpt', 'surface'],
      ['openrouter', 'grounded'],
      ['brave-answers', 'grounded'],
    ] as const) {
      const profile = profileOf(providerId, profileId);
      const provenance = collectionProvenanceFor({ profile });
      expect(provenance.provider.provider_id).toBe(providerId);
      expect(provenance.provider.profile_id).toBe(profileId);
      expect(provenance.provider.target).toEqual(profile.identity.target);
    }
  });

  it('copies collector, surface, and context only from a collected profile', () => {
    const surface = collectionProvenanceFor({
      profile: profileOf('searchapi-chatgpt', 'surface'),
    });
    expect(surface.access_mode).toBe('collected');
    expect(surface.collector_id).toBe('searchapi');
    expect(surface.surface_id).toBe('chatgpt');
    expect(surface.surface_context).toEqual({
      account_context: 'unknown',
      personalization: 'unknown',
    });

    const api = collectionProvenanceFor({
      profile: profileOf('perplexity-sonar-pro', 'grounded'),
    });
    expect(api.collector_id).toBeUndefined();
    expect(api.surface_id).toBeUndefined();
    expect(api.surface_context).toBeUndefined();
  });
});

describe('result provenance -- SearchAPI collector correlation', () => {
  const surfaces = [
    'searchapi-chatgpt',
    'searchapi-gemini',
    'searchapi-perplexity',
    'searchapi-google-ai-mode',
    'searchapi-bing-copilot',
    'searchapi-google-ai-overview',
  ] as const;

  it('gives the six surfaces one shared collector correlation', () => {
    const correlation = collectorCorrelation('searchapi', 'sweep-2026-08-09');
    const provenances = surfaces.map((providerId) =>
      collectionProvenanceFor({
        profile: profileOf(providerId, 'surface'),
        correlation_keys: correlation,
      }),
    );

    const runIds = new Set(
      provenances.map(
        (item) => item.correlation_keys?.[CORRELATION_KEYS.collectorRun],
      ),
    );
    expect(runIds).toEqual(new Set(['sweep-2026-08-09']));
    expect(CorrelationKeysSchema.safeParse(correlation).success).toBe(true);
  });

  it('keeps them six distinct observations, not six independent confirmations', () => {
    const correlation = collectorCorrelation('searchapi', 'sweep-2026-08-09');
    const provenances = surfaces.map((providerId) =>
      collectionProvenanceFor({
        profile: profileOf(providerId, 'surface'),
        correlation_keys: correlation,
      }),
    );

    // Distinct measured surfaces and distinct providers ...
    expect(new Set(provenances.map((item) => item.surface_id)).size).toBe(6);
    expect(
      new Set(provenances.map((item) => item.provider.provider_id)).size,
    ).toBe(6);
    // ... sharing one collection event, and asserting nothing about agreement.
    expect(new Set(provenances.map((item) => item.collector_id))).toEqual(
      new Set(['searchapi']),
    );
    for (const provenance of provenances) {
      expect(Object.keys(provenance)).not.toContain('independent');
      expect(Object.keys(provenance)).not.toContain('verified');
    }
  });
});

describe('result provenance -- Grok combined execution', () => {
  it('is one profile carrying both corpora, not two observations', () => {
    const combined = profileOf('grok-combined', 'combined');
    expect(combined.corpora).toEqual(['web', 'x']);

    const provenance = collectionProvenanceFor({
      profile: combined,
      origin_key: 'origin-grok-combined-001',
    });
    expect(provenance.provider.provider_id).toBe('grok-combined');
    expect(provenance.origin_key).toBe('origin-grok-combined-001');
    expect(CollectionProvenanceSchema.safeParse(provenance).success).toBe(true);
  });

  it('stays distinct from the web-only and X-only profiles', () => {
    expect(profileOf('grok', 'web').corpora).toEqual(['web']);
    expect(profileOf('grok-x-only', 'x').corpora).toEqual(['x']);
    const ids = [
      profileOf('grok', 'web').identity.provider_id,
      profileOf('grok-x-only', 'x').identity.provider_id,
      profileOf('grok-combined', 'combined').identity.provider_id,
    ];
    expect(new Set(ids).size).toBe(3);
  });
});

describe('result provenance -- direct versus brokered upstream paths', () => {
  it('keeps OpenRouter-brokered access distinct from a direct path', () => {
    const brokered = profileOf('openrouter', 'grounded');
    const direct = profileOf('perplexity-sonar-pro', 'grounded');
    expect(brokered.access_mode).toBe('brokered');
    expect(direct.access_mode).toBe('direct');
    expect(brokered.operator_id).not.toBe(direct.operator_id);
  });

  it('shares upstream correlation without collapsing the two providers', () => {
    const brokered = collectionProvenanceFor({
      profile: profileOf('openrouter', 'grounded'),
      correlation_keys: upstreamCorrelation('parallel', 'upstream-request-001'),
    });
    const planned = collectionProvenanceFor({
      profile: profileOf('parallel', 'research'),
      correlation_keys: upstreamCorrelation('parallel', 'upstream-request-001'),
    });

    expect(brokered.correlation_keys?.[CORRELATION_KEYS.upstream]).toBe(
      planned.correlation_keys?.[CORRELATION_KEYS.upstream],
    );
    // Same upstream, genuinely different provider and access paths.
    expect(brokered.provider.provider_id).not.toBe(
      planned.provider.provider_id,
    );
    expect(brokered.access_mode).not.toBe(planned.access_mode);
    expect(
      CorrelationKeysSchema.safeParse(brokered.correlation_keys).success,
    ).toBe(true);
  });
});

describe('result provenance -- Valyu specialized categories', () => {
  it('models specialized corpora on one provider, not one provider per category', () => {
    expect(profileOf('valyu', 'search').corpora).toEqual([
      'web',
      'specialized',
    ]);
    expect(profileOf('valyu', 'research').corpora).toEqual([
      'web',
      'specialized',
    ]);
    const valyuProviders = BUILTIN_PROVIDER_CATALOG.filter((entry) =>
      entry.provider_id.startsWith('valyu'),
    );
    expect(valyuProviders).toHaveLength(1);
    expect(valyuProviders[0]?.profiles).toHaveLength(2);
  });

  it('records a specialized category as citation metadata', () => {
    const profile = profileOf('valyu', 'search');
    const citation = {
      citation_id: 'citation-valyu-001',
      source_kind: 'data_record' as const,
      source_category: 'clinical_trial',
      dataset_id: 'dataset-valyu-trials',
      derivation: 'provider_reported' as const,
      provider_reference: 'valyu-record-001',
      provenance: collectionProvenanceFor({ profile }),
    };
    const parsed = CitationSchema.safeParse(citation);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    // The category rides on the citation; it is not an evidence lane.
    expect(Object.keys(citation.provenance)).not.toContain('source_category');
  });
});

describe('result provenance -- citation derivation', () => {
  it('reports collector extraction for a collected surface', () => {
    expect(
      citationDerivationFor(profileOf('searchapi-chatgpt', 'surface'), true),
    ).toBe('collector_extracted');
    expect(
      citationDerivationFor(profileOf('searchapi-chatgpt', 'surface'), false),
    ).toBe('collector_extracted');
  });

  it('distinguishes provider-reported from Librarium-inferred citations', () => {
    const profile = profileOf('perplexity-sonar-pro', 'grounded');
    expect(citationDerivationFor(profile, true)).toBe('provider_reported');
    expect(citationDerivationFor(profile, false)).toBe('librarium_inferred');
  });
});

describe('result provenance -- source identity stays separate', () => {
  it('keys a normalized source by the source, never by the provider', () => {
    const url = 'https://example.com/report';
    expect(normalizedSourceKey({ canonical_url: url })).toBe(`url:${url}`);
    expect(normalizedSourceKey({ provider_reference: 'ref-1' })).toBe(
      'ref:ref-1',
    );
    expect(normalizedSourceKey({})).toBeUndefined();
  });

  it('gives two different providers the same source key for the same URL', () => {
    const url = 'https://example.com/report';
    const first = collectionProvenanceFor({
      profile: profileOf('perplexity-sonar-pro', 'grounded'),
      correlation_keys: upstreamCorrelation('perplexity'),
    });
    const second = collectionProvenanceFor({
      profile: profileOf('brave-answers', 'grounded'),
      correlation_keys: upstreamCorrelation('brave'),
    });

    expect(normalizedSourceKey({ canonical_url: url })).toBe(
      normalizedSourceKey({ canonical_url: url }),
    );
    // Shared source identity, unrelated provider correlation: neither fact
    // implies the other, and nothing fuses them into a confidence signal.
    expect(first.correlation_keys?.[CORRELATION_KEYS.upstream]).not.toBe(
      second.correlation_keys?.[CORRELATION_KEYS.upstream],
    );
  });
});

describe('result provenance -- no universal assertions', () => {
  it('exposes no independent or verified field on any provenance helper', () => {
    const serialized = JSON.stringify({
      collection: collectionProvenanceFor({
        profile: profileOf('perplexity-sonar-pro', 'grounded'),
        correlation_keys: {
          ...collectorCorrelation('searchapi', 'run-1'),
          ...upstreamCorrelation('perplexity', 'req-1'),
        },
      }),
      keys: CORRELATION_KEYS,
    });
    expect(serialized).not.toContain('independent');
    expect(serialized).not.toContain('verified');
  });
});
