import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import { BaseProvider, type BaseProviderOptions } from './base.js';

interface GrokCitationAnnotation {
  type?: string;
  url?: string;
  start_index?: number;
  end_index?: number;
  title?: string;
}

interface GrokOutputText {
  type?: string;
  text?: string;
  annotations?: GrokCitationAnnotation[];
}

interface GrokOutputItem extends GrokOutputText {
  content?: GrokOutputText[];
}

interface GrokUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
  cost_in_usd_ticks?: number;
  [key: string]: unknown;
}

// xAI reports actual request cost in "ticks" of 10^-10 USD
// (verified against the published per-token and per-search prices).
const USD_PER_COST_TICK = 1e-10;

interface GrokResponse {
  model?: string;
  output?: GrokOutputItem[];
  usage?: GrokUsage;
  server_side_tool_usage?: unknown;
  error?: unknown;
}

export interface GrokProviderOptions extends BaseProviderOptions {
  model?: string;
}

const DEFAULT_GROK_MODEL = 'grok-4.5';
const GROK_RESPONSES_URL = 'https://api.x.ai/v1/responses';
const GROK_MODELS_URL = 'https://api.x.ai/v1/models';

/**
 * xAI Grok grounded answer provider.
 * Uses the Responses API with web search enabled for every request.
 * Tier: ai-grounded (sync)
 */
export class GrokProvider extends BaseProvider {
  readonly id = 'grok';
  readonly tier: ProviderTier = 'ai-grounded';
  readonly model: string;

  constructor(options: GrokProviderOptions = {}) {
    super(options);
    this.model = options.model?.trim() || DEFAULT_GROK_MODEL;
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();

    try {
      const apiKey = this.getApiKey();
      const response = await this.request<GrokResponse>(GROK_RESPONSES_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: {
          model: this.model,
          input: [{ role: 'user', content: query }],
          // Keep this exact: xAI's legacy x_search must never be sent.
          tools: [{ type: 'web_search' }],
        },
        timeout: options.timeout * 1000,
        signal: options.signal,
      });

      const durationMs = Math.round(performance.now() - start);
      const data = response.data;

      if (response.status < 200 || response.status >= 300) {
        return this.errorResult(
          durationMs,
          this.formatError(response.status, data),
        );
      }

      if (!data || typeof data !== 'object') {
        return this.errorResult(
          durationMs,
          'Grok response did not include a valid response body',
        );
      }

      // xAI includes `error: null` on successful responses; only a non-null
      // error value indicates a failure.
      if (data.error !== undefined && data.error !== null) {
        return this.errorResult(
          durationMs,
          `Grok API error: ${this.errorMessage(data.error)}`,
        );
      }

      const { content, citations } = this.extractOutput(data.output);
      if (!content) {
        return this.errorResult(
          durationMs,
          'Grok response did not include output text',
        );
      }

      return {
        provider: this.id,
        tier: this.tier,
        content,
        citations,
        durationMs,
        model: data.model ?? this.model,
        tokenUsage: {
          input: data.usage?.input_tokens,
          output: data.usage?.output_tokens,
        },
        usage: this.extractUsage(data.usage, data.server_side_tool_usage),
      };
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      return this.errorResult(durationMs, this.formatCatchError(err));
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const apiKey = this.getApiKey();
      const response = await this.request(GROK_MODELS_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 10000,
      });

      if (response.status >= 200 && response.status < 300) return { ok: true };
      return {
        ok: false,
        error: this.formatError(response.status, response.data),
      };
    } catch (err) {
      return { ok: false, error: this.formatCatchError(err) };
    }
  }

  protected override formatError(status: number, data: unknown): string {
    const base = `API returned ${status}: ${this.errorMessage(data)}`;
    // Live-verified: xAI reports a bad API key as HTTP 400, not 401.
    if (status === 401 || (status === 400 && /api key/i.test(base))) {
      return `${base} — check XAI_API_KEY and access in https://console.x.ai`;
    }
    if (status === 403) {
      return `${base} — check xAI Console permissions or contact your team admin`;
    }
    if (status === 429) {
      return `${base} — check xAI Console rate limits`;
    }
    return base;
  }

  private errorResult(durationMs: number, error: string): ProviderResult {
    return {
      provider: this.id,
      tier: this.tier,
      content: '',
      citations: [],
      durationMs,
      error,
    };
  }

  private errorMessage(data: unknown): string {
    if (typeof data === 'string') return data.slice(0, 200);
    if (data && typeof data === 'object') {
      const record = data as Record<string, unknown>;
      if (typeof record.message === 'string')
        return record.message.slice(0, 200);
      if (typeof record.error === 'string') return record.error.slice(0, 200);
      if (record.error && typeof record.error === 'object') {
        const nested = record.error as Record<string, unknown>;
        if (typeof nested.message === 'string')
          return nested.message.slice(0, 200);
      }
    }

    try {
      return (JSON.stringify(data) ?? String(data)).slice(0, 200);
    } catch {
      return String(data).slice(0, 200);
    }
  }

  private extractOutput(output?: GrokOutputItem[]): {
    content: string;
    citations: Citation[];
  } {
    const contentParts: string[] = [];
    const citationParts: GrokOutputText[] = [];

    for (const item of output ?? []) {
      const parts = Array.isArray(item.content) ? item.content : [item];
      for (const part of parts) {
        if (part.type && part.type !== 'output_text') continue;
        if (typeof part.text === 'string') contentParts.push(part.text);
        if (Array.isArray(part.annotations)) citationParts.push(part);
      }
    }

    return {
      content: contentParts.join('\n').trim(),
      citations: this.extractCitations(citationParts),
    };
  }

  private extractCitations(parts: GrokOutputText[]): Citation[] {
    const citations: Citation[] = [];
    const seen = new Set<string>();

    for (const part of parts) {
      const text = part.text ?? '';
      for (const annotation of part.annotations ?? []) {
        if (annotation.type !== 'url_citation' || !annotation.url) continue;
        if (seen.has(annotation.url)) continue;
        seen.add(annotation.url);
        const title = this.deriveCitationTitle(annotation, text);
        citations.push({
          url: annotation.url,
          ...(title ? { title } : {}),
          provider: this.id,
        });
      }
    }

    return citations;
  }

  private deriveCitationTitle(
    annotation: GrokCitationAnnotation,
    text: string,
  ): string | undefined {
    // xAI's title field is the inline display number (for example, "1"), not
    // the source title. Never surface it as citation metadata.
    if (annotation.title && !/^\d+$/.test(annotation.title.trim())) {
      return annotation.title.trim();
    }

    if (
      typeof annotation.start_index !== 'number' ||
      annotation.start_index < 0 ||
      annotation.start_index > text.length
    ) {
      return undefined;
    }

    const preceding = text.slice(0, annotation.start_index).trim();
    const candidate = preceding
      .split(/[.!?\n]/)
      .at(-1)
      ?.replace(/\[\[\d+\]\]\([^)]*\)\s*$/u, '')
      .trim();
    return candidate && candidate.length >= 8
      ? candidate.slice(0, 160)
      : undefined;
  }

  private extractUsage(
    usage?: GrokUsage,
    serverSideToolUsage?: unknown,
  ): ProviderUsage | undefined {
    if (!usage && serverSideToolUsage === undefined) return undefined;

    // Key serialization for server_side_tool_usage is not documented. Keep the
    // complete object intact rather than guessing at a web-search count.
    const raw: Record<string, unknown> = {};
    if (usage) raw.usage = usage;
    if (serverSideToolUsage !== undefined) {
      raw.server_side_tool_usage = serverSideToolUsage;
    }

    const result: ProviderUsage = {
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      totalTokens: usage?.total_tokens,
      raw,
    };
    if (
      typeof usage?.cost_in_usd_ticks === 'number' &&
      Number.isFinite(usage.cost_in_usd_ticks) &&
      usage.cost_in_usd_ticks >= 0
    ) {
      result.costUsd = usage.cost_in_usd_ticks * USD_PER_COST_TICK;
    }
    return result;
  }
}
