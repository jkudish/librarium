import { getBuiltinProviderDefaultModel } from '../core/provider-descriptor.js';
import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import type { BaseProviderOptions } from './base.js';
import { BaseProvider } from './base.js';
import { type GeminiUsageMetadata, geminiUsage } from './gemini-usage.js';

interface GeminiGroundedPart {
  text?: string;
}

interface GeminiGroundedCandidate {
  content?: {
    parts?: GeminiGroundedPart[];
  };
  groundingMetadata?: {
    webSearchQueries?: unknown;
    groundingChunks?: Array<{
      web?: {
        uri?: string;
        title?: string;
      };
    }>;
  };
}

interface GeminiGroundedResponse {
  candidates?: GeminiGroundedCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  error?: {
    message?: string;
    code?: number;
  };
}

const GEMINI_GROUNDED_MODEL = getBuiltinProviderDefaultModel('gemini-grounded');

/**
 * Gemini grounded search provider.
 * Uses Gemini 2.0 Flash with the googleSearch tool.
 * Tier: ai-grounded (sync)
 */
export class GeminiGroundedProvider extends BaseProvider {
  readonly id = 'gemini-grounded';
  readonly tier: ProviderTier = 'ai-grounded';
  private readonly model: string;

  constructor(options: BaseProviderOptions & { model?: string } = {}) {
    super(options);
    this.model = options.model?.trim() || GEMINI_GROUNDED_MODEL;
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const response = await this.request<GeminiGroundedResponse>(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
        {
          method: 'POST',
          headers: { 'x-goog-api-key': apiKey },
          body: {
            contents: [{ parts: [{ text: query }] }],
            tools: [{ googleSearch: {} }],
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
          error: this.redactErrorText(
            `Gemini error: ${data.error.message ?? data.error.code}`,
          ),
        };
      }

      const candidate = data.candidates?.[0];
      const content =
        candidate?.content?.parts
          ?.map((part) => (typeof part.text === 'string' ? part.text : ''))
          .filter(Boolean)
          .join('\n')
          .trim() ?? '';
      if (!content) {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          error: 'Gemini response did not include a non-empty answer',
        };
      }
      const citations = this.extractCitations(candidate);

      return {
        provider: this.id,
        tier: this.tier,
        content,
        citations,
        durationMs,
        model: this.model,
        tokenUsage: {
          input: data.usageMetadata?.promptTokenCount,
          output: data.usageMetadata?.candidatesTokenCount,
        },
        usage: geminiUsage(
          data.usageMetadata,
          candidate?.groundingMetadata?.webSearchQueries,
        ),
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

  private extractCitations(candidate?: GeminiGroundedCandidate): Citation[] {
    const chunks = candidate?.groundingMetadata?.groundingChunks;
    if (!Array.isArray(chunks)) return [];

    const seen = new Set<string>();
    const citations: Citation[] = [];

    for (const chunk of chunks) {
      const url = chunk.web?.uri;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      citations.push({
        url,
        title: chunk.web?.title,
        provider: this.id,
      });
    }

    return citations;
  }
}
