import { UnsafeToRetrySubmissionError } from '../core/errors.js';
import type {
  AsyncPollResult,
  AsyncTaskHandle,
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import { BackgroundBaseProvider } from './base.js';

interface PerplexityMessage {
  role: string;
  content: string;
}

interface PerplexityChoice {
  message: PerplexityMessage;
}

interface PerplexityUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: { total_cost?: number };
}

interface PerplexitySearchResult {
  url: string;
  title?: string;
  snippet?: string;
}

interface PerplexityResponse {
  id: string;
  model?: string;
  choices: PerplexityChoice[];
  citations?: string[];
  search_results?: PerplexitySearchResult[];
  usage?: PerplexityUsage;
}

/**
 * Async Sonar API envelope.
 * POST https://api.perplexity.ai/v1/async/sonar (body: { request: {...} })
 * GET  https://api.perplexity.ai/v1/async/sonar/{id}
 * Verified against https://docs.perplexity.ai/api-reference/async-sonar-post
 * and async-sonar-api-request-get (status enum CREATED, IN_PROGRESS,
 * COMPLETED, FAILED; final completion under `response`).
 */
interface AsyncSonarEnvelope {
  id: string;
  model?: string;
  created_at?: number;
  started_at?: number | null;
  completed_at?: number | null;
  failed_at?: number | null;
  error_message?: string | null;
  status: string;
  response?: PerplexityResponse | null;
}

const ASYNC_SONAR_URL = 'https://api.perplexity.ai/v1/async/sonar';

const ASYNC_STATUS_MAP: Record<string, AsyncTaskHandle['status']> = {
  CREATED: 'pending',
  IN_PROGRESS: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  INCOMPLETE: 'failed',
};

/**
 * Perplexity Sonar Deep Research provider.
 * Uses the sonar-deep-research model via the Chat Completions API for comprehensive research queries.
 * Tier: deep-research (async capable)
 */
export class PerplexitySonarDeepProvider extends BackgroundBaseProvider {
  readonly id = 'perplexity-sonar-deep';
  readonly tier: ProviderTier = 'deep-research';

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const apiKey = this.getApiKey();

    try {
      const response = await this.request<PerplexityResponse>(
        'https://api.perplexity.ai/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: {
            model: 'sonar-deep-research',
            messages: [{ role: 'user', content: query }],
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
      const content = data.choices?.[0]?.message?.content ?? '';
      const citations = this.extractCitations(data.citations);

      return {
        provider: this.id,
        tier: this.tier,
        content,
        citations,
        durationMs,
        model: data.model ?? 'sonar-deep-research',
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

  /**
   * Submit to the Async Sonar API. Returns a real pending handle; the
   * dispatcher queues it and `librarium status` polls and retrieves it.
   * Submission failures are terminal because the remote service may have
   * accepted the paid background job even when no response arrived.
   */
  async submit(
    query: string,
    options: ProviderOptions,
  ): Promise<AsyncTaskHandle> {
    const apiKey = this.getApiKey();

    let response;
    try {
      response = await this.request<AsyncSonarEnvelope>(ASYNC_SONAR_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: {
          request: {
            model: 'sonar-deep-research',
            messages: [{ role: 'user', content: query }],
          },
        },
        timeout: 30000,
        signal: options.signal,
      });
    } catch (error) {
      throw new UnsafeToRetrySubmissionError(
        error instanceof Error ? error.message : String(error),
      );
    }

    if (response.status !== 200 && response.status !== 201) {
      throw new UnsafeToRetrySubmissionError(
        this.formatError(response.status, response.data),
      );
    }

    const data = response.data;
    return {
      provider: this.id,
      taskId: data.id,
      query,
      submittedAt: Date.now(),
      status: ASYNC_STATUS_MAP[data.status] ?? 'pending',
      providerStatus: data.status,
      ...(ASYNC_STATUS_MAP[data.status]
        ? {}
        : { lastPollError: `Unknown Perplexity async status: ${data.status}` }),
    };
  }

  async poll(handle: AsyncTaskHandle): Promise<AsyncPollResult> {
    const apiKey = this.getApiKey();

    const response = await this.request<AsyncSonarEnvelope>(
      `${ASYNC_SONAR_URL}/${handle.taskId}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 15000,
      },
    );

    if (response.status !== 200) {
      // Transport-level poll failure (429, 5xx, gateway blip): the task may
      // still be running server-side. Throw so the caller retries on the next
      // poll instead of persisting a terminal failure.
      throw new Error(`Poll returned HTTP ${response.status}`);
    }

    const data = response.data;
    const status = ASYNC_STATUS_MAP[data.status];
    if (!status) {
      return {
        status: handle.status === 'pending' ? 'pending' : 'running',
        rawStatus: data.status,
        message: `Unknown Perplexity async status: ${data.status}`,
      };
    }
    return {
      status,
      rawStatus: data.status,
      message: data.error_message ?? undefined,
    };
  }

  async retrieve(handle: AsyncTaskHandle): Promise<ProviderResult> {
    const apiKey = this.getApiKey();
    const start = performance.now();

    try {
      const response = await this.request<AsyncSonarEnvelope>(
        `${ASYNC_SONAR_URL}/${handle.taskId}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 30000,
        },
      );

      if (response.status !== 200) {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs: Math.round(performance.now() - start),
          error: `Retrieve failed with HTTP ${response.status}`,
        };
      }

      const data = response.data;
      const status = ASYNC_STATUS_MAP[data.status] ?? 'running';

      if (status === 'failed') {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs: this.taskDurationMs(data, start),
          error: data.error_message ?? 'Async task failed',
        };
      }

      if (status !== 'completed' || !data.response) {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs: Math.round(performance.now() - start),
          error: `Task ${handle.taskId} is not completed yet (status: ${data.status})`,
        };
      }

      const completion = data.response;
      return {
        provider: this.id,
        tier: this.tier,
        content: completion.choices?.[0]?.message?.content ?? '',
        citations: this.extractAsyncCitations(completion),
        durationMs: this.taskDurationMs(data, start),
        model: completion.model ?? data.model ?? 'sonar-deep-research',
        tokenUsage: {
          input: completion.usage?.prompt_tokens,
          output: completion.usage?.completion_tokens,
        },
        usage: this.extractUsage(completion.usage),
      };
    } catch (err) {
      return {
        provider: this.id,
        tier: this.tier,
        content: '',
        citations: [],
        durationMs: Math.round(performance.now() - start),
        error: this.formatCatchError(err),
      };
    }
  }

  /** Server-side task duration when timestamps are present (seconds), else local elapsed. */
  private taskDurationMs(data: AsyncSonarEnvelope, localStart: number): number {
    const end = data.completed_at ?? data.failed_at;
    const begin = data.started_at ?? data.created_at;
    if (typeof end === 'number' && typeof begin === 'number' && end >= begin) {
      return Math.round((end - begin) * 1000);
    }
    return Math.round(performance.now() - localStart);
  }

  /** Prefer search_results (titles, snippets) over the bare citations list. */
  private extractAsyncCitations(completion: PerplexityResponse): Citation[] {
    if (completion.search_results && completion.search_results.length > 0) {
      const seen = new Set<string>();
      const citations: Citation[] = [];
      for (const result of completion.search_results) {
        if (!result.url || seen.has(result.url)) continue;
        seen.add(result.url);
        citations.push({
          url: result.url,
          title: result.title,
          snippet: result.snippet,
          provider: this.id,
        });
      }
      return citations;
    }
    return this.extractCitations(completion.citations);
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const apiKey = this.getApiKey();
      const response = await this.request<PerplexityResponse>(
        'https://api.perplexity.ai/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: {
            model: 'sonar-deep-research',
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 5,
          },
          timeout: 15000,
        },
      );

      if (response.status === 200) return { ok: true };
      return { ok: false, error: `HTTP ${response.status}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private extractCitations(urls?: string[]): Citation[] {
    if (!urls || !Array.isArray(urls)) return [];
    return urls.map((url) => ({
      url,
      provider: this.id,
    }));
  }

  private extractUsage(usage?: PerplexityUsage): ProviderUsage | undefined {
    if (!usage) return undefined;
    return {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      costUsd: usage.cost?.total_cost,
      raw: usage,
    };
  }
}
