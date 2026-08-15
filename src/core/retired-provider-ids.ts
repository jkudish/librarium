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

export function retiredProviderReplacement(id: string): string | undefined {
  return Object.hasOwn(RETIRED_PROVIDER_REPLACEMENTS, id)
    ? RETIRED_PROVIDER_REPLACEMENTS[id as RetiredProviderId]
    : undefined;
}

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

export function isRetiredProviderToken(token: string): boolean {
  return retiredProviderTokenReplacement(token) !== undefined;
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
  const replacement = retiredProviderTokenReplacement(token);
  return replacement
    ? token.split('/')[0] === 'perplexity-pro-search'
      ? 'Perplexity provider "perplexity-pro-search" was migrated to "perplexity-sonar-pro/grounded"; legacy search_type "pro" now uses Agent preset "low".'
      : `Provider "${token}" was removed; use "${replacement}".`
    : undefined;
}
