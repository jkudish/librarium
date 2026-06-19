declare const __VERSION__: string;

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
export const PROVIDER_ENV_VARS: Record<string, string> = {
  'perplexity-sonar-deep': 'PERPLEXITY_API_KEY',
  'perplexity-deep-research': 'PERPLEXITY_API_KEY',
  'perplexity-advanced-deep': 'PERPLEXITY_API_KEY',
  'perplexity-sonar-pro': 'PERPLEXITY_API_KEY',
  'perplexity-search': 'PERPLEXITY_API_KEY',
  'openai-deep': 'OPENAI_API_KEY',
  'openai-deep-o3': 'OPENAI_API_KEY',
  'gemini-deep': 'GEMINI_API_KEY',
  'gemini-grounded': 'GEMINI_API_KEY',
  'openrouter-online': 'OPENROUTER_API_KEY',
  'you-research': 'YOU_COM_API_KEY',
  'jina-search': 'JINA_AI_API_KEY',
  'kagi-fastgpt': 'KAGI_API_KEY',
  'brave-answers': 'BRAVE_API_KEY',
  'brave-search': 'BRAVE_API_KEY',
  exa: 'EXA_API_KEY',
  searchapi: 'SEARCHAPI_API_KEY',
  serpapi: 'SERPAPI_API_KEY',
  tavily: 'TAVILY_API_KEY',
  'firecrawl-search': 'FIRECRAWL_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  'openai-chat': 'OPENAI_API_KEY',
  'gemini-chat': 'GEMINI_API_KEY',
  'openrouter-chat': 'OPENROUTER_API_KEY',
};

// Provider display names
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  'perplexity-sonar-deep': 'Perplexity Sonar Deep Research',
  'perplexity-deep-research': 'Perplexity Deep Research',
  'perplexity-advanced-deep': 'Perplexity Advanced Deep Research',
  'perplexity-sonar-pro': 'Perplexity Sonar Pro',
  'perplexity-search': 'Perplexity Search',
  'openai-deep': 'OpenAI Deep Research (o4-mini)',
  'openai-deep-o3': 'OpenAI Deep Research (o3)',
  'gemini-deep': 'Gemini Deep Research',
  'gemini-grounded': 'Gemini Grounded Search',
  'openrouter-online': 'OpenRouter Online Search',
  'you-research': 'You.com Research',
  'jina-search': 'Jina AI Search',
  'kagi-fastgpt': 'Kagi FastGPT',
  'brave-answers': 'Brave AI Answers',
  'brave-search': 'Brave Web Search',
  exa: 'Exa Search',
  searchapi: 'SearchAPI',
  serpapi: 'SerpAPI',
  tavily: 'Tavily Search',
  'firecrawl-search': 'Firecrawl Search',
  claude: 'Claude',
  'openai-chat': 'OpenAI Chat',
  'gemini-chat': 'Gemini Chat',
  'openrouter-chat': 'OpenRouter Chat',
};

// Backward-compatible provider ID aliases (legacy -> canonical)
export const PROVIDER_ID_ALIASES: Record<string, string> = {
  'perplexity-deep': 'perplexity-sonar-deep',
  'perplexity-sonar': 'perplexity-sonar-pro',
};

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
  | { kind: 'name'; token: string; id: string }
  | { kind: 'ambiguous'; token: string; candidates: ProviderNameEntry[] }
  | { kind: 'unknown'; token: string; suggestions: ProviderNameEntry[] };

/**
 * Resolve a single token to a canonical provider id, accepting (in order):
 * exact canonical id, legacy alias, then case/punctuation-insensitive display
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

  // 1. Exact canonical id.
  if (knownIds.has(trimmed)) {
    return { kind: 'id', token: trimmed, id: trimmed };
  }

  // 2. Legacy alias (existing behavior; emits a deprecation warning).
  const aliased = PROVIDER_ID_ALIASES[trimmed];
  if (aliased !== undefined) {
    return { kind: 'alias', token: trimmed, id: aliased };
  }

  // 3. Case-insensitive display-name match with normalization.
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

  // 4. Nothing matched.
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
 * aliases, or display names) to canonical ids. Display-name matches are a
 * supported input form and emit no warning; legacy aliases warn; ambiguous or
 * unknown tokens produce errors. Edge-safe pure string logic.
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
    'openai-deep',
    'openai-deep-o3',
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
  comprehensive: [
    'perplexity-sonar-deep',
    'perplexity-deep-research',
    'perplexity-advanced-deep',
    'openai-deep',
    'openai-deep-o3',
    'gemini-deep',
    'perplexity-sonar-pro',
    'gemini-grounded',
    'openrouter-online',
    'brave-answers',
    'exa',
    'you-research',
    'kagi-fastgpt',
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
    'openai-deep',
    'openai-deep-o3',
    'gemini-deep',
    'perplexity-sonar-pro',
    'gemini-grounded',
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
  ],
};

/**
 * Provider IDs in the `llm` tier. These are opt-in only: never auto-enabled by
 * `init --auto` and never pre-checked in interactive `init`. The default `run`
 * path (all enabled providers) therefore excludes them unless the user
 * explicitly enabled them in config.
 */
export const LLM_TIER_PROVIDER_IDS: ReadonlySet<string> = new Set(
  DEFAULT_GROUPS.llm,
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
  /**
   * Whether `init --auto` should enable this provider, and whether interactive
   * `init` should pre-check it. True only when the key is present AND the
   * provider is not in the opt-in `llm` tier.
   */
  enableByDefault: boolean;
}

/**
 * Compute the per-provider init choices from the environment. Pure helper so
 * the opt-in policy (llm-tier providers are never enabled/pre-checked by
 * default) is testable without driving the interactive prompt. Order follows
 * `PROVIDER_ENV_VARS`.
 */
export function computeInitProviderChoices(
  env: Record<string, string | undefined>,
): InitProviderChoice[] {
  return Object.entries(PROVIDER_ENV_VARS).map(([id, envVar]) => {
    const keyPresent = !!env[envVar];
    const isLlm = isLlmTierProvider(id);
    return {
      id,
      envVar,
      keyPresent,
      isLlm,
      enableByDefault: keyPresent && !isLlm,
    };
  });
}

// Sanitize ID for filesystem
export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}
