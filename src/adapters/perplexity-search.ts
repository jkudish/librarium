import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider } from './base.js';

interface PerplexitySearchResult {
  url: string;
  title?: string;
  snippet?: string;
  date?: string;
}

interface PerplexitySearchResponse {
  id: string;
  results?: PerplexitySearchResult[];
}

const SEARCH_API_URL = 'https://api.perplexity.ai/search';

/**
 * Perplexity Search API provider.
 * Returns raw ranked web search results with snippets and content extraction.
 * Tier: raw-search (sync)
 */
export class PerplexitySearchProvider extends BaseProvider {
  readonly id = 'perplexity-search';
  readonly tier: ProviderTier = 'raw-search';

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const response = await this.request<PerplexitySearchResponse>(
        SEARCH_API_URL,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: {
            query,
            max_results: 10,
          },
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
      const results = data.results ?? [];
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

  private buildContent(results: PerplexitySearchResult[]): string {
    if (results.length === 0) return 'No results found.';

    const parts: string[] = [];

    for (const result of results) {
      const title = result.title ?? 'Untitled';
      parts.push(`- **[${title}](${result.url})**`);
      if (result.snippet) {
        parts.push(`  ${result.snippet.slice(0, 300)}`);
      }
    }

    return parts.join('\n');
  }

  private extractCitations(results: PerplexitySearchResult[]): Citation[] {
    return results.map((result) => ({
      url: result.url,
      title: result.title,
      snippet: result.snippet?.slice(0, 200),
      provider: this.id,
    }));
  }
}
