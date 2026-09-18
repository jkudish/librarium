import type { SourceKind } from '../contracts/domain/citation.js';

/**
 * Classify a cited URL only when its identity makes the source kind clear.
 *
 * A retrieval profile is not source metadata. In particular, a combined
 * search result cannot make a non-X URL an X post (or vice versa).
 */
export function classifySourceKindFromUrl(url: string): SourceKind {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'unknown';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'unknown';
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (
    host === 'x.com' ||
    host === 'twitter.com' ||
    host === 'mobile.twitter.com'
  ) {
    const path = parsed.pathname;
    return /^\/i\/status\/\d+(?=\/|$)/i.test(path) ||
      /^\/[^/]+\/status\/\d+(?=\/|$)/i.test(path)
      ? 'x_post'
      : 'unknown';
  }

  return 'web_page';
}
