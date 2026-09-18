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
  normalizeSearchApiAiAnswer,
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
  type SearchApiGoogleResponse,
} from './searchapi-google.js';

export const SEARCHAPI_GOOGLE_AI_OVERVIEW_MAX_LOGICAL_OPERATIONS = 2;

const MISSING_TOKEN_ERROR =
  'SearchAPI Google AI Overview unverified: stage 1 returned no valid ai_overview.page_token';
const NO_RESULT_ERROR =
  'SearchAPI Google AI Overview capability unverified: no result';

export interface SearchApiGoogleAiOverviewProviderOptions
  extends BaseProviderOptions {
  zeroRetention?: boolean;
  retry?: HttpRetryPolicy;
}

/** SearchAPI's immediate two-stage Google AI Overview workflow. */
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

      const pageToken = extractSearchApiGoogleAiOverviewPageToken(
        firstResponse.data.ai_overview,
      );
      if (!pageToken) return this.errorResult(start, MISSING_TOKEN_ERROR);
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

      return {
        provider: this.id,
        tier: this.tier,
        ...normalizeSearchApiAiAnswer(secondResponse.data, this.id),
        durationMs: this.duration(start),
      };
    } catch (error) {
      return this.errorResult(
        start,
        redactSearchApiErrorText(this.formatCatchError(error), apiKey),
      );
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    const result = await this.execute('test', { timeout: 10 });
    if (result.error) return { ok: false, error: result.error };
    return result.content.trim()
      ? { ok: true }
      : { ok: false, error: NO_RESULT_ERROR };
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
