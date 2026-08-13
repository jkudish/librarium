import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import type { BaseProviderOptions } from './base.js';
import { BaseProvider } from './base.js';

export type OpenRouterProfile = 'grounded' | 'chat';
export type OpenRouterDataCollection = 'allow' | 'deny';
export type OpenRouterReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export interface OpenRouterProviderOptions extends BaseProviderOptions {
  model?: string;
  webSearch?: boolean;
  providerOrder?: string[];
  allowFallbacks?: boolean;
  requireParameters?: boolean;
  dataCollection?: OpenRouterDataCollection;
  zdr?: boolean;
  reasoningEffort?: OpenRouterReasoningEffort;
  reasoningMaxTokens?: number;
  reasoningExclude?: boolean;
}

interface OpenRouterAnnotation {
  type?: string;
  url_citation?: { url?: string; title?: string; content?: string };
}

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: { reasoning_tokens?: number };
  server_tool_use?: { web_search_requests?: number };
}

interface OpenRouterResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string;
      refusal?: string | null;
      annotations?: OpenRouterAnnotation[];
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenRouterUsage;
  error?: { message?: string };
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * OpenRouter's single v2 provider implementation. Legacy adapter ids retain
 * their exact binding so v1 configuration can migrate without guessing a
 * profile. The profile is a constructor fact, never an option.
 */
export class OpenRouterProvider extends BaseProvider {
  readonly id: string;
  readonly tier: ProviderTier;
  readonly model: string;
  readonly webSearch: boolean;
  private readonly config: OpenRouterProviderOptions;

  constructor(
    readonly profile: OpenRouterProfile,
    options: OpenRouterProviderOptions,
    defaults: { id: string; tier: ProviderTier; model: string },
  ) {
    super(options);
    this.config = options;
    this.id = defaults.id;
    this.tier = defaults.tier;
    this.model = options.model?.trim() || defaults.model;
    this.webSearch = profile === 'grounded' || options.webSearch !== false;
    if (options.reasoningEffort && options.reasoningMaxTokens !== undefined) {
      throw new Error(
        'OpenRouter reasoningEffort and reasoningMaxTokens are mutually exclusive.',
      );
    }
    if (profile === 'grounded' && options.webSearch === false) {
      throw new Error(
        'OpenRouter grounded profile always requires web search.',
      );
    }
    if (options.zdr === true && this.webSearch) {
      throw new Error(
        'OpenRouter ZDR does not apply to the web plugin; disable web search before enabling ZDR.',
      );
    }
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    try {
      const response = await this.request<OpenRouterResponse>(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.getApiKey()}`,
          'HTTP-Referer': 'https://github.com/jkudish/librarium',
          'X-OpenRouter-Title': 'librarium',
        },
        body: this.requestBody(query),
        timeout: options.timeout * 1000,
        signal: options.signal,
      });
      const durationMs = Math.round(performance.now() - start);
      const data = response.data;
      if (response.status !== 200 || data.error) {
        return this.errorResult(
          durationMs,
          data.error?.message ?? this.formatError(response.status, data),
        );
      }

      const choice = data.choices?.[0];
      const content = choice?.message?.content?.trim() ?? '';
      const citations = this.extractCitations(choice?.message?.annotations);
      if (!content) {
        const refusal = choice?.message?.refusal?.trim();
        const reason = refusal
          ? `refusal: ${refusal}`
          : choice?.finish_reason
            ? `finish_reason: ${choice.finish_reason}`
            : 'empty content';
        return this.errorResult(
          durationMs,
          `OpenRouter returned an empty response (${reason})`,
        );
      }
      if (this.profile === 'grounded' && citations.length === 0) {
        return this.errorResult(
          durationMs,
          'OpenRouter grounded response did not include URL citations',
        );
      }
      return {
        provider: this.id,
        tier: this.tier,
        content,
        citations,
        durationMs,
        model: data.model?.trim() || this.model,
        tokenUsage: {
          input: data.usage?.prompt_tokens,
          output: data.usage?.completion_tokens,
        },
        usage: this.extractUsage(data.usage),
        providerMeta: this.metadata(data),
      };
    } catch (error) {
      return this.errorResult(
        Math.round(performance.now() - start),
        this.formatCatchError(error),
      );
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    const result = await this.execute('ping', { timeout: 10 });
    return result.error ? { ok: false, error: result.error } : { ok: true };
  }

  private requestBody(query: string): Record<string, unknown> {
    const provider = {
      ...(this.options.providerOrder && { order: this.options.providerOrder }),
      ...(this.options.allowFallbacks !== undefined && {
        allow_fallbacks: this.options.allowFallbacks,
      }),
      ...(this.options.requireParameters !== undefined && {
        require_parameters: this.options.requireParameters,
      }),
      ...(this.options.dataCollection && {
        data_collection: this.options.dataCollection,
      }),
      ...(this.options.zdr !== undefined && { zdr: this.options.zdr }),
    };
    const reasoning = {
      ...(this.options.reasoningEffort && {
        effort: this.options.reasoningEffort,
      }),
      ...(this.options.reasoningMaxTokens !== undefined && {
        max_tokens: this.options.reasoningMaxTokens,
      }),
      ...(this.options.reasoningExclude !== undefined && {
        exclude: this.options.reasoningExclude,
      }),
    };
    return {
      model: this.model,
      messages: [{ role: 'user', content: query }],
      ...(this.webSearch && { plugins: [{ id: 'web' }] }),
      ...(Object.keys(provider).length > 0 && { provider }),
      ...(Object.keys(reasoning).length > 0 && { reasoning }),
    };
  }

  private get options(): OpenRouterProviderOptions {
    return {
      webSearch: this.webSearch,
      ...this.config,
    };
  }

  private metadata(data: OpenRouterResponse): Record<string, unknown> {
    const usage = data.usage;
    return {
      'openrouter:profile': this.profile,
      'openrouter:search': {
        enabled: this.webSearch,
        ...(usage?.server_tool_use?.web_search_requests !== undefined && {
          requests: usage.server_tool_use.web_search_requests,
        }),
      },
      ...(this.options.providerOrder ||
      this.options.allowFallbacks !== undefined ||
      this.options.requireParameters !== undefined ||
      this.options.dataCollection ||
      this.options.zdr !== undefined
        ? {
            'openrouter:routing': {
              ...(this.options.providerOrder && {
                order: this.options.providerOrder,
              }),
              ...(this.options.allowFallbacks !== undefined && {
                allow_fallbacks: this.options.allowFallbacks,
              }),
              ...(this.options.requireParameters !== undefined && {
                require_parameters: this.options.requireParameters,
              }),
              ...(this.options.dataCollection && {
                data_collection: this.options.dataCollection,
              }),
              ...(this.options.zdr !== undefined && { zdr: this.options.zdr }),
            },
          }
        : {}),
      ...(this.options.reasoningEffort ||
      this.options.reasoningMaxTokens !== undefined ||
      this.options.reasoningExclude !== undefined
        ? {
            'openrouter:reasoning': {
              ...(this.options.reasoningEffort && {
                effort: this.options.reasoningEffort,
              }),
              ...(this.options.reasoningMaxTokens !== undefined && {
                max_tokens: this.options.reasoningMaxTokens,
              }),
              ...(this.options.reasoningExclude !== undefined && {
                exclude: this.options.reasoningExclude,
              }),
              ...(usage?.completion_tokens_details?.reasoning_tokens !==
                undefined && {
                tokens: usage.completion_tokens_details.reasoning_tokens,
              }),
            },
          }
        : {}),
    };
  }

  private extractUsage(usage?: OpenRouterUsage): ProviderUsage | undefined {
    if (!usage) return undefined;
    return {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      cacheReadInputTokens: usage.prompt_tokens_details?.cached_tokens,
      cacheWriteInputTokens: usage.prompt_tokens_details?.cache_write_tokens,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
      costUsd: usage.cost,
    };
  }

  private extractCitations(annotations?: OpenRouterAnnotation[]): Citation[] {
    const citations: Citation[] = [];
    const seen = new Set<string>();
    for (const annotation of annotations ?? []) {
      const citation =
        annotation.type === 'url_citation'
          ? annotation.url_citation
          : undefined;
      if (!citation?.url || seen.has(citation.url)) continue;
      seen.add(citation.url);
      citations.push({
        url: citation.url,
        title: citation.title,
        snippet: citation.content,
        provider: this.id,
      });
    }
    return citations;
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
}
