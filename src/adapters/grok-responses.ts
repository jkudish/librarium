import { classifySourceKindFromUrl } from '../core/source-kind.js';
import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import { BaseProvider, type BaseProviderOptions } from './base.js';
import {
  type GrokSearchStrategy,
  type GrokValidatedOptions,
  validateGrokOptions,
} from './grok-options.js';

export {
  type GrokSearchStrategy,
  type GrokValidatedOptions,
  grokCombinedOptionsSchema,
  grokWebOptionsSchema,
  grokXOnlyOptionsSchema,
  validateGrokOptions,
} from './grok-options.js';

export const DEFAULT_GROK_MODEL = 'grok-4.6';
export const GROK_RESPONSES_URL = 'https://api.x.ai/v1/responses';
export const GROK_MODELS_URL = 'https://api.x.ai/v1/models';

/** xAI reports actual request cost in ticks of 10^-10 USD. */
const USD_PER_COST_TICK = 1e-10;

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

interface GrokResponse {
  model?: string;
  output?: GrokOutputItem[];
  usage?: GrokUsage;
  server_side_tool_usage?: unknown;
  error?: unknown;
}

/**
 * Classify a citation URL from unambiguous identity only.
 * Never invents tool provenance from the profile strategy.
 */
export const classifyGrokSourceKind = classifySourceKindFromUrl;

export function buildGrokTools(
  strategy: GrokSearchStrategy,
  options: GrokValidatedOptions,
): Record<string, unknown>[] {
  const tools: Record<string, unknown>[] = [];

  if (strategy === 'web' || strategy === 'combined') {
    const web: Record<string, unknown> = { type: 'web_search' };
    const filters: Record<string, unknown> = {};
    if (options.allowedDomains)
      filters.allowed_domains = options.allowedDomains;
    if (options.excludedDomains) {
      filters.excluded_domains = options.excludedDomains;
    }
    if (Object.keys(filters).length > 0) web.filters = filters;
    if (options.enableImageUnderstanding === true) {
      web.enable_image_understanding = true;
    }
    if (options.enableImageSearch === true) web.enable_image_search = true;
    tools.push(web);
  }

  if (strategy === 'x' || strategy === 'combined') {
    const x: Record<string, unknown> = { type: 'x_search' };
    if (options.allowedXHandles) x.allowed_x_handles = options.allowedXHandles;
    if (options.excludedXHandles) {
      x.excluded_x_handles = options.excludedXHandles;
    }
    if (options.fromDate) x.from_date = options.fromDate;
    if (options.toDate) x.to_date = options.toDate;
    if (options.enableImageUnderstanding === true) {
      x.enable_image_understanding = true;
    }
    if (options.enableVideoUnderstanding === true) {
      x.enable_video_understanding = true;
    }
    tools.push(x);
  }

  return tools;
}

export function buildGrokRequestBody(
  model: string,
  query: string,
  strategy: GrokSearchStrategy,
  options: GrokValidatedOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    input: [{ role: 'user', content: query }],
    tools: buildGrokTools(strategy, options),
  };
  if (options.maxTurns !== undefined) body.max_turns = options.maxTurns;
  if (options.maxOutputTokens !== undefined) {
    body.max_output_tokens = options.maxOutputTokens;
  }
  return body;
}

export interface GrokResponsesProviderOptions extends BaseProviderOptions {
  model?: string;
  /** Pre-validated adapter options from provider config. */
  searchOptions?: unknown;
}

/**
 * Shared xAI Responses implementation with an immutable search strategy.
 * Three thin adapters bind distinct adapter ids to web / x / combined.
 */
export class GrokResponsesProvider extends BaseProvider {
  readonly id: string;
  readonly tier: ProviderTier = 'ai-grounded';
  readonly strategy: GrokSearchStrategy;
  readonly model: string;
  private readonly searchOptions: GrokValidatedOptions;

  constructor(
    id: string,
    strategy: GrokSearchStrategy,
    options: GrokResponsesProviderOptions = {},
  ) {
    super(options);
    this.id = id;
    this.strategy = strategy;
    this.model = options.model?.trim() || DEFAULT_GROK_MODEL;
    // Fail closed at construction so invalid config never reaches the network.
    this.searchOptions = validateGrokOptions(
      strategy,
      options.searchOptions ?? {},
    );
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
        body: buildGrokRequestBody(
          this.model,
          query,
          this.strategy,
          this.searchOptions,
        ),
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

    // Keep the complete objects intact rather than guessing at tool counts.
    const raw: Record<string, unknown> = {
      strategy: this.strategy,
      configured: this.configuredMediaMeta(),
    };
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

  private configuredMediaMeta(): Record<string, unknown> {
    return {
      enable_image_understanding:
        this.searchOptions.enableImageUnderstanding === true,
      enable_image_search: this.searchOptions.enableImageSearch === true,
      enable_video_understanding:
        this.searchOptions.enableVideoUnderstanding === true,
    };
  }
}
