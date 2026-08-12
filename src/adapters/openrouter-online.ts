import { getBuiltinProviderDefaultModel } from '../core/provider-descriptor.js';
import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import type { BaseProviderOptions } from './base.js';
import { BaseProvider } from './base.js';

interface OpenRouterAnnotation {
  type?: string;
  url_citation?: {
    url?: string;
    title?: string;
    content?: string;
  };
}

interface OpenRouterMessage {
  content?: string;
  annotations?: OpenRouterAnnotation[];
}

interface OpenRouterChoice {
  message?: OpenRouterMessage;
}

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

interface OpenRouterResponse {
  model?: string;
  choices?: OpenRouterChoice[];
  usage?: OpenRouterUsage;
  error?: {
    message?: string;
  };
}

const OPENROUTER_ONLINE_MODEL =
  getBuiltinProviderDefaultModel('openrouter-online');

/**
 * OpenRouter online search provider.
 * Uses OpenRouter's agentic web-search server tool. The configured model does
 * not support native search, so OpenRouter retains the existing Exa-backed
 * grounding behavior without the deprecated `:online` suffix.
 * Tier: ai-grounded (sync)
 */
export class OpenRouterOnlineProvider extends BaseProvider {
  readonly id = 'openrouter-online';
  readonly tier: ProviderTier = 'ai-grounded';
  private readonly model: string;

  constructor(options: BaseProviderOptions & { model?: string } = {}) {
    super(options);
    this.model = options.model?.trim() || OPENROUTER_ONLINE_MODEL;
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const response = await this.request<OpenRouterResponse>(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://github.com/jkudish/librarium',
            'X-Title': 'librarium',
          },
          body: {
            model: this.model,
            messages: [{ role: 'user', content: query }],
            tools: [{ type: 'openrouter:web_search' }],
          },
          timeout: options.timeout * 1000,
          signal: options.signal,
        },
      );

      const durationMs = Math.round(performance.now() - start);
      const data = response.data;

      if (response.status !== 200 || data.error) {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          error: data.error?.message ?? this.formatError(response.status, data),
        };
      }

      const message = data.choices?.[0]?.message;
      if (!Array.isArray(message?.annotations)) {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          error: 'OpenRouter online response did not include annotations',
        };
      }

      return {
        provider: this.id,
        tier: this.tier,
        content: message.content?.trim() ?? '',
        citations: this.extractCitations(message.annotations),
        durationMs,
        model: data.model ?? this.model,
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
    const result = await this.execute('ping', { timeout: 10 });
    if (!result.error) return { ok: true };
    return { ok: false, error: result.error };
  }

  private extractUsage(usage?: OpenRouterUsage): ProviderUsage | undefined {
    if (!usage) return undefined;
    return {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      costUsd: usage.cost,
      raw: usage,
    };
  }

  private extractCitations(annotations: OpenRouterAnnotation[]): Citation[] {
    const seen = new Set<string>();
    const citations: Citation[] = [];

    for (const annotation of annotations) {
      if (annotation.type !== 'url_citation') continue;
      const citation = annotation.url_citation;
      if (!citation?.url || seen.has(citation.url)) continue;
      seen.add(citation.url);
      citations.push({
        url: citation.url,
        title: citation.title,
        snippet: citation.content,
        provider: this.id,
      });
    }

    return citations;
  }
}
