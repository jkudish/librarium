import { normalizeUrl } from '../core/normalizer.js';
import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider, type BaseProviderOptions } from './base.js';
import {
  formatPerplexitySearchOptionsError,
  type PerplexitySearchOptions,
  PerplexitySearchOptionsSchema,
} from './perplexity-search-options.js';

interface PerplexitySearchResult {
  url?: unknown;
  title?: unknown;
  snippet?: unknown;
  date?: string;
}

interface PerplexitySearchResponse {
  id: string;
  results?: PerplexitySearchResult[];
}

const SEARCH_API_URL = 'https://api.perplexity.ai/search';
const DEFAULT_MAX_RESULTS = 10;
const LEGACY_RENDERED_SNIPPET_LIMIT = 300;
const LEGACY_CITATION_SNIPPET_LIMIT = 200;
const MAX_UPSTREAM_RESULTS = 100;
const MAX_TITLE_CODE_POINTS = 512;
const MAX_RENDERED_SNIPPET_CODE_POINTS = 2_000;
const MAX_CITATION_SNIPPET_CODE_POINTS = 500;
const MAX_CONTENT_CODE_POINTS = 64_000;

export interface PerplexitySearchProviderOptions extends BaseProviderOptions {
  perRequestUsd?: unknown;
  maxResults?: unknown;
  country?: unknown;
  searchLanguageFilter?: unknown;
  searchDomainAllowlist?: unknown;
  searchDomainDenylist?: unknown;
  searchContextSize?: unknown;
  maxTokens?: unknown;
  maxTokensPerPage?: unknown;
  additionalQueries?: unknown;
}

interface NormalizedSearchResult {
  url: string;
  title?: string;
  snippet?: string;
}

/**
 * Perplexity Search API provider.
 * Returns raw ranked web search results with snippets and content extraction.
 * Tier: raw-search (sync)
 */
export class PerplexitySearchProvider extends BaseProvider {
  readonly id = 'perplexity-search';
  readonly tier: ProviderTier = 'raw-search';

  private readonly configuredOptions: Record<string, unknown>;

  constructor(options: PerplexitySearchProviderOptions = {}) {
    const {
      apiKey,
      credentials,
      httpClient,
      httpStreamClient,
      ...configuredOptions
    } = options;
    super({ apiKey, credentials, httpClient, httpStreamClient });
    this.configuredOptions = configuredOptions;
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const configured = PerplexitySearchOptionsSchema.safeParse(
      this.configuredOptions,
    );
    if (!configured.success) {
      return this.errorResult(
        Math.round(performance.now() - start),
        formatPerplexitySearchOptionsError(configured.error),
      );
    }

    try {
      const apiKey = this.getApiKey();
      const response = await this.request<PerplexitySearchResponse>(
        SEARCH_API_URL,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: this.requestBody(query, configured.data),
          timeout: options.timeout * 1000,
          signal: options.signal,
        },
      );

      const durationMs = Math.round(performance.now() - start);

      if (response.status !== 200) {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          error: this.formatError(response.status, response.data),
        };
      }

      const data = response.data;
      const results = Array.isArray(data.results) ? data.results : [];
      const enhanced = hasEnhancedOptions(configured.data);
      const normalized = enhanced
        ? this.normalizeEnhancedResults(results)
        : this.normalizeLegacyResults(results);
      const citations = this.extractCitations(normalized, enhanced);
      const content = this.buildContent(normalized, enhanced);

      return {
        provider: this.id,
        tier: this.tier,
        content,
        citations,
        durationMs,
      };
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      return {
        provider: this.id,
        tier: this.tier,
        content: '',
        citations: [],
        durationMs,
        error: this.formatCatchError(err),
      };
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const apiKey = this.getApiKey();
      const response = await this.request<PerplexitySearchResponse>(
        SEARCH_API_URL,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: {
            query: 'test',
            max_results: 1,
          },
          timeout: 10000,
        },
      );

      if (response.status === 200) return { ok: true };
      return { ok: false, error: `HTTP ${response.status}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private requestBody(
    baseQuery: string,
    options: PerplexitySearchOptions,
  ): Record<string, unknown> {
    const queries = buildQueries(baseQuery, options.additionalQueries);
    const body: Record<string, unknown> = {
      query: queries.length === 1 ? queries[0] : queries,
      max_results: options.maxResults ?? DEFAULT_MAX_RESULTS,
    };

    if (options.country) body.country = options.country;
    if (options.searchLanguageFilter) {
      body.search_language_filter = options.searchLanguageFilter;
    }
    if (options.searchDomainAllowlist) {
      body.search_domain_filter = options.searchDomainAllowlist;
    }
    if (options.searchDomainDenylist) {
      body.search_domain_filter = options.searchDomainDenylist.map(
        (domain) => `-${domain}`,
      );
    }
    if (options.searchContextSize) {
      body.search_context_size = options.searchContextSize;
    }
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (options.maxTokensPerPage !== undefined) {
      body.max_tokens_per_page = options.maxTokensPerPage;
    }

    // A query array remains one POST /search call (one billable request
    // estimate). Perplexity documents a separate rate-limit unit per query.
    return body;
  }

  private normalizeLegacyResults(
    results: PerplexitySearchResult[],
  ): NormalizedSearchResult[] {
    return results.flatMap((result) => {
      const url = textValue(result.url);
      if (!url) return [];
      return [
        {
          url,
          title: textValue(result.title),
          snippet: textValue(result.snippet),
        },
      ];
    });
  }

  private normalizeEnhancedResults(
    results: PerplexitySearchResult[],
  ): NormalizedSearchResult[] {
    const normalized: NormalizedSearchResult[] = [];
    const seenUrls = new Set<string>();

    for (const result of results.slice(0, MAX_UPSTREAM_RESULTS)) {
      const url = textValue(result.url);
      if (!url) continue;
      const key = normalizeUrl(url);
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      normalized.push({
        url,
        title: truncateCodePoints(
          textValue(result.title),
          MAX_TITLE_CODE_POINTS,
        ),
        snippet: truncateCodePoints(
          textValue(result.snippet),
          MAX_RENDERED_SNIPPET_CODE_POINTS,
        ),
      });
    }

    return normalized;
  }

  private buildContent(
    results: NormalizedSearchResult[],
    enhanced: boolean,
  ): string {
    if (results.length === 0) return 'No results found.';

    const parts: string[] = [];
    const snippetLimit = enhanced
      ? MAX_RENDERED_SNIPPET_CODE_POINTS
      : LEGACY_RENDERED_SNIPPET_LIMIT;

    for (const result of results) {
      const title = result.title ?? 'Untitled';
      parts.push(`- **[${title}](${result.url})**`);
      if (result.snippet) {
        parts.push(`  ${truncateCodePoints(result.snippet, snippetLimit)}`);
      }
    }

    return enhanced
      ? (truncateCodePoints(parts.join('\n'), MAX_CONTENT_CODE_POINTS) ?? '')
      : parts.join('\n');
  }

  private extractCitations(
    results: NormalizedSearchResult[],
    enhanced: boolean,
  ): Citation[] {
    const snippetLimit = enhanced
      ? MAX_CITATION_SNIPPET_CODE_POINTS
      : LEGACY_CITATION_SNIPPET_LIMIT;
    return results.map((result) => ({
      url: result.url,
      title: result.title,
      snippet: truncateCodePoints(result.snippet, snippetLimit),
      provider: this.id,
    }));
  }

  private errorResult(durationMs: number, error: string): ProviderResult {
    return {
      provider: this.id,
      tier: this.tier,
      content: '',
      citations: [],
      durationMs,
      error,
    };
  }
}

function buildQueries(
  baseQuery: string,
  additionalQueries?: string[],
): string[] {
  if (!additionalQueries) return [baseQuery];

  const queries = [baseQuery];
  const seen = new Set([baseQuery.trim()]);
  for (const candidate of additionalQueries) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    queries.push(candidate);
  }
  return queries;
}

function hasEnhancedOptions(options: PerplexitySearchOptions): boolean {
  return Object.keys(options).some((key) => key !== 'perRequestUsd');
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function truncateCodePoints(
  value: string | undefined,
  maximum: number,
): string | undefined {
  if (value === undefined) return undefined;
  const codePoints = Array.from(value);
  return codePoints.length <= maximum
    ? value
    : codePoints.slice(0, maximum).join('');
}
