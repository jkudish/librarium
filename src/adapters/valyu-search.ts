import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider } from './base.js';
import type { ValyuSearchOptions } from './valyu-options.js';

interface ValyuSearchResult {
  id?: string;
  title?: string;
  url?: string;
  content?: string;
  description?: string;
  source?: string;
  price?: number;
  length?: number;
  relevance_score?: number;
  source_type?: string;
  publication_date?: string;
  doi?: string;
  authors?: string[];
  citation?: string;
  citation_count?: number;
}

interface ValyuSearchResponse {
  success: boolean;
  error?: string | null;
  tx_id?: string;
  query?: string;
  results?: ValyuSearchResult[];
  results_by_source?: Record<string, number>;
  total_deduction_dollars?: number;
  total_characters?: number;
  warnings?: string[];
}

function publicationTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function safeHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

function sourceKind(
  sourceType: string | undefined,
  searchType: ValyuSearchOptions['searchType'],
): Citation['sourceKind'] {
  if (searchType === 'news' || sourceType === 'news') return 'news_article';
  if (sourceType === 'video') return 'video';
  if (sourceType === 'forum') return 'forum_post';
  return 'web_page';
}

export class ValyuSearchProvider extends BaseProvider {
  readonly id = 'valyu-search';
  readonly tier: ProviderTier = 'raw-search';
  readonly options: ValyuSearchOptions;

  constructor(options: ValyuSearchOptions = {}) {
    super();
    this.options = options;
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    try {
      const response = await this.request<ValyuSearchResponse>(
        'https://api.valyu.ai/v1/search',
        {
          method: 'POST',
          headers: { 'X-API-Key': this.getApiKey() },
          body: this.requestBody(query),
          timeout: options.timeout * 1_000,
          signal: options.signal,
        },
      );
      const durationMs = Math.round(performance.now() - start);
      if (response.status !== 200 && response.status !== 206) {
        return this.failure(
          durationMs,
          this.formatError(response.status, response.data),
        );
      }
      const data = response.data;
      if (!data.success) {
        return this.failure(durationMs, data.error || 'Valyu search failed.');
      }
      const results = (data.results ?? []).filter(
        (result): result is ValyuSearchResult & { url: string } =>
          safeHttpUrl(result.url),
      );
      return {
        provider: this.id,
        tier: this.tier,
        content: this.content(results),
        citations: results.map((result) => this.citation(result)),
        durationMs,
        ...(typeof data.total_deduction_dollars === 'number' && {
          usage: { costUsd: data.total_deduction_dollars },
        }),
        providerMeta: {
          ...(data.tx_id && { 'valyu:transaction_id': data.tx_id }),
          'valyu:search_type': this.options.searchType ?? 'all',
          ...(this.options.fastMode && { 'valyu:fast_mode': true }),
          ...(this.options.urlOnly && { 'valyu:url_only': true }),
          ...(data.results_by_source && {
            'valyu:results_by_source': data.results_by_source,
          }),
          ...(typeof data.total_characters === 'number' && {
            'valyu:total_characters': data.total_characters,
          }),
          ...(data.warnings?.length && { 'valyu:warnings': data.warnings }),
          ...(data.error && { 'valyu:warning': data.error }),
          'valyu:results': results.map((result) => ({
            ...(result.id && { id: result.id }),
            ...(result.source && { source: result.source }),
            ...(result.source_type && { source_type: result.source_type }),
            ...(typeof result.relevance_score === 'number' && {
              relevance_score: result.relevance_score,
            }),
            ...(typeof result.price === 'number' && { price: result.price }),
            ...(typeof result.length === 'number' && { length: result.length }),
            ...(result.doi && { doi: result.doi }),
            ...(result.authors && { authors: result.authors }),
            ...(result.citation && { citation: result.citation }),
            ...(typeof result.citation_count === 'number' && {
              citation_count: result.citation_count,
            }),
          })),
        },
      };
    } catch (error) {
      return this.failure(
        Math.round(performance.now() - start),
        this.formatCatchError(error),
      );
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    // Search requests can consume paid quota. Validate the configured
    // credential reference without dispatching a provider request.
    try {
      this.getApiKey();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: this.formatCatchError(error),
      };
    }
  }

  private requestBody(query: string): Record<string, unknown> {
    const value = this.options;
    return {
      query,
      ...(value.maxResults !== undefined && {
        max_num_results: value.maxResults,
      }),
      ...(value.searchType && { search_type: value.searchType }),
      ...(value.maxPrice !== undefined && { max_price: value.maxPrice }),
      ...(value.relevanceThreshold !== undefined && {
        relevance_threshold: value.relevanceThreshold,
      }),
      ...(value.includedSources && {
        included_sources: value.includedSources,
      }),
      ...(value.excludedSources && {
        excluded_sources: value.excludedSources,
      }),
      ...(value.sourceBiases && { source_biases: value.sourceBiases }),
      ...(value.instructions && { instructions: value.instructions }),
      ...(value.isToolCall !== undefined && { is_tool_call: value.isToolCall }),
      ...(value.responseLength !== undefined && {
        response_length: value.responseLength,
      }),
      ...(value.startDate && { start_date: value.startDate }),
      ...(value.endDate && { end_date: value.endDate }),
      ...(value.countryCode && { country_code: value.countryCode }),
      ...(value.fastMode !== undefined && { fast_mode: value.fastMode }),
      ...(value.urlOnly !== undefined && { url_only: value.urlOnly }),
    };
  }

  private citation(result: ValyuSearchResult & { url: string }): Citation {
    return {
      url: result.url,
      ...(result.title && { title: result.title }),
      ...((result.content || result.description) && {
        snippet: (result.content || result.description)?.slice(0, 500),
      }),
      provider: this.id,
      ...(result.id && { providerReference: result.id }),
      sourceKind: sourceKind(result.source_type, this.options.searchType),
      ...(result.source && { publisher: result.source }),
      ...(publicationTimestamp(result.publication_date) && {
        publishedAt: publicationTimestamp(result.publication_date),
      }),
    };
  }

  private content(results: (ValyuSearchResult & { url: string })[]): string {
    if (results.length === 0) return 'No results found.';
    return results
      .map((result) => {
        const detail = this.options.urlOnly
          ? ''
          : result.content || result.description || '';
        return [
          `### [${result.title || result.url}](${result.url})`,
          result.source ? `*Source: ${result.source}*` : '',
          detail,
        ]
          .filter(Boolean)
          .join('\n\n');
      })
      .join('\n\n');
  }

  private failure(durationMs: number, error: string): ProviderResult {
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
