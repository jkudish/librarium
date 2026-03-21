import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider } from './base.js';

interface JinaResult {
  title?: string;
  url: string;
  content?: string;
  description?: string;
}

interface JinaSearchResponse {
  code?: number;
  status?: number;
  data?: JinaResult[];
}

/**
 * Jina AI Search provider.
 * Search-to-markdown API purpose-built for LLM consumption.
 * Tier: raw-search (sync)
 */
export class JinaSearchProvider extends BaseProvider {
  readonly id = 'jina-search';
  readonly tier: ProviderTier = 'raw-search';

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const response = await this.request<JinaSearchResponse>(
        'https://s.jina.ai/',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
          },
          body: {
            q: query,
            num: 10,
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
      const results = data.data ?? [];
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
      const response = await this.request<JinaSearchResponse>(
        'https://s.jina.ai/',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
          },
          body: {
            q: 'test',
            num: 1,
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

  private buildContent(results: JinaResult[]): string {
    if (results.length === 0) return 'No results found.';

    const parts: string[] = [];

    for (const result of results) {
      const title = result.title ?? 'Untitled';
      parts.push(`### [${title}](${result.url})`);

      if (result.description) {
        parts.push(`*${result.description}*`);
      }

      if (result.content) {
        parts.push('');
        parts.push(result.content);
      }

      parts.push('');
    }

    return parts.join('\n');
  }

  private extractCitations(results: JinaResult[]): Citation[] {
    return results.map((result) => ({
      url: result.url,
      title: result.title,
      snippet: (result.description ?? result.content)?.slice(0, 200),
      provider: this.id,
    }));
  }
}
