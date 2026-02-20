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

interface BraveSummarizerResult {
  description?: string;
}

interface BraveSummarizer {
  results?: BraveSummarizerResult[];
}

interface BraveSearchResponse {
  web?: { results?: BraveWebResult[] };
  summarizer?: BraveSummarizer;
  query?: { original?: string };
}

/**
 * Brave AI Answers provider.
 * Uses Brave Search API with summary=1 for AI-grounded search.
 * Tier: ai-grounded (sync)
 */
export class BraveAnswersProvider extends BaseProvider {
  readonly id = 'brave-answers';
  readonly tier: ProviderTier = 'ai-grounded';

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const encodedQuery = encodeURIComponent(query);
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodedQuery}&summary=1`;

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
      const citations = this.extractCitations(data.web?.results);
      const content = this.buildContent(data);

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

  private buildContent(data: BraveSearchResponse): string {
    const parts: string[] = [];

    // AI summary
    const summary = data.summarizer?.results?.[0]?.description;
    if (summary) {
      parts.push('## AI Summary\n');
      parts.push(summary);
      parts.push('');
    }

    // Web results
    const results = data.web?.results;
    if (results && results.length > 0) {
      parts.push('## Web Results\n');
      for (const result of results) {
        parts.push(`### [${result.title ?? 'Untitled'}](${result.url})`);
        if (result.description) {
          parts.push(result.description);
        }
        parts.push('');
      }
    }

    return parts.join('\n');
  }

  private extractCitations(results?: BraveWebResult[]): Citation[] {
    if (!results || !Array.isArray(results)) return [];

    return results.map((result) => ({
      url: result.url,
      title: result.title,
      snippet: result.description,
      provider: this.id,
    }));
  }
}
