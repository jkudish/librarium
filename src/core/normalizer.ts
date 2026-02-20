import type { Citation, DeduplicatedSource } from '../types.js';

/**
 * Normalize a URL for deduplication:
 * - Strip protocol (http/https)
 * - Strip www.
 * - Strip trailing slashes
 * - Strip tracking params (utm_*, ref, fbclid, gclid, etc.)
 * - Lowercase hostname
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Lowercase hostname
    parsed.hostname = parsed.hostname.toLowerCase();
    // Strip www.
    if (parsed.hostname.startsWith('www.')) {
      parsed.hostname = parsed.hostname.slice(4);
    }
    // Strip tracking params
    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'ref',
      'fbclid',
      'gclid',
      'msclkid',
      'mc_cid',
      'mc_eid',
    ];
    for (const param of trackingParams) {
      parsed.searchParams.delete(param);
    }
    // Rebuild without protocol, strip trailing slash
    let normalized = `${parsed.hostname}${parsed.pathname}`;
    if (parsed.searchParams.toString()) {
      normalized += `?${parsed.searchParams.toString()}`;
    }
    if (parsed.hash) {
      normalized += parsed.hash;
    }
    return normalized.replace(/\/+$/, '');
  } catch {
    return url.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Deduplicate citations across all providers.
 * Returns sorted by citation count (descending).
 */
export function deduplicateSources(
  citations: Citation[],
): DeduplicatedSource[] {
  const map = new Map<string, DeduplicatedSource>();

  for (const citation of citations) {
    if (!citation.url) continue;
    const normalized = normalizeUrl(citation.url);
    const existing = map.get(normalized);

    if (existing) {
      existing.citationCount++;
      if (!existing.providers.includes(citation.provider)) {
        existing.providers.push(citation.provider);
      }
      if (!existing.title && citation.title) {
        existing.title = citation.title;
      }
    } else {
      map.set(normalized, {
        url: citation.url,
        normalizedUrl: normalized,
        title: citation.title,
        providers: [citation.provider],
        citationCount: 1,
      });
    }
  }

  return Array.from(map.values()).sort(
    (a, b) => b.citationCount - a.citationCount,
  );
}
