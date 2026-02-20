import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider } from './base.js';

interface SerpApiOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
}

interface SerpApiResponse {
  organic_results?: SerpApiOrganicResult[];
  search_information?: { total_results?: number };
  error?: string;
}

/**
 * SerpAPI provider.
 * Uses SerpAPI for Google search results.
 * Tier: raw-search (sync)
 */
export class SerpApiProvider extends BaseProvider {
  readonly id = 'serpapi';
  readonly tier: ProviderTier = 'raw-search';

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const encodedQuery = encodeURIComponent(query);
      const url = `https://serpapi.com/search?engine=google&q=${encodedQuery}&api_key=${apiKey}`;

      const response = await this.request<SerpApiResponse>(url, {
        method: 'GET',
        timeout: options.timeout * 1000,
        signal: options.signal,
      });

      const durationMs = Math.round(performance.now() - start);

      if (response.status !== 200) {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          error: `API returned ${response.status}: ${JSON.stringify(response.data)}`,
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
          error: `SerpAPI error: ${data.error}`,
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
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const apiKey = this.getApiKey();
      const url = `https://serpapi.com/search?engine=google&q=test&api_key=${apiKey}&num=1`;

      const response = await this.request<SerpApiResponse>(url, {
        method: 'GET',
        timeout: 10000,
      });

      if (response.status === 200) return { ok: true };
      return { ok: false, error: `HTTP ${response.status}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private buildContent(results: SerpApiOrganicResult[]): string {
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

  private extractCitations(results: SerpApiOrganicResult[]): Citation[] {
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
