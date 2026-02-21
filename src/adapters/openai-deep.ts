import type {
  AsyncPollResult,
  AsyncTaskHandle,
  AsyncTaskStatus,
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider } from './base.js';

interface OpenAIAnnotation {
  type: string;
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}

interface OpenAIContentPart {
  type: string;
  text?: string;
  annotations?: OpenAIAnnotation[];
}

interface OpenAIOutputItem {
  type: string;
  id?: string;
  content?: OpenAIContentPart[];
  role?: string;
  status?: string;
}

interface OpenAIResponseBody {
  id: string;
  status: string;
  output?: OpenAIOutputItem[];
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; code?: string };
}

const STATUS_MAP: Record<string, AsyncTaskStatus> = {
  queued: 'pending',
  in_progress: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

/**
 * OpenAI Deep Research provider.
 * Uses o4-mini-deep-research model with background mode for async research.
 * Tier: deep-research (async)
 */
export class OpenAIDeepProvider extends BaseProvider {
  readonly id = 'openai-deep';
  readonly tier: ProviderTier = 'deep-research';

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();

    try {
      // Submit the request
      const handle = await this.submit(query, options);

      // Poll until complete or timeout
      const deadline = Date.now() + options.timeout * 1000;
      let pollResult: AsyncPollResult = { status: handle.status };

      while (
        pollResult.status !== 'completed' &&
        pollResult.status !== 'failed' &&
        pollResult.status !== 'cancelled' &&
        Date.now() < deadline
      ) {
        await this.sleep(5000);
        pollResult = await this.poll(handle);
        handle.status = pollResult.status;

        if (options.signal?.aborted) {
          throw new Error('Request aborted');
        }
      }

      if (pollResult.status !== 'completed') {
        const durationMs = Math.round(performance.now() - start);
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          error: `Task did not complete: status=${pollResult.status}`,
        };
      }

      const result = await this.retrieve(handle);
      result.durationMs = Math.round(performance.now() - start);
      return result;
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
    _options: ProviderOptions,
  ): Promise<AsyncTaskHandle> {
    const apiKey = this.getApiKey();

    const response = await this.request<OpenAIResponseBody>(
      'https://api.openai.com/v1/responses',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: {
          model: 'o4-mini-deep-research',
          input: [{ role: 'user', content: query }],
          tools: [{ type: 'web_search_preview' }],
          background: true,
        },
        timeout: 30000,
      },
    );

    if (response.status !== 200) {
      throw new Error(this.formatError(response.status, response.data));
    }

    const data = response.data;
    const status = STATUS_MAP[data.status] ?? 'pending';

    return {
      provider: this.id,
      taskId: data.id,
      query,
      submittedAt: Date.now(),
      status,
    };
  }

  async poll(handle: AsyncTaskHandle): Promise<AsyncPollResult> {
    const apiKey = this.getApiKey();

    const response = await this.request<OpenAIResponseBody>(
      `https://api.openai.com/v1/responses/${handle.taskId}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 15000,
      },
    );

    if (response.status !== 200) {
      return {
        status: 'failed',
        message: `Poll returned HTTP ${response.status}`,
      };
    }

    const data = response.data;
    const status = STATUS_MAP[data.status] ?? 'running';

    return {
      status,
      message: data.error?.message,
    };
  }

  async retrieve(handle: AsyncTaskHandle): Promise<ProviderResult> {
    const apiKey = this.getApiKey();
    const start = performance.now();

    try {
      const response = await this.request<OpenAIResponseBody>(
        `https://api.openai.com/v1/responses/${handle.taskId}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 30000,
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
          error: `Retrieve failed with HTTP ${response.status}`,
        };
      }

      const data = response.data;
      const { content, citations } = this.extractOutput(data);

      return {
        provider: this.id,
        tier: this.tier,
        content,
        citations,
        durationMs,
        model: data.model ?? 'o4-mini-deep-research',
        tokenUsage: {
          input: data.usage?.input_tokens,
          output: data.usage?.output_tokens,
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
    try {
      const apiKey = this.getApiKey();
      // Use a lightweight models endpoint to verify key validity
      const response = await this.request(
        'https://api.openai.com/v1/models/o4-mini-deep-research',
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 10000,
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

  private extractOutput(data: OpenAIResponseBody): {
    content: string;
    citations: Citation[];
  } {
    const citations: Citation[] = [];
    const contentParts: string[] = [];

    if (!data.output) return { content: '', citations };

    for (const item of data.output) {
      if (item.type === 'message' && item.content) {
        for (const part of item.content) {
          if (part.text) {
            contentParts.push(part.text);
          }
          if (part.annotations) {
            for (const ann of part.annotations) {
              if (ann.type === 'url_citation' && ann.url) {
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
    }

    return { content: contentParts.join('\n'), citations };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
