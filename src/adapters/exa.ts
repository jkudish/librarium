import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider } from './base.js';

interface ExaResult {
  url: string;
  title?: string;
  text?: string;
  publishedDate?: string;
  score?: number;
}

interface ExaResponse {
  results?: ExaResult[];
  requestId?: string;
  error?: string;
}

/**
 * Exa Search provider.
 * Uses Exa's neural search API with content extraction.
 * Tier: ai-grounded (sync)
 */
export class ExaProvider extends BaseProvider {
  readonly id = 'exa';
  readonly tier: ProviderTier = 'ai-grounded';

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const response = await this.request<ExaResponse>(
        'https://api.exa.ai/search',
        {
          method: 'POST',
          headers: { 'x-api-key': apiKey },
          body: {
            query,
            type: 'auto',
            numResults: 10,
            contents: {
              text: { maxCharacters: 2000 },
            },
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
          error: `Exa error: ${data.error}`,
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
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const apiKey = this.getApiKey();
      const response = await this.request<ExaResponse>(
        'https://api.exa.ai/search',
        {
          method: 'POST',
          headers: { 'x-api-key': apiKey },
          body: {
            query: 'test',
            type: 'auto',
            numResults: 1,
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

  private buildContent(results: ExaResult[]): string {
    if (results.length === 0) return 'No results found.';

    const parts: string[] = [];

    for (const result of results) {
      const title = result.title ?? 'Untitled';
      parts.push(`### [${title}](${result.url})`);

      if (result.publishedDate) {
        parts.push(`*Published: ${result.publishedDate}*`);
      }

      if (result.text) {
        parts.push('');
        parts.push(result.text);
      }

      parts.push('');
    }

    return parts.join('\n');
  }

  private extractCitations(results: ExaResult[]): Citation[] {
    return results.map((result) => ({
      url: result.url,
      title: result.title,
      snippet: result.text?.slice(0, 200),
      provider: this.id,
    }));
  }
}
