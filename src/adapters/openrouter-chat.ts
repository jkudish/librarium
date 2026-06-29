import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import { BaseProvider, type BaseProviderOptions } from './base.js';

interface OpenRouterAnnotation {
  type?: string;
  url_citation?: {
    url?: string;
    title?: string;
    content?: string;
  };
}

interface OpenRouterChatMessage {
  content?: string;
  refusal?: string | null;
  annotations?: OpenRouterAnnotation[];
}

interface OpenRouterChatChoice {
  message?: OpenRouterChatMessage;
  finish_reason?: string;
}

interface OpenRouterChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

interface OpenRouterChatResponse {
  model?: string;
  choices?: OpenRouterChatChoice[];
  usage?: OpenRouterChatUsage;
  error?: {
    message?: string;
  };
}

export interface OpenRouterChatProviderOptions extends BaseProviderOptions {
  model?: string;
  webSearch?: boolean;
}

// Cheap, capable default. Override via config `model`.
const DEFAULT_OPENROUTER_CHAT_MODEL = 'openai/gpt-4o-mini';

/**
 * OpenRouter LLM provider.
 * Uses OpenRouter web search by default for current answers and citations.
 * Distinct from openrouter-online (which grounds via the `:online` suffix).
 * Tier: llm (sync)
 */
export class OpenRouterChatProvider extends BaseProvider {
  readonly id = 'openrouter-chat';
  readonly tier: ProviderTier = 'llm';
  readonly model: string;
  readonly webSearch: boolean;

  constructor(options: OpenRouterChatProviderOptions = {}) {
    super(options);
    this.model = options.model?.trim() || DEFAULT_OPENROUTER_CHAT_MODEL;
    this.webSearch = options.webSearch ?? true;
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const response = await this.request<OpenRouterChatResponse>(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://github.com/jkudish/librarium',
            'X-Title': 'librarium',
          },
          body: {
            model: this.requestModel,
            messages: [{ role: 'user', content: query }],
            // Opt into usage accounting so the response reports cost in USD.
            usage: { include: true },
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

      const choice = data.choices?.[0];
      const content = choice?.message?.content?.trim() ?? '';
      const citations = this.extractCitations(choice?.message?.annotations);

      if (!content) {
        // A 200 with no usable text is not a success: surface a refusal or the
        // finish_reason (e.g. content_filter, length) so it can fail over
        // rather than inflate the success count with an empty answer.
        const refusal = choice?.message?.refusal?.trim();
        const reason = refusal
          ? `refusal: ${refusal}`
          : choice?.finish_reason
            ? `finish_reason: ${choice.finish_reason}`
            : data.choices && data.choices.length > 0
              ? 'empty content'
              : 'no choices returned';
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          error: `OpenRouter returned an empty response (${reason})`,
        };
      }

      return {
        provider: this.id,
        tier: this.tier,
        content,
        citations,
        durationMs,
        model: data.model ?? this.requestModel,
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

  private extractUsage(usage?: OpenRouterChatUsage): ProviderUsage | undefined {
    if (!usage) return undefined;
    return {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      costUsd: usage.cost,
      raw: usage,
    };
  }

  private get requestModel(): string {
    if (!this.webSearch || this.model.endsWith(':online')) return this.model;
    return `${this.model}:online`;
  }

  private extractCitations(annotations?: OpenRouterAnnotation[]): Citation[] {
    if (!Array.isArray(annotations)) return [];

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
