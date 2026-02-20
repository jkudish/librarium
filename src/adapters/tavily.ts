import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider } from './base.js';

interface TavilyResult {
  title?: string;
  url: string;
  content?: string;
  score?: number;
  published_date?: string;
}

interface TavilyResponse {
  answer?: string;
  results?: TavilyResult[];
  query?: string;
  error?: string;
}

/**
 * Tavily Search provider.
 * Uses Tavily's search API with advanced depth and answer generation.
 * Tier: raw-search (sync)
 */
export class TavilyProvider extends BaseProvider {
  readonly id = 'tavily';
  readonly tier: ProviderTier = 'raw-search';

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const response = await this.request<TavilyResponse>(
        'https://api.tavily.com/search',
        {
          method: 'POST',
          body: {
            api_key: apiKey,
            query,
            search_depth: 'advanced',
            include_answer: true,
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
          error: `Tavily error: ${data.error}`,
        };
      }

      const results = data.results ?? [];
      const citations = this.extractCitations(results);
      const content = this.buildContent(data.answer, results);

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
      const response = await this.request<TavilyResponse>(
        'https://api.tavily.com/search',
        {
          method: 'POST',
          body: {
            api_key: apiKey,
            query: 'test',
            search_depth: 'basic',
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

  private buildContent(answer?: string, results?: TavilyResult[]): string {
    const parts: string[] = [];

    if (answer) {
      parts.push('## Answer\n');
      parts.push(answer);
      parts.push('');
    }

    if (results && results.length > 0) {
      parts.push('## Search Results\n');
      for (const result of results) {
        const title = result.title ?? 'Untitled';
        parts.push(`### [${title}](${result.url})`);
        if (result.content) {
          parts.push(result.content);
        }
        parts.push('');
      }
    }

    return parts.join('\n');
  }

  private extractCitations(results: TavilyResult[]): Citation[] {
    return results.map((result) => ({
      url: result.url,
      title: result.title,
      snippet: result.content?.slice(0, 200),
      provider: this.id,
    }));
  }
}
