import type { HttpRetryPolicy } from '../core/http-client.js';
import {
  createSearchApiRequest,
  formatSearchApiError,
  formatSearchApiPayloadError,
  redactSearchApiErrorText,
  searchApiOptionsSchema,
} from '../core/searchapi.js';
import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider, type BaseProviderOptions } from './base.js';

interface SearchApiOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
}

interface SearchApiResponse {
  organic_results?: SearchApiOrganicResult[];
  search_information?: { total_results?: number };
  error?: unknown;
}

export interface SearchApiProviderOptions extends BaseProviderOptions {
  zeroRetention?: boolean;
  retry?: HttpRetryPolicy;
}

/**
 * SearchAPI provider.
 * Uses SearchAPI.io for Google search results.
 * Tier: raw-search (sync)
 */
export class SearchApiProvider extends BaseProvider {
  readonly id = 'searchapi';
  readonly tier: ProviderTier = 'raw-search';
  private readonly zeroRetention: boolean;
  private readonly retry?: HttpRetryPolicy;

  constructor(options: SearchApiProviderOptions = {}) {
    super(options);
    const parsed = searchApiOptionsSchema.parse(
      options.zeroRetention === undefined
        ? {}
        : { zeroRetention: options.zeroRetention },
    );
    this.zeroRetention = parsed.zeroRetention;
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
        engine: 'google',
        parameters: { q: query },
        zeroRetention: this.zeroRetention,
        timeout: options.timeout * 1000,
        signal: options.signal,
        retry: this.retry,
      });

      const response = await this.request<SearchApiResponse>(
        request.url,
        request.options,
      );

      const durationMs = Math.round(performance.now() - start);

      if (response.status !== 200) {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          ...(this.zeroRetention ? { preventFallback: true as const } : {}),
          error: formatSearchApiError({
            status: response.status,
            data: response.data,
            apiKey,
            zeroRetention: this.zeroRetention,
            credentialEnvVar: this.envVar,
          }),
        };
      }

      const data = response.data;

      if (data.error) {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          ...(this.zeroRetention ? { preventFallback: true as const } : {}),
          error: formatSearchApiPayloadError(data.error, apiKey),
        };
      }

      const results = data.organic_results ?? [];
      const citations = this.extractCitations(results);
      const content = this.buildContent(results);

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
        ...(this.zeroRetention ? { preventFallback: true as const } : {}),
        error: redactSearchApiErrorText(this.formatCatchError(err), apiKey),
      };
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    let apiKey: string | undefined;
    try {
      apiKey = this.getApiKey();
      const request = createSearchApiRequest({
        apiKey,
        engine: 'google',
        parameters: { q: 'test', num: 1 },
        zeroRetention: this.zeroRetention,
        timeout: 10000,
        retry: this.retry,
      });

      const response = await this.request<SearchApiResponse>(
        request.url,
        request.options,
      );

      if (response.status !== 200) {
        return {
          ok: false,
          error: formatSearchApiError({
            status: response.status,
            data: response.data,
            apiKey,
            zeroRetention: this.zeroRetention,
            credentialEnvVar: this.envVar,
          }),
        };
      }
      if (response.data.error) {
        return {
          ok: false,
          error: formatSearchApiPayloadError(response.data.error, apiKey),
        };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: redactSearchApiErrorText(
          err instanceof Error ? err.message : String(err),
          apiKey,
        ),
      };
    }
  }

  private buildContent(results: SearchApiOrganicResult[]): string {
    if (results.length === 0) return 'No results found.';

    const parts: string[] = [];

    for (const result of results) {
      const title = result.title ?? 'Untitled';
      const link = result.link ?? '';
      parts.push(`### [${title}](${link})`);
      if (result.snippet) {
        parts.push(result.snippet);
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  private extractCitations(results: SearchApiOrganicResult[]): Citation[] {
    return results
      .filter((r) => r.link)
      .map((result) => ({
        url: result.link!,
        title: result.title,
        snippet: result.snippet,
        provider: this.id,
      }));
  }
}
