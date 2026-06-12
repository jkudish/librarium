import type {
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import { BaseProvider, type BaseProviderOptions } from './base.js';

interface GeminiChatPart {
  text?: string;
}

interface GeminiChatCandidate {
  content?: {
    parts?: GeminiChatPart[];
  };
}

interface GeminiChatUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiChatResponse {
  candidates?: GeminiChatCandidate[];
  usageMetadata?: GeminiChatUsageMetadata;
  modelVersion?: string;
  error?: {
    message?: string;
    code?: number;
  };
}

export interface GeminiChatProviderOptions extends BaseProviderOptions {
  model?: string;
}

const DEFAULT_GEMINI_CHAT_MODEL = 'gemini-2.5-flash';

/**
 * Gemini ungrounded LLM provider.
 * Plain generateContent with NO googleSearch tool -- direct answer, no citations.
 * Distinct from gemini-grounded (which grounds via Google Search).
 * Tier: llm (sync, ungrounded)
 */
export class GeminiChatProvider extends BaseProvider {
  readonly id = 'gemini-chat';
  readonly tier: ProviderTier = 'llm';
  readonly model: string;

  constructor(options: GeminiChatProviderOptions = {}) {
    super(options);
    this.model = options.model?.trim() || DEFAULT_GEMINI_CHAT_MODEL;
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const response = await this.request<GeminiChatResponse>(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          body: {
            contents: [{ parts: [{ text: query }] }],
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
      if (data.error) {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          error: `Gemini error: ${data.error.message ?? data.error.code}`,
        };
      }

      const content =
        data.candidates?.[0]?.content?.parts
          ?.map((part) => part.text ?? '')
          .filter(Boolean)
          .join('\n')
          .trim() ?? '';

      return {
        provider: this.id,
        tier: this.tier,
        content,
        citations: [],
        durationMs,
        model: data.modelVersion ?? this.model,
        tokenUsage: {
          input: data.usageMetadata?.promptTokenCount,
          output: data.usageMetadata?.candidatesTokenCount,
        },
        usage: this.extractUsage(data.usageMetadata),
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

  private extractUsage(
    metadata?: GeminiChatUsageMetadata,
  ): ProviderUsage | undefined {
    if (!metadata) return undefined;
    return {
      inputTokens: metadata.promptTokenCount,
      outputTokens: metadata.candidatesTokenCount,
      totalTokens: metadata.totalTokenCount,
      raw: metadata,
    };
  }
}
