import type {
  CitationDerivation,
  CollectionProvenance,
  CorrelationKeys,
  ExecutionProfile,
} from '../contracts/domain/index.js';

/**
 * Descriptive provenance for what actually happened.
 *
 * Catalog declarations describe *possible* execution. Everything here describes
 * a real attempt: which provider and profile ran, which target the provider
 * reported, what was actually retrieved, who collected it, and how the run
 * correlates with others. Nothing in this module infers a fact it was not
 * given, and nothing here ever serialises a universal `independent` or
 * `verified` assertion -- those claims are not derivable from provenance and
 * the contract has no field for them.
 */

/** Namespaced correlation keys, mirroring `CorrelationKeysSchema`. */
export const CORRELATION_KEYS = {
  /** Shared by every profile a single collector observed in one sweep. */
  collectorRun: 'build.librarium:collectorRunId',
  /** Identifies the collector operating the observation. */
  collector: 'build.librarium:collectorId',
  /** Shared by execution paths that reach the same upstream provider. */
  upstream: 'build.librarium:upstreamProviderId',
  /** The upstream provider's own public request reference, when reported. */
  upstreamRequest: 'build.librarium:upstreamRequestId',
} as const;

export interface CollectionProvenanceInput {
  /** The profile that actually executed; the provider is derived from it. */
  readonly profile: ExecutionProfile;
  /** A public, non-secret origin reference for this exact retrieval. */
  readonly origin_key?: string;
  readonly correlation_keys?: CorrelationKeys;
}

/** Own and freeze plain provenance data so later caller mutation cannot alter it. */
function ownFrozen<T>(value: T): T {
  const owned = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== 'object' || Object.isFrozen(item)) {
      return;
    }
    Object.freeze(item);
    for (const child of Object.values(item)) freeze(child);
  };
  freeze(owned);
  return owned;
}

/**
 * Build collection provenance from the profile that actually executed.
 *
 * The provider identity is derived from the effective profile rather than
 * accepted alongside it, so provenance can never name a provider, profile, or
 * target the execution profile did not have. Access mode, operator, collector,
 * surface, and surface context are copied for the same reason.
 */
export function collectionProvenanceFor(
  input: CollectionProvenanceInput,
): CollectionProvenance {
  const { profile } = input;
  return ownFrozen({
    provider: profile.identity,
    access_mode: profile.access_mode,
    operator_id: profile.operator_id,
    ...(profile.collector_id !== undefined && {
      collector_id: profile.collector_id,
    }),
    ...(profile.surface_id !== undefined && {
      surface_id: profile.surface_id,
    }),
    ...(profile.surface_context !== undefined && {
      surface_context: profile.surface_context,
    }),
    ...(input.origin_key !== undefined && { origin_key: input.origin_key }),
    ...(input.correlation_keys !== undefined && {
      correlation_keys: input.correlation_keys,
    }),
  });
}

/**
 * Correlation for a collector sweep.
 *
 * The six SearchAPI surfaces are collected by one operator in one pass. They
 * share a collector correlation key so downstream consumers can see one
 * collection event behind six observations instead of reading them as six
 * independent confirmations. This is correlation only: it never merges the
 * observations, and it never implies agreement between them.
 */
export function collectorCorrelation(
  collectorId: string,
  collectorRunId: string,
): CorrelationKeys {
  return {
    [CORRELATION_KEYS.collector]: collectorId,
    [CORRELATION_KEYS.collectorRun]: collectorRunId,
  };
}

/**
 * Correlation for two access paths that reach the same upstream provider.
 *
 * A direct provider call and the same provider reached through a broker are
 * genuinely different provider/access paths -- different `provider_id`,
 * different `access_mode`, different metering -- but they share upstream
 * identity. The shared key records that relationship without collapsing the
 * two paths into one provider.
 */
export function upstreamCorrelation(
  upstreamProviderId: string,
  upstreamRequestId?: string,
): CorrelationKeys {
  return {
    [CORRELATION_KEYS.upstream]: upstreamProviderId,
    ...(upstreamRequestId !== undefined && {
      [CORRELATION_KEYS.upstreamRequest]: upstreamRequestId,
    }),
  };
}

/**
 * Citation derivation is only ever asserted when it is known.
 *
 * `provider_reported` means the provider returned the citation; on a collected
 * surface the collector extracted it, which is `collector_extracted`; anything
 * Librarium worked out itself is `librarium_inferred`. There is no default and
 * no guess: callers that do not know must say so at the call site.
 */
export function citationDerivationFor(
  profile: ExecutionProfile,
  reportedByProvider: boolean,
): CitationDerivation {
  if (profile.observation_mode === 'surface_snapshot') {
    return 'collector_extracted';
  }
  return reportedByProvider ? 'provider_reported' : 'librarium_inferred';
}

export interface SourceIdentityInput {
  readonly canonical_url?: string;
  readonly provider_reference?: string;
}

/**
 * Normalized source identity, kept strictly separate from provider correlation.
 *
 * Two providers citing the same URL share a normalized source; that is a
 * statement about the source, not about the providers. Provider correlation
 * says two *retrievals* are related; neither implies the other, and the two
 * facts are never fused into a single confidence signal.
 */
export function normalizedSourceKey(
  input: SourceIdentityInput,
): string | undefined {
  if (input.canonical_url !== undefined) return `url:${input.canonical_url}`;
  if (input.provider_reference !== undefined) {
    return `ref:${input.provider_reference}`;
  }
  return undefined;
}
