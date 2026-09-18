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
} from '../core/searchapi-ai.js';
import type {
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider, type BaseProviderOptions } from './base.js';

export interface SearchApiBingCopilotProviderOptions
  extends BaseProviderOptions {
  zeroRetention?: boolean;
  retry?: HttpRetryPolicy;
}

/** SearchAPI-observed Bing Copilot answer. */
export class SearchApiBingCopilotProvider extends BaseProvider {
  readonly id = 'searchapi-bing-copilot';
  readonly tier: ProviderTier = 'ai-grounded';
  private readonly zeroRetention: boolean;
  private readonly retry?: HttpRetryPolicy;

  constructor(options: SearchApiBingCopilotProviderOptions = {}) {
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
      const request = createSearchApiRequest({
        apiKey,
        engine: 'bing_copilot',
        parameters: { q: query },
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
      return {
        provider: this.id,
        tier: this.tier,
        ...normalizeSearchApiAiAnswer(response.data, this.id),
        durationMs,
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
