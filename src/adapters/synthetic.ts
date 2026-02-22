import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider } from './base.js';

interface SyntheticResult {
  url: string;
  title?: string;
  text?: string;
  published?: string;
}

interface SyntheticResponse {
  results?: SyntheticResult[];
  error?: string;
}

/**
 * Synthetic Search provider.
 * Zero-data-retention web search API from synthetic.new.
 * Tier: raw-search (sync)
 */
export class SyntheticProvider extends BaseProvider {
  readonly id = 'synthetic';
  readonly tier: ProviderTier = 'raw-search';

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const response = await this.request<SyntheticResponse>(
        'https://api.synthetic.new/v2/search',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: { query },
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

      if (data.error) {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          error: `Synthetic error: ${data.error}`,
        };
      }

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
      const response = await this.request<SyntheticResponse>(
        'https://api.synthetic.new/v2/search',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: { query: 'test' },
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

  private buildContent(results: SyntheticResult[]): string {
    if (results.length === 0) return 'No results found.';

    const parts: string[] = [];
    parts.push('## Search Results\n');

    for (const result of results) {
      const title = result.title ?? 'Untitled';
      parts.push(`### [${title}](${result.url})`);
      if (result.text) {
        parts.push(result.text);
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  private extractCitations(results: SyntheticResult[]): Citation[] {
    return results.map((result) => ({
      url: result.url,
      title: result.title,
      snippet: result.text?.slice(0, 200),
      provider: this.id,
    }));
  }
}
