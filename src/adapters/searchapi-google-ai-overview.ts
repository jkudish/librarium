import type { HttpRetryPolicy } from '../core/http-client.js';
import { HttpRequestAbortedError } from '../core/http-client.js';
import {
  createSearchApiRequest,
  formatSearchApiError,
  formatSearchApiPayloadError,
  redactSearchApiErrorText,
  searchApiOptionsSchema,
} from '../core/searchapi.js';
import {
  type SearchApiAiResponse,
  searchApiAiResponseError,
} from '../core/searchapi-ai.js';
import type {
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider, type BaseProviderOptions } from './base.js';
import {
  extractSearchApiGoogleAiOverviewPageToken,
  hasSearchApiGoogleAiOverviewPayload,
  readSearchApiGoogleAiOverview,
  type SearchApiGoogleResponse,
  type SearchApiGoogleSection,
} from './searchapi-google.js';

export const SEARCHAPI_GOOGLE_AI_OVERVIEW_MAX_LOGICAL_OPERATIONS = 2;

/** Google showed no AI Overview for this search (PHP: searchapi.no_ai_overview). */
export const SEARCHAPI_GOOGLE_AI_OVERVIEW_NO_OVERVIEW_ERROR =
  'SearchAPI Google AI Overview unavailable: Google showed no AI Overview for this search';
/** An overview was present but unreadable (PHP: searchapi.ai_overview_unparsed). */
export const SEARCHAPI_GOOGLE_AI_OVERVIEW_UNPARSED_ERROR =
  'SearchAPI Google AI Overview unparsed: SearchAPI returned an AI Overview the adapter could not read';

export interface SearchApiGoogleAiOverviewProviderOptions
  extends BaseProviderOptions {
  zeroRetention?: boolean;
  retry?: HttpRetryPolicy;
}

/**
 * SearchAPI's Google AI Overview workflow: read an overview inline from the
 * first google request, and follow ai_overview.page_token with a second
 * google_ai_overview request only when no inline overview is present.
 */
export class SearchApiGoogleAiOverviewProvider extends BaseProvider {
  readonly id = 'searchapi-google-ai-overview';
  readonly tier: ProviderTier = 'ai-grounded';
  readonly maxLogicalOperations =
    SEARCHAPI_GOOGLE_AI_OVERVIEW_MAX_LOGICAL_OPERATIONS;
  private readonly zeroRetention: boolean;
  private readonly retry?: HttpRetryPolicy;

  constructor(options: SearchApiGoogleAiOverviewProviderOptions = {}) {
    super(options);
    this.zeroRetention = searchApiOptionsSchema.parse(
      options.zeroRetention === undefined
        ? {}
        : { zeroRetention: options.zeroRetention },
    ).zeroRetention;
    this.retry = options.retry;
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    let apiKey: string | undefined;

    try {
      apiKey = this.getApiKey();
      const firstRequest = createSearchApiRequest({
        apiKey,
        engine: 'google',
        parameters: { q: query },
        zeroRetention: this.zeroRetention,
        timeout: options.timeout * 1000,
        signal: options.signal,
        retry: this.retry,
      });
      const firstResponse = await this.request<SearchApiGoogleResponse>(
        firstRequest.url,
        firstRequest.options,
      );

      if (firstResponse.status !== 200) {
        return this.httpError(
          start,
          firstResponse.status,
          firstResponse.data,
          apiKey,
        );
      }
      if (firstResponse.data.error) {
        return this.errorResult(
          start,
          formatSearchApiPayloadError(firstResponse.data.error, apiKey),
        );
      }

      // Google returns the overview inline, behind a page_token (often beside
      // a misleading "not available" error), or not at all. Only the token
      // shape costs a second request.
      const overview = firstResponse.data.ai_overview;
      if (!isNonEmptyRecord(overview)) {
        return this.errorResult(
          start,
          SEARCHAPI_GOOGLE_AI_OVERVIEW_NO_OVERVIEW_ERROR,
        );
      }
      const inline = readSearchApiGoogleAiOverview(overview, this.id);
      if (inline.content) return this.overviewResult(start, inline, 'inline');

      const pageToken = extractSearchApiGoogleAiOverviewPageToken(overview);
      if (!pageToken) return this.unreadableResult(start, overview);
      if (options.signal?.aborted) throw new HttpRequestAbortedError();

      const secondRequest = createSearchApiRequest({
        apiKey,
        engine: 'google_ai_overview',
        parameters: { page_token: pageToken },
        zeroRetention: this.zeroRetention,
        timeout: options.timeout * 1000,
        signal: options.signal,
        retry: this.retry,
      });
      const secondResponse = await this.request<SearchApiAiResponse>(
        secondRequest.url,
        secondRequest.options,
      );

      if (secondResponse.status !== 200) {
        return this.httpError(
          start,
          secondResponse.status,
          secondResponse.data,
          apiKey,
        );
      }
      const upstreamError = searchApiAiResponseError(secondResponse.data);
      if (upstreamError) {
        return this.errorResult(
          start,
          formatSearchApiPayloadError(upstreamError, apiKey),
        );
      }

      const loaded = readSearchApiGoogleAiOverview(
        secondResponse.data,
        this.id,
      );
      return loaded.content
        ? this.overviewResult(start, loaded, 'page_token')
        : this.unreadableResult(start, secondResponse.data);
    } catch (error) {
      return this.errorResult(
        start,
        redactSearchApiErrorText(this.formatCatchError(error), apiKey),
      );
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    const result = await this.execute('test', { timeout: 10 });
    return result.error ? { ok: false, error: result.error } : { ok: true };
  }

  private overviewResult(
    start: number,
    overview: SearchApiGoogleSection,
    retrieval: 'inline' | 'page_token',
  ): ProviderResult {
    return {
      provider: this.id,
      tier: this.tier,
      content: overview.content,
      citations: overview.citations,
      durationMs: this.duration(start),
      // Observed request facts: SearchAPI bills each successful search, and
      // only the page_token shape needs the second google_ai_overview call.
      providerMeta: {
        'searchapi:ai_overview_retrieval': retrieval,
        'searchapi:request_count': retrieval === 'inline' ? 1 : 2,
      },
    };
  }

  /** No readable overview: unparsed when material exists, otherwise absent. */
  private unreadableResult(start: number, overview: unknown): ProviderResult {
    return this.errorResult(
      start,
      hasSearchApiGoogleAiOverviewPayload(overview)
        ? SEARCHAPI_GOOGLE_AI_OVERVIEW_UNPARSED_ERROR
        : SEARCHAPI_GOOGLE_AI_OVERVIEW_NO_OVERVIEW_ERROR,
    );
  }

  private httpError(
    start: number,
    status: number,
    data: unknown,
    apiKey: string,
  ): ProviderResult {
    return this.errorResult(
      start,
      formatSearchApiError({
        status,
        data,
        apiKey,
        zeroRetention: this.zeroRetention,
        credentialEnvVar: this.envVar,
      }),
    );
  }

  private errorResult(start: number, error: string): ProviderResult {
    return {
      provider: this.id,
      tier: this.tier,
      content: '',
      citations: [],
      durationMs: this.duration(start),
      preventFallback: true,
      error,
    };
  }

  private duration(start: number): number {
    return Math.round(performance.now() - start);
  }
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}
