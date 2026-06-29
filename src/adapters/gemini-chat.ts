import type {
  Citation,
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
  groundingMetadata?: GeminiGroundingMetadata;
  finishReason?: string;
  finishMessage?: string;
}

interface GeminiGroundingMetadata {
  groundingChunks?: GeminiGroundingChunk[];
  groundingSupports?: GeminiGroundingSupport[];
}

interface GeminiGroundingChunk {
  web?: {
    uri?: string;
    title?: string;
  };
}

interface GeminiGroundingSupport {
  segment?: {
    text?: string;
  };
  groundingChunkIndices?: number[];
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
  webSearch?: boolean;
}

const DEFAULT_GEMINI_CHAT_MODEL = 'gemini-2.5-flash';

/**
 * Gemini LLM provider.
 * Uses Google Search grounding by default for current answers and citations.
 * Tier: llm (sync)
 */
export class GeminiChatProvider extends BaseProvider {
  readonly id = 'gemini-chat';
  readonly tier: ProviderTier = 'llm';
  readonly model: string;
  readonly webSearch: boolean;

  constructor(options: GeminiChatProviderOptions = {}) {
    super(options);
    this.model = options.model?.trim() || DEFAULT_GEMINI_CHAT_MODEL;
    this.webSearch = options.webSearch ?? true;
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const body: Record<string, unknown> = {
        contents: [{ parts: [{ text: query }] }],
      };
      if (this.webSearch) {
        body.tools = [{ googleSearch: {} }];
      }

      const response = await this.request<GeminiChatResponse>(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
        {
          method: 'POST',
          // Pass the API key via header (not a URL query param) so it never
          // lands in request logs; matches the gemini-deep adapter pattern.
          headers: {
            'x-goog-api-key': apiKey,
          },
          body,
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
      const citations = this.extractCitations(candidate);

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
        citations,
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

  private extractCitations(candidate?: GeminiChatCandidate): Citation[] {
    const metadata = candidate?.groundingMetadata;
    const chunks = metadata?.groundingChunks;
    if (!Array.isArray(chunks)) return [];

    const snippets = new Map<number, string>();
    for (const support of metadata?.groundingSupports ?? []) {
      const snippet = support.segment?.text?.trim();
      if (!snippet) continue;
      for (const index of support.groundingChunkIndices ?? []) {
        if (!snippets.has(index)) snippets.set(index, snippet);
      }
    }

    const seen = new Set<string>();
    const citations: Citation[] = [];

    chunks.forEach((chunk, index) => {
      const url = chunk.web?.uri;
      if (!url || seen.has(url)) return;
      seen.add(url);
      citations.push({
        url,
        title: chunk.web?.title,
        snippet: snippets.get(index),
        provider: this.id,
      });
    });

    return citations;
  }
}
