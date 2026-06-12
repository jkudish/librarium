import type {
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import { BaseProvider, type BaseProviderOptions } from './base.js';

interface OpenRouterChatMessage {
  content?: string;
}

interface OpenRouterChatChoice {
  message?: OpenRouterChatMessage;
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
}

// Cheap, capable default. Override via config `model`.
const DEFAULT_OPENROUTER_CHAT_MODEL = 'openai/gpt-4o-mini';

/**
 * OpenRouter ungrounded LLM provider.
 * Plain chat completions through OpenRouter -- direct answer, no citations.
 * Distinct from openrouter-online (which grounds via the `:online` suffix).
 * Tier: llm (sync, ungrounded)
 */
export class OpenRouterChatProvider extends BaseProvider {
  readonly id = 'openrouter-chat';
  readonly tier: ProviderTier = 'llm';
  readonly model: string;

  constructor(options: OpenRouterChatProviderOptions = {}) {
    super(options);
    this.model = options.model?.trim() || DEFAULT_OPENROUTER_CHAT_MODEL;
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
            model: this.model,
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

      const content = data.choices?.[0]?.message?.content?.trim() ?? '';

      return {
        provider: this.id,
        tier: this.tier,
        content,
        citations: [],
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
}
