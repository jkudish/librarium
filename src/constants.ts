declare const __VERSION__: string;

import {
  BUILTIN_PROVIDER_DEFINITIONS,
  BUILTIN_PROVIDER_DEFINITIONS_IN_REGISTRATION_ORDER,
} from './core/provider-descriptor.js';
import { retiredProviderReplacement } from './core/retired-provider-ids.js';

export const VERSION =
  typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.1.0';

export const APP_NAME = 'librarium';

// Config paths
export const CONFIG_FILE_MODE = 0o600;
export const PROJECT_CONFIG_FILE = `.${APP_NAME}.json`;

// Output
export const MAX_SLUG_LENGTH = 40;
export const DEFAULT_OUTPUT_DIR = `./agents/${APP_NAME}`;

// Timeouts (seconds)
export const DEFAULT_TIMEOUT = 30;
export const DEFAULT_ASYNC_TIMEOUT = 1800;
export const DEFAULT_ASYNC_POLL_INTERVAL = 10;
export const DEFAULT_MAX_PARALLEL = 6;

// HTTP
export const MAX_RETRIES = 3;
export const INITIAL_RETRY_DELAY_MS = 1000;
export const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB

// Provider environment variable names
export const PROVIDER_ENV_VARS: Record<string, string> = Object.fromEntries(
  BUILTIN_PROVIDER_DEFINITIONS_IN_REGISTRATION_ORDER.map(
    ({ id, credential }) => [id, credential.envVar],
  ),
);

// Provider display names
export const PROVIDER_DISPLAY_NAMES: Record<string, string> =
  Object.fromEntries(
    BUILTIN_PROVIDER_DEFINITIONS_IN_REGISTRATION_ORDER.map(
      ({ id, display }) => [id, display.name],
    ),
  );

// Backward-compatible provider ID aliases (legacy -> canonical)
export const PROVIDER_ID_ALIASES: Record<string, string> = Object.fromEntries(
  BUILTIN_PROVIDER_DEFINITIONS.flatMap(({ id, aliases }) =>
    aliases.map((alias) => [alias, id]),
  ),
);

/**
 * Resolve legacy provider IDs to canonical IDs.
 */
export function resolveProviderId(id: string): string {
  return PROVIDER_ID_ALIASES[id] ?? id;
}

/**
 * Resolve and deduplicate provider IDs while preserving input order.
 */
export function resolveProviderIds(ids: string[]): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const id of ids) {
    const canonicalId = resolveProviderId(id);
    if (!seen.has(canonicalId)) {
      seen.add(canonicalId);
      resolved.push(canonicalId);
    }
  }

  return resolved;
}

/**
 * A provider entry used for human-friendly name resolution. Kept minimal so
 * this module stays edge-safe (pure string logic, no registry import).
 */
export interface ProviderNameEntry {
  id: string;
  displayName: string;
}

/**
 * Normalize a provider token or display name for case- and
 * punctuation-insensitive matching: lowercase, then collapse runs of spaces,
 * hyphens, and underscores into a single space, trimming the ends. So
 * "Perplexity Sonar Pro", "perplexity-sonar-pro", and "perplexity  sonar_pro"
 * all normalize to the same key.
 */
export function normalizeProviderName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();
}

/**
 * Levenshtein edit distance between two strings. Hand-rolled to avoid a
 * dependency; used only to rank "did you mean" suggestions.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
    }
    [previous, current] = [current, previous];
  }

  return previous[b.length];
}

/**
 * Rank providers as "did you mean" suggestions for an unresolved token.
 * Substring containment is preferred (in either direction), then small edit
 * distance. Returns up to `limit` provider entries, best first.
 */
export function suggestProviders(
  token: string,
  providers: ProviderNameEntry[],
  limit = 3,
): ProviderNameEntry[] {
  const normalizedToken = normalizeProviderName(token);
  if (normalizedToken.length === 0) return [];

  const ranked = providers
    .map((provider) => {
      const candidates = [
        normalizeProviderName(provider.id),
        normalizeProviderName(provider.displayName),
      ];
      const contains = candidates.some(
        (candidate) =>
          candidate.includes(normalizedToken) ||
          normalizedToken.includes(candidate),
      );
      const distance = Math.min(
        ...candidates.map((candidate) =>
          editDistance(normalizedToken, candidate),
        ),
      );
      return { provider, contains, distance };
    })
    .sort((a, b) => {
      if (a.contains !== b.contains) return a.contains ? -1 : 1;
      return a.distance - b.distance;
    });

  // Drop wildly dissimilar non-containment matches so suggestions stay useful.
  return ranked
    .filter((entry) => entry.contains || entry.distance <= 5)
    .slice(0, limit)
    .map((entry) => entry.provider);
}

/** Outcome of resolving a single human-friendly provider token. */
export type ProviderTokenResolution =
  | { kind: 'id'; token: string; id: string }
  | { kind: 'alias'; token: string; id: string }
  | { kind: 'retired'; token: string; replacement: string }
  | { kind: 'name'; token: string; id: string }
  | { kind: 'ambiguous'; token: string; candidates: ProviderNameEntry[] }
  | { kind: 'unknown'; token: string; suggestions: ProviderNameEntry[] };

/**
 * Resolve a single token to a canonical provider id, accepting (in order):
 * exact canonical id, a rejected retired id, active alias, then case/punctuation-insensitive display
 * name. Returns a structured outcome so callers can warn (alias), error
 * (ambiguous / unknown), or proceed (id / name).
 *
 * Pure string logic over the supplied provider list, so this stays edge-safe.
 */
export function resolveProviderToken(
  token: string,
  providers: ProviderNameEntry[],
): ProviderTokenResolution {
  const trimmed = token.trim();
  const knownIds = new Set(providers.map((p) => p.id));

  // 1. Retired ids guide the caller but never resolve to an executable id,
  // even if a compromised provider index includes the old spelling.
  const replacement = retiredProviderReplacement(trimmed);
  if (replacement !== undefined) {
    return { kind: 'retired', token: trimmed, replacement };
  }

  // 2. Exact canonical id.
  if (knownIds.has(trimmed)) {
    return { kind: 'id', token: trimmed, id: trimmed };
  }

  // 3. Active alias (emits a deprecation warning).
  const aliased = PROVIDER_ID_ALIASES[trimmed];
  if (aliased !== undefined) {
    return { kind: 'alias', token: trimmed, id: aliased };
  }

  // 4. Case-insensitive display-name match with normalization.
  const normalizedToken = normalizeProviderName(trimmed);
  const nameMatches = providers.filter(
    (provider) =>
      normalizeProviderName(provider.displayName) === normalizedToken,
  );
  if (nameMatches.length === 1) {
    return { kind: 'name', token: trimmed, id: nameMatches[0].id };
  }
  if (nameMatches.length > 1) {
    return { kind: 'ambiguous', token: trimmed, candidates: nameMatches };
  }

  // 5. Nothing matched.
  return {
    kind: 'unknown',
    token: trimmed,
    suggestions: suggestProviders(trimmed, providers),
  };
}

/** Aggregate result of resolving a list of provider tokens. */
export interface ProviderTokensResult {
  /** Canonical, deduplicated provider ids (order-preserving). */
  ids: string[];
  /** Non-fatal warnings (e.g. legacy alias deprecation). */
  warnings: string[];
  /** Fatal error messages (ambiguous or unknown tokens). */
  errors: string[];
}

/**
 * Resolve a list of human-friendly provider tokens (canonical ids, legacy
 * active aliases, or display names) to canonical ids. Display-name matches are
 * a supported input form and emit no warning; ambiguous or unknown tokens
 * produce errors. Edge-safe pure string logic.
 */
export function resolveProviderTokens(
  tokens: string[],
  providers: ProviderNameEntry[],
): ProviderTokensResult {
  const ids: string[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  const errors: string[] = [];

  const push = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };

  for (const token of tokens) {
    const outcome = resolveProviderToken(token, providers);
    switch (outcome.kind) {
      case 'id':
      case 'name':
        push(outcome.id);
        break;
      case 'alias':
        warnings.push(
          `Provider ID "${outcome.token}" is deprecated; using "${outcome.id}"`,
        );
        push(outcome.id);
        break;
      case 'retired':
        errors.push(
          `Provider "${outcome.token}" was removed; use "${outcome.replacement}".`,
        );
        break;
      case 'ambiguous': {
        const candidateList = outcome.candidates
          .map((c) => `${c.id} (${c.displayName})`)
          .join(', ');
        errors.push(
          `Provider name "${outcome.token}" is ambiguous; matches: ${candidateList}. Use a canonical provider ID.`,
        );
        break;
      }
      case 'unknown': {
        let message = `Unknown provider: ${outcome.token}`;
        if (outcome.suggestions.length > 0) {
          const suggestionList = outcome.suggestions
            .map((s) => `${s.id} (${s.displayName})`)
            .join(', ');
          message += `. Did you mean: ${suggestionList}?`;
        }
        errors.push(message);
        break;
      }
    }
  }

  return { ids, warnings, errors };
}

// Default groups
export const DEFAULT_GROUPS: Record<string, string[]> = {
  deep: [
    'perplexity-sonar-deep',
    'perplexity-deep-research',
    'perplexity-advanced-deep',
    'openai-research',
    'gemini-deep',
  ],
  quick: [
    'gemini-grounded',
    'openrouter-online',
    'brave-answers',
    'exa',
    'kagi-fastgpt',
  ],
  raw: [
    'perplexity-search',
    'brave-search',
    'jina-search',
    'firecrawl-search',
    'searchapi',
    'serpapi',
    'tavily',
  ],
  fast: [
    'perplexity-sonar-pro',
    'gemini-grounded',
    'openrouter-online',
    'perplexity-search',
    'brave-answers',
    'exa',
    'kagi-fastgpt',
    'jina-search',
    'brave-search',
    'firecrawl-search',
    'tavily',
  ],
  visibility: [
    'searchapi-chatgpt',
    'searchapi-gemini',
    'searchapi-perplexity',
    'searchapi-google-ai-mode',
    'searchapi-bing-copilot',
    'searchapi-google-ai-overview',
    'perplexity-sonar-pro',
    'gemini-grounded',
    'grok',
  ],
  comprehensive: [
    'perplexity-sonar-deep',
    'perplexity-deep-research',
    'perplexity-advanced-deep',
    'openai-research',
    'gemini-deep',
    'perplexity-sonar-pro',
    'gemini-grounded',
    'grok',
    'grok-x-only',
    'grok-combined',
    'openrouter-online',
    'brave-answers',
    'exa',
    'you-research',
    'kagi-fastgpt',
    'searchapi-chatgpt',
    'searchapi-gemini',
    'searchapi-perplexity',
    'searchapi-google-ai-mode',
    'searchapi-bing-copilot',
    'searchapi-google-ai-overview',
    'perplexity-pro-search',
  ],
  // Generic LLMs (tier `llm`). Opt-in only: excluded from every default
  // grounded group above and from `all`. They can use provider web search and
  // citations by default, but remain separate from the grounded provider tier.
  llm: ['claude', 'openai-chat', 'gemini-chat', 'openrouter-chat'],
  // `all` is the explicit grounded-all roster (every registered grounded
  // provider). The `llm` tier is intentionally excluded -- it is opt-in via
  // `-p`, a custom group, or `--group llm`.
  all: [
    'perplexity-sonar-deep',
    'perplexity-deep-research',
    'perplexity-advanced-deep',
    'openai-research',
    'gemini-deep',
    'perplexity-sonar-pro',
    'gemini-grounded',
    'grok',
    'grok-x-only',
    'grok-combined',
    'openrouter-online',
    'brave-answers',
    'exa',
    'you-research',
    'kagi-fastgpt',
    'jina-search',
    'firecrawl-search',
    'perplexity-search',
    'brave-search',
    'searchapi',
    'serpapi',
    'tavily',
    'searchapi-chatgpt',
    'searchapi-gemini',
    'searchapi-perplexity',
    'searchapi-google-ai-mode',
    'searchapi-bing-copilot',
    'searchapi-google-ai-overview',
    'perplexity-pro-search',
  ],
};

/**
 * Validate explicit group policy against the built-in descriptor inventory.
 * Group membership remains a product decision, while drift (unknown IDs,
 * duplicates, wrong tier rosters, or a stale `all` group) fails immediately.
 */
export function validateDefaultGroups(
  groups: Record<string, readonly string[]> = DEFAULT_GROUPS,
): void {
  const definitions = new Map(
    BUILTIN_PROVIDER_DEFINITIONS.map((definition) => [
      definition.id,
      definition,
    ]),
  );

  for (const [group, members] of Object.entries(groups)) {
    const seen = new Set<string>();
    for (const id of members) {
      if (!definitions.has(id)) {
        throw new Error(`Default group "${group}" has unknown provider: ${id}`);
      }
      if (seen.has(id)) {
        throw new Error(`Default group "${group}" repeats provider: ${id}`);
      }
      seen.add(id);
    }
  }

  const assertTierGroup = (group: string, tier: string): void => {
    for (const id of groups[group] ?? []) {
      if (definitions.get(id)?.tier !== tier) {
        throw new Error(
          `Default group "${group}" contains non-${tier} provider: ${id}`,
        );
      }
    }
  };
  assertTierGroup('deep', 'deep-research');
  assertTierGroup('raw', 'raw-search');
  assertTierGroup('llm', 'llm');

  const expectedLlm = BUILTIN_PROVIDER_DEFINITIONS.filter(
    ({ tier }) => tier === 'llm',
  ).map(({ id }) => id);
  const expectedAll = BUILTIN_PROVIDER_DEFINITIONS.filter(
    ({ tier }) => tier !== 'llm',
  ).map(({ id }) => id);
  const sameMembers = (
    actual: readonly string[] | undefined,
    expected: string[],
  ) =>
    actual?.length === expected.length &&
    expected.every((id) => actual.includes(id));

  if (!sameMembers(groups.llm, expectedLlm)) {
    throw new Error('Default group "llm" must contain every LLM provider');
  }
  if (!sameMembers(groups.all, expectedAll)) {
    throw new Error(
      'Default group "all" must contain every non-LLM built-in provider',
    );
  }
}

validateDefaultGroups();

/**
 * Provider IDs in the `llm` tier. These are opt-in only: never auto-enabled by
 * `init --auto` and never pre-checked in interactive `init`. The default `run`
 * path (all enabled providers) therefore excludes them unless the user
 * explicitly enabled them in config.
 */
export const LLM_TIER_PROVIDER_IDS: ReadonlySet<string> = new Set(
  BUILTIN_PROVIDER_DEFINITIONS.filter(({ tier }) => tier === 'llm').map(
    ({ id }) => id,
  ),
);

/** True when the provider id belongs to the opt-in `llm` tier. */
export function isLlmTierProvider(id: string): boolean {
  return LLM_TIER_PROVIDER_IDS.has(resolveProviderId(id));
}

/** A provider option presented during `init`. */
export interface InitProviderChoice {
  id: string;
  envVar: string;
  /** Whether the matching env var is present in the environment. */
  keyPresent: boolean;
  /** Whether this provider is in the opt-in `llm` tier. */
  isLlm: boolean;
  /** Whether setup requires an explicit user selection for this provider. */
  isOptIn: boolean;
  /**
   * Whether `init --auto` should enable this provider, and whether interactive
   * `init` should pre-check it. True only when the key is present AND the
   * provider descriptor permits credential-based setup selection.
   */
  enableByDefault: boolean;
}

/**
 * Compute the per-provider init choices from the environment. Pure helper so
 * descriptor-owned opt-in policy is testable without driving the interactive
 * prompt. Order follows `PROVIDER_ENV_VARS`.
 */
export function computeInitProviderChoices(
  env: Record<string, string | undefined>,
): InitProviderChoice[] {
  return Object.entries(PROVIDER_ENV_VARS).map(([id, envVar]) => {
    const keyPresent = !!env[envVar];
    const isLlm = isLlmTierProvider(id);
    const definition = BUILTIN_PROVIDER_DEFINITIONS.find(
      (candidate) => candidate.id === id,
    );
    const isOptIn = definition?.credential.autoEnable === false;
    return {
      id,
      envVar,
      keyPresent,
      isLlm,
      isOptIn,
      enableByDefault: keyPresent && !isOptIn,
    };
  });
}

// Sanitize ID for filesystem
export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}
