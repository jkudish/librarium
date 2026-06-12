import type {
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import { BaseProvider, type BaseProviderOptions } from './base.js';

interface OpenAIChatMessage {
  content?: string;
}

interface OpenAIChatChoice {
  message?: OpenAIChatMessage;
}

interface OpenAIChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAIChatResponse {
  model?: string;
  choices?: OpenAIChatChoice[];
  usage?: OpenAIChatUsage;
  error?: {
    message?: string;
    type?: string;
  };
}

export interface OpenAIChatProviderOptions extends BaseProviderOptions {
  model?: string;
}

const DEFAULT_OPENAI_CHAT_MODEL = 'gpt-5-mini';

/**
 * OpenAI chat completions ungrounded LLM provider.
 * Returns the model's direct answer with NO citations -- baseline/contrast.
 * Tier: llm (sync, ungrounded)
 */
export class OpenAIChatProvider extends BaseProvider {
  readonly id = 'openai-chat';
  readonly tier: ProviderTier = 'llm';
  readonly model: string;

  constructor(options: OpenAIChatProviderOptions = {}) {
    super(options);
    this.model = options.model?.trim() || DEFAULT_OPENAI_CHAT_MODEL;
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const response = await this.request<OpenAIChatResponse>(
        'https://api.openai.com/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: {
            model: this.model,
            messages: [{ role: 'user', content: query }],
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

  private extractUsage(usage?: OpenAIChatUsage): ProviderUsage | undefined {
    if (!usage) return undefined;
    return {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      raw: usage,
    };
  }
}
