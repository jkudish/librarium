import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import { BaseProvider } from './base.js';

interface PerplexityMessage {
  role: string;
  content: string;
}

interface PerplexityChoice {
  message: PerplexityMessage;
}

interface PerplexityUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: { total_cost?: number };
}

interface PerplexityResponse {
  id: string;
  model?: string;
  choices: PerplexityChoice[];
  citations?: string[];
  usage?: PerplexityUsage;
}

/**
 * Perplexity Sonar Pro provider.
 * Uses sonar-pro model for AI-grounded search with citations.
 * Tier: ai-grounded (sync)
 */
export class PerplexitySonarProProvider extends BaseProvider {
  readonly id = 'perplexity-sonar-pro';
  readonly tier: ProviderTier = 'ai-grounded';

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const response = await this.request<PerplexityResponse>(
        'https://api.perplexity.ai/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: {
            model: 'sonar-pro',
            messages: [{ role: 'user', content: query }],
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
      const content = data.choices?.[0]?.message?.content ?? '';
      const citations = this.extractCitations(data.citations);

      return {
        provider: this.id,
        tier: this.tier,
        content,
        citations,
        durationMs,
        model: data.model ?? 'sonar-pro',
        tokenUsage: {
          input: data.usage?.prompt_tokens,
          output: data.usage?.completion_tokens,
        },
        usage: this.extractUsage(data.usage),
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
      const response = await this.request<PerplexityResponse>(
        'https://api.perplexity.ai/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: {
            model: 'sonar-pro',
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 5,
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

  private extractCitations(urls?: string[]): Citation[] {
    if (!urls || !Array.isArray(urls)) return [];
    return urls.map((url) => ({
      url,
      provider: this.id,
    }));
  }

  private extractUsage(usage?: PerplexityUsage): ProviderUsage | undefined {
    if (!usage) return undefined;
    return {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      costUsd: usage.cost?.total_cost,
      raw: usage,
    };
  }
}
