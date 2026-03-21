import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider } from './base.js';

interface KagiReference {
  title?: string;
  snippet?: string;
  url: string;
}

interface KagiFastGPTResponse {
  meta?: {
    id?: string;
    node?: string;
    ms?: number;
  };
  data?: {
    output?: string;
    tokens?: number;
    references?: KagiReference[];
  };
  error?: Array<{ code?: number; msg?: string }>;
}

/**
 * Kagi FastGPT provider.
 * AI-powered answers with curated, ad-free web sources.
 * Tier: ai-grounded (sync)
 */
export class KagiFastGPTProvider extends BaseProvider {
  readonly id = 'kagi-fastgpt';
  readonly tier: ProviderTier = 'ai-grounded';

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const response = await this.request<KagiFastGPTResponse>(
        'https://kagi.com/api/v0/fastgpt',
        {
          method: 'POST',
          headers: { Authorization: `Bot ${apiKey}` },
          body: {
            query,
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

      if (data.error && data.error.length > 0) {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          error: `Kagi error: ${data.error[0]?.msg ?? 'Unknown error'}`,
        };
      }

      const content = this.buildContent(data);
      const citations = this.extractCitations(data.data?.references);

      return {
        provider: this.id,
        tier: this.tier,
        content,
        citations,
        durationMs,
        tokenUsage: {
          output: data.data?.tokens,
        },
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
      const response = await this.request<KagiFastGPTResponse>(
        'https://kagi.com/api/v0/fastgpt',
        {
          method: 'POST',
          headers: { Authorization: `Bot ${apiKey}` },
          body: {
            query: 'ping',
          },
          timeout: 15000,
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

  private buildContent(response: KagiFastGPTResponse): string {
    const parts: string[] = [];

    const answer = response.data?.output;
    if (answer) {
      parts.push('## Answer\n');
      parts.push(answer);
      parts.push('');
    }

    const refs = response.data?.references;
    if (refs && refs.length > 0) {
      parts.push('## References\n');
      for (const ref of refs) {
        const title = ref.title ?? 'Untitled';
        parts.push(`### [${title}](${ref.url})`);
        if (ref.snippet) {
          parts.push(ref.snippet);
        }
        parts.push('');
      }
    }

    return parts.join('\n');
  }

  private extractCitations(references?: KagiReference[]): Citation[] {
    if (!references || !Array.isArray(references)) return [];

    return references.map((ref) => ({
      url: ref.url,
      title: ref.title,
      snippet: ref.snippet?.slice(0, 200),
      provider: this.id,
    }));
  }
}
