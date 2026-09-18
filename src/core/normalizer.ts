import type { Citation, DeduplicatedSource } from '../types.js';

/**
 * Normalize a URL for deduplication:
 * - Strip protocol (http/https)
 * - Strip www.
 * - Strip trailing slashes
 * - Strip tracking params (utm_*, ref, fbclid, gclid, etc.)
 * - Lowercase hostname
 * - Ignore fragments, which only identify client-side document locations
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
    // Remove every case-insensitive UTM key, rather than only the common
    // names. Preserve other query parameters because they can select distinct
    // source content. Rebuild the parameters so deleting a key never skips
    // the next entry while URLSearchParams is being iterated. Fragments are
    // deliberately omitted below: they identify a location in a document,
    // not a separate source for deduplication.
    const trackingParams = new Set([
      'ref',
      'fbclid',
      'gclid',
      'msclkid',
      'mc_cid',
      'mc_eid',
    ]);
    const retainedParams = [...parsed.searchParams].filter(([key]) => {
      const normalized = key.toLowerCase();
      return !normalized.startsWith('utm_') && !trackingParams.has(normalized);
    });
    parsed.search = '';
    for (const [key, value] of retainedParams) {
      parsed.searchParams.append(key, value);
    }
    // Rebuild without protocol, strip trailing slash
    let normalized = `${parsed.host}${parsed.pathname}`;
    if (parsed.searchParams.toString()) {
      normalized += `?${parsed.searchParams.toString()}`;
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
