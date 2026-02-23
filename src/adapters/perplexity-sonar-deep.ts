import type {
  AsyncPollResult,
  AsyncTaskHandle,
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider } from './base.js';

interface PerplexityMessage {
  role: string;
  content: string;
}

interface PerplexityChoice {
  message: PerplexityMessage;
}

interface PerplexityResponse {
  id: string;
  model?: string;
  choices: PerplexityChoice[];
  citations?: string[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Perplexity Sonar Deep Research provider.
 * Uses the sonar-deep-research model via the Chat Completions API for comprehensive research queries.
 * Tier: deep-research (async capable)
 */
export class PerplexitySonarDeepProvider extends BaseProvider {
  readonly id = 'perplexity-sonar-deep';
  readonly tier: ProviderTier = 'deep-research';

  private storedResults = new Map<string, ProviderResult>();

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
    const taskId = `pplx-deep-${Date.now()}`;
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
    // Perplexity deep research returns full results on the initial call
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
}
