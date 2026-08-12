import type {
  AsyncPollResult,
  AsyncTaskHandle,
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderUsage,
} from '../types.js';
import type { BaseProviderOptions } from './base.js';
import { BackgroundBaseProvider } from './base.js';

interface AgentAnnotation {
  type: string;
  url?: string;
  title?: string;
}

interface AgentContentPart {
  type: string;
  text?: string;
  annotations?: AgentAnnotation[];
}

interface AgentOutputItem {
  type: string;
  id?: string;
  content?: AgentContentPart[];
  role?: string;
  status?: string;
  results?: AgentSearchResult[];
}

interface AgentSearchResult {
  url: string;
  title?: string;
  snippet?: string;
}

interface AgentUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface AgentResponseBody {
  id: string;
  status: string;
  model?: string;
  output?: AgentOutputItem[];
  usage?: AgentUsage;
  error?: { message?: string; code?: string };
}

const AGENT_API_URL = 'https://api.perplexity.ai/v1/agent';

/**
 * Shared base for Perplexity Agent API providers (preset-based).
 * Subclasses only need to declare id, tier, and preset.
 */
export abstract class PerplexityAgentBaseProvider extends BackgroundBaseProvider {
  abstract readonly preset: string;

  private readonly underlyingModel?: string;

  private storedResults = new Map<string, ProviderResult>();

  constructor(options: BaseProviderOptions & { model?: string } = {}) {
    super(options);
    this.underlyingModel = options.model?.trim() || undefined;
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const response = await this.request<AgentResponseBody>(AGENT_API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: {
          preset: this.preset,
          ...(this.underlyingModel !== undefined && {
            model: this.underlyingModel,
          }),
          input: query,
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

      if (data.status === 'failed') {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          error: data.error?.message ?? 'Agent API returned status: failed',
        };
      }

      const { content, citations } = this.extractOutput(data);

      return {
        provider: this.id,
        tier: this.tier,
        content,
        citations,
        durationMs,
        ...(data.model !== undefined && { model: data.model }),
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

  async submit(
    query: string,
    options: ProviderOptions,
  ): Promise<AsyncTaskHandle> {
    const result = await this.execute(query, options);
    const taskId = `pplx-agent-${this.preset}-${Date.now()}`;
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
      const response = await this.request<AgentResponseBody>(AGENT_API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: {
          preset: this.preset,
          ...(this.underlyingModel !== undefined && {
            model: this.underlyingModel,
          }),
          input: 'ping',
        },
        timeout: 15000,
      });

      if (response.status === 200) return { ok: true };
      return { ok: false, error: `HTTP ${response.status}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private extractOutput(data: AgentResponseBody): {
    content: string;
    citations: Citation[];
  } {
    const citations: Citation[] = [];
    const contentParts: string[] = [];
    const seenUrls = new Set<string>();

    if (!data.output) return { content: '', citations };

    for (const item of data.output) {
      if (item.type === 'message' && item.content) {
        for (const part of item.content) {
          if (part.text) {
            contentParts.push(part.text);
          }
          if (part.annotations) {
            for (const ann of part.annotations) {
              if (ann.url && !seenUrls.has(ann.url)) {
                seenUrls.add(ann.url);
                citations.push({
                  url: ann.url,
                  title: ann.title,
                  provider: this.id,
                });
              }
            }
          }
        }
      }

      if (item.type === 'search_results' && item.results) {
        for (const result of item.results) {
          if (result.url && !seenUrls.has(result.url)) {
            seenUrls.add(result.url);
            citations.push({
              url: result.url,
              title: result.title,
              snippet: result.snippet,
              provider: this.id,
            });
          }
        }
      }
    }

    return { content: contentParts.join('\n'), citations };
  }

  private extractUsage(usage?: AgentUsage): ProviderUsage | undefined {
    if (!usage) return undefined;
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
      raw: usage,
    };
  }
}
