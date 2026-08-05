import type { ProviderTier } from '../types.js';
import { BUILTIN_PROVIDER_DEFINITIONS } from './provider-descriptor.js';

export interface ProviderCatalogEntry {
  id: string;
  family: string;
  displayName: string;
  envVar: string;
  tier: ProviderTier;
  description: string;
  bestFor: string;
  setupUrl: string;
  recommended?: boolean;
  order: number;
  aliases: readonly string[];
  defaultModel?: string;
}

export const PROVIDER_CATALOG: Record<string, ProviderCatalogEntry> =
  Object.fromEntries(
    BUILTIN_PROVIDER_DEFINITIONS.map((definition) => [
      definition.id,
      {
        id: definition.id,
        family: definition.display.family,
        displayName: definition.display.name,
        envVar: definition.credential.envVar,
        tier: definition.tier,
        description: definition.display.description,
        bestFor: definition.display.bestFor,
        setupUrl: definition.display.setupUrl,
        recommended: definition.display.recommended,
        order: definition.display.order,
        aliases: definition.aliases,
        defaultModel: definition.defaultModel,
      },
    ]),
  );

export function getProviderCatalogEntry(
  id: string,
): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG[id];
}

export function sortedProviderCatalogEntries(
  ids?: Iterable<string>,
): ProviderCatalogEntry[] {
  const allowed = ids ? new Set(ids) : undefined;
  return Object.values(PROVIDER_CATALOG)
    .filter((entry) => !allowed || allowed.has(entry.id))
    .sort(
      (a, b) => a.order - b.order || a.displayName.localeCompare(b.displayName),
    );
}

export function recommendedProviderCatalogEntries(): ProviderCatalogEntry[] {
  return sortedProviderCatalogEntries().filter((entry) => entry.recommended);
}

export function providerTierLabel(tier: ProviderTier): string {
  switch (tier) {
    case 'deep-research':
      return 'Deep research';
    case 'ai-grounded':
      return 'Grounded answers';
    case 'raw-search':
      return 'Raw search';
    case 'llm':
      return 'LLM answers';
  }
}
