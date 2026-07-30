import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import { BaseProvider, type BaseProviderOptions } from './base.js';

interface AnthropicTextBlock {
  type?: string;
  text?: string;
  citations?: AnthropicCitation[];
}

interface AnthropicCitation {
  type?: string;
  url?: string;
  title?: string;
  cited_text?: string;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  server_tool_use?: {
    web_search_requests?: number;
  };
}

interface AnthropicResponse {
  model?: string;
  content?: AnthropicTextBlock[];
  stop_reason?: string;
  usage?: AnthropicUsage;
  error?: {
    type?: string;
    message?: string;
  };
}

export interface ClaudeProviderOptions extends BaseProviderOptions {
  model?: string;
  webSearch?: boolean;
  maxTokens?: unknown;
  thinking?: unknown;
  effort?: unknown;
}

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 16000;
const THINKING_MODES = ['adaptive', 'disabled'] as const;
type ThinkingMode = (typeof THINKING_MODES)[number];
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type EffortLevel = (typeof EFFORT_LEVELS)[number];

function parseMaxTokens(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_TOKENS;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  throw new Error('claude options.maxTokens must be a positive integer');
}

function parseThinking(value: unknown): ThinkingMode | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value === 'string' &&
    THINKING_MODES.includes(value as ThinkingMode)
  ) {
    return value as ThinkingMode;
  }
  throw new Error(
    `claude options.thinking must be one of: ${THINKING_MODES.join(', ')}`,
  );
}

function parseEffort(value: unknown): EffortLevel | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value === 'string' &&
    EFFORT_LEVELS.includes(value as EffortLevel)
  ) {
    return value as EffortLevel;
  }
  throw new Error(
    `claude options.effort must be one of: ${EFFORT_LEVELS.join(', ')}`,
  );
}

/**
 * Claude LLM provider.
 * Uses Anthropic web search by default for current answers and citations.
 * Tier: llm (sync)
 */
export class ClaudeProvider extends BaseProvider {
  readonly id = 'claude';
  readonly tier: ProviderTier = 'llm';
  readonly model: string;
  readonly webSearch: boolean;
  private readonly configuredMaxTokens?: unknown;
  private readonly configuredThinking?: unknown;
  private readonly configuredEffort?: unknown;

  constructor(options: ClaudeProviderOptions = {}) {
    super(options);
    this.model = options.model?.trim() || DEFAULT_CLAUDE_MODEL;
    this.webSearch = options.webSearch ?? true;
    this.configuredMaxTokens = options.maxTokens;
    this.configuredThinking = options.thinking;
    this.configuredEffort = options.effort;
  }

  get maxTokens(): number {
    return parseMaxTokens(this.configuredMaxTokens);
  }

  get thinking(): ThinkingMode | undefined {
    return (
      parseThinking(this.configuredThinking) ??
      (this.model === DEFAULT_CLAUDE_MODEL ? 'adaptive' : undefined)
    );
  }

  get effort(): EffortLevel | undefined {
    return (
      parseEffort(this.configuredEffort) ??
      (this.model === DEFAULT_CLAUDE_MODEL ? 'medium' : undefined)
    );
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const body: Record<string, unknown> = {
        model: this.model,
        max_tokens: this.maxTokens,
        messages: [{ role: 'user', content: query }],
      };
      const thinking = this.thinking;
      const effort = this.effort;
      if (thinking) body.thinking = { type: thinking };
      if (effort) body.output_config = { effort };
      if (this.webSearch) {
        body.tools = [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 5,
          },
        ];
      }

      const response = await this.request<AnthropicResponse>(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body,
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

      const content =
        data.content
          ?.filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .filter(Boolean)
          .join('\n')
          .trim() ?? '';
      const citations = this.extractCitations(data.content);

      if (!content) {
        // A 200 with no usable text is not a success: surface the model's
        // stop_reason (e.g. max_tokens, refusal) so it can fail over rather
        // than inflate the success count with an empty answer.
        const reason = data.stop_reason
          ? `stop_reason: ${data.stop_reason}`
          : 'no content blocks returned';
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          error: `Claude returned an empty response (${reason})`,
        };
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

  async test(): Promise<{ ok: boolean; error?: string }> {
    const result = await this.execute('ping', { timeout: 10 });
    if (!result.error) return { ok: true };
    return { ok: false, error: result.error };
  }

  private extractUsage(usage?: AnthropicUsage): ProviderUsage | undefined {
    if (!usage) return undefined;
    const input = usage.input_tokens;
    const output = usage.output_tokens;
    if (input === undefined && output === undefined) return undefined;
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens:
        input !== undefined && output !== undefined
          ? input + output
          : undefined,
      raw: usage,
    };
  }

  private extractCitations(blocks?: AnthropicTextBlock[]): Citation[] {
    if (!Array.isArray(blocks)) return [];

    const seen = new Set<string>();
    const citations: Citation[] = [];

    for (const block of blocks) {
      if (block.type !== 'text' || !Array.isArray(block.citations)) continue;
      for (const citation of block.citations) {
        if (
          citation.type !== 'web_search_result_location' ||
          !citation.url ||
          seen.has(citation.url)
        ) {
          continue;
        }
        seen.add(citation.url);
        citations.push({
          url: citation.url,
          title: citation.title,
          snippet: citation.cited_text,
          provider: this.id,
        });
      }
    }

    return citations;
  }
}
