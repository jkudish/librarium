/**
 * Deterministic change detection for the frozen provider catalog.
 *
 * This is a fingerprint, not a security digest: it exists so two runtimes can
 * agree on whether they compiled the same catalog, and so a stale plan can be
 * spotted. It is not collision-resistant and must never be used to authenticate
 * catalog content. The contract only requires `digest` to be a bounded opaque
 * identifier, so no cryptographic primitive is implied.
 *
 * The algorithm is 64-bit FNV-1a over canonical JSON, emitted with an explicit
 * versioned prefix so the scheme can change without silently reinterpreting old
 * values. It is synchronous, dependency-free, Workers-safe (no `node:crypto`,
 * no Web Crypto), and small enough for the PHP side to mirror exactly.
 */

export const CATALOG_FINGERPRINT_ALGORITHM = 'fnv1a64';
export const CATALOG_FINGERPRINT_VERSION = 1;
export const CATALOG_FINGERPRINT_PREFIX =
  `${CATALOG_FINGERPRINT_ALGORITHM}.${CATALOG_FINGERPRINT_VERSION}:` as const;

const FNV_64_OFFSET_BASIS = 0xcbf2_9ce4_8422_2325n;
const FNV_64_PRIME = 0x0000_0100_0000_01b3n;
const UINT64_MASK = 0xffff_ffff_ffff_ffffn;

/**
 * Canonical JSON: object keys sorted, array order preserved, `undefined`
 * omitted. Key sorting is what makes the fingerprint independent of the order
 * in which catalog fields were assembled; array order stays significant because
 * roster and corpora order is itself a catalog fact.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }

  if (typeof value === 'bigint') return `"${value.toString()}"`;
  if (value === undefined) return 'null';
  return JSON.stringify(value) ?? 'null';
}

function fnv1a64(text: string): bigint {
  const bytes = new TextEncoder().encode(text);
  let hash = FNV_64_OFFSET_BASIS;
  for (const byte of bytes) {
    hash = (hash ^ BigInt(byte)) & UINT64_MASK;
    hash = (hash * FNV_64_PRIME) & UINT64_MASK;
  }
  return hash;
}

/** `fnv1a64.1:` followed by exactly 16 lower-case hex characters. */
export function catalogFingerprint(value: unknown): string {
  const hex = fnv1a64(canonicalJson(value)).toString(16).padStart(16, '0');
  return `${CATALOG_FINGERPRINT_PREFIX}${hex}`;
}

const FINGERPRINT_PATTERN = new RegExp(
  `^${CATALOG_FINGERPRINT_ALGORITHM}\\.${CATALOG_FINGERPRINT_VERSION}:[0-9a-f]{16}$`,
);

export function isCatalogFingerprint(value: string): boolean {
  return FINGERPRINT_PATTERN.test(value);
}
