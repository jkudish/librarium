import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider } from './base.js';

interface GeminiGroundedPart {
  text?: string;
}

interface GeminiGroundedCandidate {
  content?: {
    parts?: GeminiGroundedPart[];
  };
  groundingMetadata?: {
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
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: {
    message?: string;
    code?: number;
  };
}

const GEMINI_GROUNDED_MODEL = 'gemini-2.5-flash';

/**
 * Gemini grounded search provider.
 * Uses Gemini 2.0 Flash with the googleSearch tool.
 * Tier: ai-grounded (sync)
 */
export class GeminiGroundedProvider extends BaseProvider {
  readonly id = 'gemini-grounded';
  readonly tier: ProviderTier = 'ai-grounded';

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const response = await this.request<GeminiGroundedResponse>(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_GROUNDED_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
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

      return {
        provider: this.id,
        tier: this.tier,
        content,
        citations,
        durationMs,
        model: GEMINI_GROUNDED_MODEL,
        tokenUsage: {
          input: data.usageMetadata?.promptTokenCount,
          output: data.usageMetadata?.candidatesTokenCount,
        },
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
