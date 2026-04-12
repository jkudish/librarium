import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider } from './base.js';

interface FirecrawlWebResult {
  url: string;
  title?: string;
  description?: string;
}

interface FirecrawlSearchResponse {
  success?: boolean;
  data?: {
    web?: FirecrawlWebResult[];
  };
  error?: string;
}

/**
 * Firecrawl Search provider.
 * Uses Firecrawl v2 Search API for raw web search results.
 * Tier: raw-search (sync)
 */
export class FirecrawlSearchProvider extends BaseProvider {
  readonly id = 'firecrawl-search';
  readonly tier: ProviderTier = 'raw-search';

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const url = 'https://api.firecrawl.dev/v2/search';

      const response = await this.request<FirecrawlSearchResponse>(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: {
          query,
          limit: 10,
          sources: ['web'],
        },
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
          error: this.formatError(response.status, response.data),
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
          error: data.error,
        };
      }

      const results = data.data?.web ?? [];
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
      const response = await this.request<FirecrawlSearchResponse>(
        'https://api.firecrawl.dev/v2/search',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: { query: 'test', limit: 1, sources: ['web'] },
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

  private buildContent(results: FirecrawlWebResult[]): string {
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

  private extractCitations(results: FirecrawlWebResult[]): Citation[] {
    return results.map((result) => ({
      url: result.url,
      title: result.title,
      snippet: result.description?.slice(0, 200),
      provider: this.id,
    }));
  }
}
