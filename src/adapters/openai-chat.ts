import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import { BaseProvider, type BaseProviderOptions } from './base.js';

interface OpenAIChatMessage {
  content?: string;
  refusal?: string | null;
}

interface OpenAIChatChoice {
  message?: OpenAIChatMessage;
  finish_reason?: string;
}

interface OpenAIChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAIChatResponse {
  model?: string;
  choices?: OpenAIChatChoice[];
  usage?: OpenAIChatUsage;
  error?: {
    message?: string;
    type?: string;
  };
}

interface OpenAIResponseAnnotation {
  type?: string;
  url?: string;
  title?: string;
}

interface OpenAIResponseContent {
  type?: string;
  text?: string;
  annotations?: OpenAIResponseAnnotation[];
}

interface OpenAIResponseOutputItem {
  type?: string;
  content?: OpenAIResponseContent[];
}

interface OpenAIResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface OpenAIResponsesResponse {
  model?: string;
  output?: OpenAIResponseOutputItem[];
  usage?: OpenAIResponsesUsage;
  error?: {
    message?: string;
    type?: string;
  };
}

export interface OpenAIChatProviderOptions extends BaseProviderOptions {
  model?: string;
  webSearch?: boolean;
}

const DEFAULT_OPENAI_CHAT_MODEL = 'gpt-5-mini';

/**
 * OpenAI LLM provider.
 * Uses Responses API web search by default for current answers and citations.
 * Tier: llm (sync)
 */
export class OpenAIChatProvider extends BaseProvider {
  readonly id = 'openai-chat';
  readonly tier: ProviderTier = 'llm';
  readonly model: string;
  readonly webSearch: boolean;

  constructor(options: OpenAIChatProviderOptions = {}) {
    super(options);
    this.model = options.model?.trim() || DEFAULT_OPENAI_CHAT_MODEL;
    this.webSearch = options.webSearch ?? true;
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    if (this.webSearch) return this.executeWithWebSearch(query, options);
    return this.executeChatCompletions(query, options);
  }

  private async executeChatCompletions(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const response = await this.request<OpenAIChatResponse>(
        'https://api.openai.com/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: {
            model: this.model,
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

      const choice = data.choices?.[0];
      const content = choice?.message?.content?.trim() ?? '';

      if (!content) {
        // A 200 with no usable text is not a success: surface a refusal or the
        // finish_reason (e.g. content_filter, length) so it can fail over
        // rather than inflate the success count with an empty answer.
        const refusal = choice?.message?.refusal?.trim();
        const reason = refusal
          ? `refusal: ${refusal}`
          : choice?.finish_reason
            ? `finish_reason: ${choice.finish_reason}`
            : data.choices && data.choices.length > 0
              ? 'empty content'
              : 'no choices returned';
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          error: `OpenAI returned an empty response (${reason})`,
        };
      }

      return {
        provider: this.id,
        tier: this.tier,
        content,
        citations: [],
        durationMs,
        model: data.model ?? this.model,
        tokenUsage: {
          input: data.usage?.prompt_tokens,
          output: data.usage?.completion_tokens,
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

  private async executeWithWebSearch(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const response = await this.request<OpenAIResponsesResponse>(
        'https://api.openai.com/v1/responses',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: {
            model: this.model,
            input: query,
            tools: [{ type: 'web_search' }],
            tool_choice: 'auto',
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

      const outputText = this.extractResponseText(data.output);
      const citations = this.extractResponseCitations(data.output);

      if (!outputText) {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          error: 'OpenAI returned an empty response (no output text returned)',
        };
      }

      return {
        provider: this.id,
        tier: this.tier,
        content: outputText,
        citations,
        durationMs,
        model: data.model ?? this.model,
        tokenUsage: {
          input: data.usage?.input_tokens,
          output: data.usage?.output_tokens,
        },
        usage: this.extractResponsesUsage(data.usage),
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

  private extractUsage(usage?: OpenAIChatUsage): ProviderUsage | undefined {
    if (!usage) return undefined;
    return {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      raw: usage,
    };
  }

  private extractResponsesUsage(
    usage?: OpenAIResponsesUsage,
  ): ProviderUsage | undefined {
    if (!usage) return undefined;
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
      raw: usage,
    };
  }

  private extractResponseText(output?: OpenAIResponseOutputItem[]): string {
    if (!Array.isArray(output)) return '';
    return output
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((content) => content.type === 'output_text')
      .map((content) => content.text ?? '')
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  private extractResponseCitations(
    output?: OpenAIResponseOutputItem[],
  ): Citation[] {
    if (!Array.isArray(output)) return [];

    const seen = new Set<string>();
    const citations: Citation[] = [];

    for (const item of output) {
      if (item.type !== 'message') continue;
      for (const content of item.content ?? []) {
        if (!Array.isArray(content.annotations)) continue;
        for (const annotation of content.annotations) {
          if (
            annotation.type !== 'url_citation' ||
            !annotation.url ||
            seen.has(annotation.url)
          ) {
            continue;
          }
          seen.add(annotation.url);
          citations.push({
            url: annotation.url,
            title: annotation.title,
            provider: this.id,
          });
        }
      }
    }

    return citations;
  }
}
