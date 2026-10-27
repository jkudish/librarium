/**
 * Provider ids that Librarium no longer accepts for current execution.
 *
 * This immutable tombstone is deliberately separate from active provider
 * aliases. It exists only for v1 migration, native-v2 rejection guidance, and
 * reservation of the old identities for custom providers.
 */
export const RETIRED_PROVIDER_REPLACEMENTS = Object.freeze({
  'perplexity-sonar': 'perplexity-sonar-pro',
  'perplexity-deep': 'perplexity-sonar-deep',
  'perplexity-pro-search': 'perplexity-sonar-pro',
  'perplexity-advanced-deep': 'perplexity-sonar-deep',
  'openai-deep': 'openai-research',
  'openai-deep-o3': 'openai-research',
} as const);

export type RetiredProviderId = keyof typeof RETIRED_PROVIDER_REPLACEMENTS;

interface UpstreamRetirement {
  /** Why the upstream service no longer exists, in safe display text. */
  readonly reason: string;
  /** Nearest current provider, offered as guidance only and never migrated. */
  readonly alternative: string;
  /** How the alternative differs, so callers can choose it deliberately. */
  readonly alternativeNote: string;
}

/**
 * Provider ids retired because their upstream API was withdrawn.
 *
 * Unlike RETIRED_PROVIDER_REPLACEMENTS these have no equivalent profile, so v1
 * migration never rewrites them; every current selector and native-v2 config
 * rejects them with guidance instead.
 */
export const RETIRED_UPSTREAM_PROVIDERS: Readonly<
  Record<string, UpstreamRetirement>
> = Object.freeze({
  'searchapi-perplexity': Object.freeze({
    reason:
      'SearchAPI deprecated its Perplexity engine (HTTP 503 "This API has been deprecated.") and offers no replacement',
    alternative: 'perplexity-sonar-pro',
    alternativeNote:
      'it returns a Perplexity API answer, not an observation of the Perplexity consumer surface',
  }),
});

export function retiredProviderReplacement(id: string): string | undefined {
  return Object.hasOwn(RETIRED_PROVIDER_REPLACEMENTS, id)
    ? RETIRED_PROVIDER_REPLACEMENTS[id as RetiredProviderId]
    : undefined;
}

function upstreamRetirement(id: string): UpstreamRetirement | undefined {
  return Object.hasOwn(RETIRED_UPSTREAM_PROVIDERS, id)
    ? RETIRED_UPSTREAM_PROVIDERS[id]
    : undefined;
}

/** True for a provider id retired upstream without a migration target. */
export function isRetiredUpstreamProviderId(id: string): boolean {
  return upstreamRetirement(id) !== undefined;
}

/** Every retired spelling, renamed or retired upstream; reserved forever. */
export const RETIRED_PROVIDER_IDS: readonly string[] = Object.freeze([
  ...Object.keys(RETIRED_PROVIDER_REPLACEMENTS),
  ...Object.keys(RETIRED_UPSTREAM_PROVIDERS),
]);

export function isRetiredProviderId(id: string): id is RetiredProviderId {
  return retiredProviderReplacement(id) !== undefined;
}

/**
 * Replaces only the provider-id segment of a provider/profile token.
 *
 * Qualified profile selectors remain exact during v1 migration and native-v2
 * diagnostics, so their suffix must never be discarded.
 */
export function retiredProviderTokenReplacement(
  token: string,
): string | undefined {
  const [providerId, ...suffix] = token.split('/');
  const replacement = providerId
    ? retiredProviderReplacement(providerId)
    : undefined;
  return replacement === undefined
    ? undefined
    : [replacement, ...suffix].join('/');
}

/** True for any retired spelling, including ids retired upstream. */
export function isRetiredProviderToken(token: string): boolean {
  return (
    retiredProviderTokenReplacement(token) !== undefined ||
    isRetiredUpstreamProviderId(token.split('/')[0] ?? '')
  );
}

/** v1-only canonicalization. Current selectors must not call this helper. */
export function migrateRetiredProviderId(id: string): string {
  return retiredProviderReplacement(id) ?? id;
}

/** v1-only canonicalization that preserves a qualified profile suffix. */
export function migrateRetiredProviderToken(token: string): string {
  return retiredProviderTokenReplacement(token) ?? token;
}

/** Canonical > openai-deep-o3 > openai-deep, independent of input order. */
export function retiredProviderMigrationPriority(
  id: string,
  canonical: string,
): number {
  if (id === canonical) return 0;
  if (canonical === 'openai-research' && id === 'openai-deep-o3') return 1;
  if (canonical === 'openai-research' && id === 'openai-deep') return 2;
  return 1;
}

export function retiredProviderGuidance(token: string): string | undefined {
  const providerId = token.split('/')[0] ?? '';
  const upstream = upstreamRetirement(providerId);
  if (upstream) {
    return `Provider "${providerId}" was retired upstream: ${upstream.reason}. It is not replaced automatically; "${upstream.alternative}" is the nearest alternative, but ${upstream.alternativeNote}.`;
  }
  const replacement = retiredProviderTokenReplacement(token);
  return replacement
    ? token.split('/')[0] === 'perplexity-pro-search'
      ? 'Perplexity provider "perplexity-pro-search" was migrated to "perplexity-sonar-pro/grounded"; legacy search_type "pro" now uses Agent preset "low".'
      : `Provider "${token}" was removed; use "${replacement}".`
    : undefined;
}
