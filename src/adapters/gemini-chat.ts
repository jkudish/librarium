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
  finishReason?: string;
  finishMessage?: string;
}

interface GeminiChatPromptFeedback {
  blockReason?: string;
  blockReasonMessage?: string;
}

interface GeminiChatUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiChatResponse {
  candidates?: GeminiChatCandidate[];
  promptFeedback?: GeminiChatPromptFeedback;
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
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
        {
          method: 'POST',
          // Pass the API key via header (not a URL query param) so it never
          // lands in request logs; matches the gemini-deep adapter pattern.
          headers: {
            'x-goog-api-key': apiKey,
          },
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

      const candidate = data.candidates?.[0];
      const content =
        candidate?.content?.parts
          ?.map((part) => part.text ?? '')
          .filter(Boolean)
          .join('\n')
          .trim() ?? '';

      if (!content) {
        // A 200 with no usable text is not a success: surface a prompt-level
        // safety block or the candidate finishReason (e.g. SAFETY, RECITATION,
        // MAX_TOKENS) so it can fail over rather than inflate the success
        // count with an empty answer.
        const block = data.promptFeedback?.blockReason;
        const blockMessage = data.promptFeedback?.blockReasonMessage;
        const finishReason = candidate?.finishReason;
        const finishMessage = candidate?.finishMessage;
        let reason: string;
        if (block) {
          reason = `blocked: ${block}${blockMessage ? ` (${blockMessage})` : ''}`;
        } else if (finishReason) {
          reason = `finishReason: ${finishReason}${
            finishMessage ? ` (${finishMessage})` : ''
          }`;
        } else if (!data.candidates || data.candidates.length === 0) {
          reason = 'no candidates returned';
        } else {
          reason = 'empty content';
        }
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          error: `Gemini returned an empty response (${reason})`,
        };
      }

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
