import type { HttpRetryPolicy } from '../core/http-client.js';
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
  searchApiAiResponseModel,
} from '../core/searchapi-ai.js';
import type {
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider, type BaseProviderOptions } from './base.js';

const MAX_QUERY_CHARACTERS = 4000;

export interface SearchApiChatGptProviderOptions extends BaseProviderOptions {
  zeroRetention?: boolean;
  retry?: HttpRetryPolicy;
}

/** SearchAPI-observed ChatGPT answer with live web search enabled. */
export class SearchApiChatGptProvider extends BaseProvider {
  readonly id = 'searchapi-chatgpt';
  readonly tier: ProviderTier = 'ai-grounded';
  private readonly zeroRetention: boolean;
  private readonly retry?: HttpRetryPolicy;

  constructor(options: SearchApiChatGptProviderOptions = {}) {
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
    if ([...query].length > MAX_QUERY_CHARACTERS) {
      return this.errorResult(
        start,
        `Query exceeds SearchAPI ChatGPT maximum of ${MAX_QUERY_CHARACTERS} characters`,
      );
    }

    let apiKey: string | undefined;
    try {
      apiKey = this.getApiKey();
      const request = createSearchApiRequest({
        apiKey,
        engine: 'chatgpt',
        parameters: { q: query, web_search: true },
        zeroRetention: this.zeroRetention,
        timeout: options.timeout * 1000,
        signal: options.signal,
        retry: this.retry,
      });
      const response = await this.request<SearchApiAiResponse>(
        request.url,
        request.options,
      );
      const durationMs = Math.round(performance.now() - start);
      if (response.status !== 200) {
        return this.httpError(
          durationMs,
          response.status,
          response.data,
          apiKey,
        );
      }
      const upstreamError = searchApiAiResponseError(response.data);
      if (upstreamError) {
        return this.errorResult(
          durationMs,
          formatSearchApiPayloadError(upstreamError, apiKey),
        );
      }
      const answer = normalizeSearchApiAiAnswer(response.data, this.id);
      const model = searchApiAiResponseModel(response.data);
      return {
        provider: this.id,
        tier: this.tier,
        ...answer,
        durationMs,
        ...(model ? { model } : {}),
      };
    } catch (error) {
      return this.errorResult(
        Math.round(performance.now() - start),
        redactSearchApiErrorText(this.formatCatchError(error), apiKey),
      );
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    const result = await this.execute('test', { timeout: 10 });
    return result.error ? { ok: false, error: result.error } : { ok: true };
  }

  private httpError(
    durationMs: number,
    status: number,
    data: unknown,
    apiKey: string,
  ): ProviderResult {
    return this.errorResult(
      durationMs,
      formatSearchApiError({
        status,
        data,
        apiKey,
        zeroRetention: this.zeroRetention,
        credentialEnvVar: this.envVar,
      }),
    );
  }

  private errorResult(durationMs: number, error: string): ProviderResult {
    return {
      provider: this.id,
      tier: this.tier,
      content: '',
      citations: [],
      durationMs,
      ...(this.zeroRetention ? { preventFallback: true as const } : {}),
      error,
    };
  }
}
