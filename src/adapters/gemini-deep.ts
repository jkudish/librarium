import type {
  AsyncPollResult,
  AsyncTaskHandle,
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider } from './base.js';

interface GeminiPart {
  text?: string;
}

interface GeminiContent {
  parts: GeminiPart[];
  role?: string;
}

interface GeminiCandidate {
  content: GeminiContent;
}

interface GeminiGroundingChunk {
  web?: { uri: string; title?: string };
}

interface GeminiGroundingMetadata {
  groundingChunks?: GeminiGroundingChunk[];
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  groundingMetadata?: GeminiGroundingMetadata;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { message?: string; code?: number };
}

interface GeminiDeepProviderOptions {
  model?: string;
}

const DEFAULT_GEMINI_DEEP_MODEL = 'gemini-2.5-flash';

/**
 * Gemini Deep Research provider.
 * Uses Gemini with Google Search grounding for research.
 * Tier: deep-research (sync - wraps execute for async interface)
 */
export class GeminiDeepProvider extends BaseProvider {
  readonly id = 'gemini-deep';
  readonly tier: ProviderTier = 'deep-research';
  readonly model: string;

  private storedResults = new Map<string, ProviderResult>();

  constructor(options: GeminiDeepProviderOptions = {}) {
    super();
    this.model = options.model?.trim() || DEFAULT_GEMINI_DEEP_MODEL;
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${apiKey}`;

      const response = await this.request<GeminiResponse>(url, {
        method: 'POST',
        body: {
          contents: [{ parts: [{ text: query }] }],
          tools: [{ googleSearch: {} }],
        },
        timeout: options.timeout * 1000,
        signal: options.signal,
      });

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
          ?.map((p) => p.text ?? '')
          .join('') ?? '';

      const citations = this.extractCitations(data.groundingMetadata);

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

  async submit(
    query: string,
    options: ProviderOptions,
  ): Promise<AsyncTaskHandle> {
    const result = await this.execute(query, options);
    const taskId = `gemini-deep-${Date.now()}`;
    this.storedResults.set(taskId, result);

    return {
      provider: this.id,
      taskId,
      query,
      submittedAt: Date.now(),
      status: result.error ? 'failed' : 'completed',
      completedAt: Date.now(),
    };
  }

  async poll(_handle: AsyncTaskHandle): Promise<AsyncPollResult> {
    // Gemini doesn't have a true async/background mode
    return { status: 'completed', progress: 100 };
  }

  async retrieve(handle: AsyncTaskHandle): Promise<ProviderResult> {
    const stored = this.storedResults.get(handle.taskId);
    if (stored) {
      this.storedResults.delete(handle.taskId);
      return stored;
    }

    return {
      provider: this.id,
      tier: this.tier,
      content: '',
      citations: [],
      durationMs: 0,
      error: `No stored result for task ${handle.taskId}`,
    };
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const apiKey = this.getApiKey();
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${apiKey}`;

      const response = await this.request<GeminiResponse>(url, {
        method: 'POST',
        body: {
          contents: [{ parts: [{ text: 'ping' }] }],
        },
        timeout: 10000,
      });

      if (response.status === 200) return { ok: true };
      const apiError =
        typeof response.data?.error?.message === 'string'
          ? response.data.error.message
          : undefined;
      const detail = apiError ? `: ${apiError}` : '';
      return {
        ok: false,
        error: `HTTP ${response.status}${detail} (model: ${this.model})`,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private extractCitations(metadata?: GeminiGroundingMetadata): Citation[] {
    if (!metadata?.groundingChunks) return [];

    return metadata.groundingChunks
      .filter((chunk) => chunk.web?.uri)
      .map((chunk) => ({
        url: chunk.web!.uri,
        title: chunk.web!.title,
        provider: this.id,
      }));
  }
}
