import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider } from './base.js';

interface BraveWebResult {
  url: string;
  title?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: { results?: BraveWebResult[] };
  query?: { original?: string };
}

/**
 * Brave Web Search provider.
 * Uses Brave Search API for raw web search results (no AI summary).
 * Tier: raw-search (sync)
 */
export class BraveSearchProvider extends BaseProvider {
  readonly id = 'brave-search';
  readonly tier: ProviderTier = 'raw-search';

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const encodedQuery = encodeURIComponent(query);
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodedQuery}`;

      const response = await this.request<BraveSearchResponse>(url, {
        method: 'GET',
        headers: { 'X-Subscription-Token': apiKey },
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
      const results = data.web?.results ?? [];
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
      const response = await this.request<BraveSearchResponse>(
        'https://api.search.brave.com/res/v1/web/search?q=test&count=1',
        {
          method: 'GET',
          headers: { 'X-Subscription-Token': apiKey },
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

  private buildContent(results: BraveWebResult[]): string {
    if (results.length === 0) return 'No results found.';

    const parts: string[] = [];

    for (const result of results) {
      const title = result.title ?? 'Untitled';
      parts.push(`- **[${title}](${result.url})**`);
      if (result.description) {
        parts.push(`  ${result.description}`);
      }
    }

    return parts.join('\n');
  }

  private extractCitations(results: BraveWebResult[]): Citation[] {
    return results.map((result) => ({
      url: result.url,
      title: result.title,
      snippet: result.description,
      provider: this.id,
    }));
  }
}
