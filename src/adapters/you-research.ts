import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider } from './base.js';

interface YouSource {
  url: string;
  title?: string;
  snippets?: string[];
}

interface YouResearchResponse {
  output?: {
    content?: string;
    content_type?: string;
    sources?: YouSource[];
  };
  detail?: string;
}

/**
 * You.com Research API provider.
 * AI-powered research with cited, synthesized answers.
 * Tier: ai-grounded (sync)
 */
export class YouResearchProvider extends BaseProvider {
  readonly id = 'you-research';
  readonly tier: ProviderTier = 'ai-grounded';

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const response = await this.request<YouResearchResponse>(
        'https://api.you.com/v1/research',
        {
          method: 'POST',
          headers: { 'X-API-Key': apiKey },
          body: {
            input: query,
            research_effort: 'standard',
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

      if (data.detail) {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          error: `You.com error: ${data.detail}`,
        };
      }

      const content = data.output?.content ?? '';
      const citations = this.extractCitations(data.output?.sources);

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
      const response = await this.request<YouResearchResponse>(
        'https://api.you.com/v1/research',
        {
          method: 'POST',
          headers: { 'X-API-Key': apiKey },
          body: {
            input: 'test',
            research_effort: 'lite',
          },
          timeout: 15000,
        },
      );

      if (response.status === 200) return { ok: true };
      return { ok: false, error: `HTTP ${response.status}` };
    } catch (err) {
      return {
        ok: false,
        error: this.formatCatchError(err),
      };
    }
  }

  private extractCitations(sources?: YouSource[]): Citation[] {
    if (!sources || !Array.isArray(sources)) return [];

    return sources.map((source) => ({
      url: source.url,
      title: source.title,
      snippet: source.snippets?.[0]?.slice(0, 200),
      provider: this.id,
    }));
  }
}
