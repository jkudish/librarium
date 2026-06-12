import type {
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import { BaseProvider, type BaseProviderOptions } from './base.js';

interface AnthropicTextBlock {
  type?: string;
  text?: string;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicResponse {
  model?: string;
  content?: AnthropicTextBlock[];
  usage?: AnthropicUsage;
  error?: {
    type?: string;
    message?: string;
  };
}

export interface ClaudeProviderOptions extends BaseProviderOptions {
  model?: string;
}

const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 4096;

/**
 * Claude (Anthropic) ungrounded LLM provider.
 * Returns the model's direct answer with NO citations -- baseline/contrast.
 * Tier: llm (sync, ungrounded)
 */
export class ClaudeProvider extends BaseProvider {
  readonly id = 'claude';
  readonly tier: ProviderTier = 'llm';
  readonly model: string;

  constructor(options: ClaudeProviderOptions = {}) {
    super(options);
    this.model = options.model?.trim() || DEFAULT_CLAUDE_MODEL;
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const response = await this.request<AnthropicResponse>(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: {
            model: this.model,
            max_tokens: MAX_TOKENS,
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

      const content =
        data.content
          ?.filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .filter(Boolean)
          .join('\n')
          .trim() ?? '';

      return {
        provider: this.id,
        tier: this.tier,
        content,
        citations: [],
        durationMs,
        model: data.model ?? this.model,
        tokenUsage: {
          input: data.usage?.input_tokens,
          output: data.usage?.output_tokens,
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

  private extractUsage(usage?: AnthropicUsage): ProviderUsage | undefined {
    if (!usage) return undefined;
    const input = usage.input_tokens;
    const output = usage.output_tokens;
    if (input === undefined && output === undefined) return undefined;
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens:
        input !== undefined && output !== undefined
          ? input + output
          : undefined,
      raw: usage,
    };
  }
}
