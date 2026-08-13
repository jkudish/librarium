import { UnsafeToRetrySubmissionError } from '../core/errors.js';
import type {
  AsyncPollResult,
  AsyncTaskHandle,
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BackgroundBaseProvider, type BaseProviderOptions } from './base.js';

export interface TavilyResearchProviderOptions extends BaseProviderOptions {
  model?: 'mini' | 'pro' | 'auto';
  outputSchema?: Record<string, unknown>;
  citationFormat?: 'numbered' | 'mla' | 'apa' | 'chicago';
}

interface TavilySource {
  title?: string;
  url: string;
  favicon?: string;
}
interface TavilyResearchTask {
  request_id: string;
  created_at?: string;
  status: string;
  content?: string | Record<string, unknown>;
  sources?: TavilySource[];
  response_time?: number;
  error?: string | { message?: string };
}

const URL = 'https://api.tavily.com/research';
const statuses: Record<string, AsyncTaskHandle['status']> = {
  pending: 'pending',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
};

/** Durable Tavily Research adapter bound only to `tavily/research`. */
export class TavilyResearchProvider extends BackgroundBaseProvider {
  readonly id = 'tavily-research';
  get envVar(): string {
    return 'TAVILY_API_KEY';
  }
  get displayName(): string {
    return 'Tavily Research Adapter';
  }
  readonly tier: ProviderTier = 'deep-research';
  private readonly configured: TavilyResearchProviderOptions;

  constructor(options: TavilyResearchProviderOptions = {}) {
    super(options);
    this.configured = options;
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    try {
      const handle = await this.submit(query, options);
      const deadline = Date.now() + options.timeout * 1_000;
      while (handle.status === 'pending' || handle.status === 'running') {
        if (Date.now() >= deadline)
          return this.error(
            start,
            'Tavily research task timed out locally; the remote task may still be running.',
          );
        await wait(Math.min(1_000, deadline - Date.now()), options.signal);
        const next = await this.poll(handle);
        handle.status = next.status;
        if (next.status === 'failed' || next.status === 'cancelled')
          return this.error(
            start,
            next.message ?? `Tavily research task ${next.status}`,
          );
      }
      const result = await this.retrieve(handle);
      return { ...result, durationMs: Math.round(performance.now() - start) };
    } catch (error) {
      return this.error(start, this.formatCatchError(error));
    }
  }

  async submit(
    query: string,
    options: ProviderOptions,
  ): Promise<AsyncTaskHandle> {
    let response;
    try {
      response = await this.request<TavilyResearchTask>(URL, {
        method: 'POST',
        headers: this.headers(),
        body: {
          input: query,
          model: this.configured.model ?? 'auto',
          // Durable reconciliation requires polling, not the streaming API.
          stream: false,
          ...(this.configured.outputSchema && {
            output_schema: this.configured.outputSchema,
          }),
          ...(this.configured.citationFormat && {
            citation_format: this.configured.citationFormat,
          }),
        },
        timeout: Math.min(options.timeout * 1_000, 30_000),
        signal: options.signal,
      });
    } catch (error) {
      throw new UnsafeToRetrySubmissionError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (response.status !== 201) {
      throw new UnsafeToRetrySubmissionError(
        this.formatError(response.status, response.data),
      );
    }
    const status = statuses[response.data.status];
    return {
      provider: this.id,
      taskId: response.data.request_id,
      query,
      submittedAt: Date.parse(response.data.created_at ?? '') || Date.now(),
      status: status ?? 'pending',
      providerStatus: response.data.status,
      ...(status
        ? {}
        : {
            lastPollError: `Unknown Tavily Research status: ${response.data.status}`,
          }),
    };
  }

  async poll(handle: AsyncTaskHandle): Promise<AsyncPollResult> {
    const response = await this.task(handle.taskId, 15_000);
    if (response.status !== 200) {
      if (
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500
      )
        throw new Error(`Poll returned HTTP ${response.status}`);
      return {
        status: 'failed',
        rawStatus: `http_${response.status}`,
        message: `Poll returned HTTP ${response.status}`,
      };
    }
    const status = statuses[response.data.status];
    return status
      ? {
          status,
          rawStatus: response.data.status,
          message: message(response.data.error),
        }
      : {
          status: handle.status === 'pending' ? 'pending' : 'running',
          rawStatus: response.data.status,
          message: `Unknown Tavily Research status: ${response.data.status}`,
        };
  }

  async retrieve(handle: AsyncTaskHandle): Promise<ProviderResult> {
    const start = performance.now();
    try {
      const response = await this.task(handle.taskId, 30_000);
      if (response.status !== 200)
        return this.error(
          start,
          `Retrieve failed with HTTP ${response.status}`,
        );
      const task = response.data;
      if (statuses[task.status] !== 'completed')
        return this.error(
          start,
          message(task.error) ?? `Task is not complete: status=${task.status}`,
        );
      const content = task.content;
      return {
        provider: this.id,
        tier: this.tier,
        content:
          typeof content === 'string'
            ? content
            : content
              ? JSON.stringify(content, null, 2)
              : '',
        citations: citations(task.sources, this.id),
        durationMs: Math.round(performance.now() - start),
      };
    } catch (error) {
      return this.error(start, this.formatCatchError(error));
    }
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.getApiKey()}` };
  }

  private task(requestId: string, timeout: number) {
    return this.request<TavilyResearchTask>(
      `${URL}/${encodeURIComponent(requestId)}`,
      { method: 'GET', headers: this.headers(), timeout },
    );
  }

  private error(start: number, error: string): ProviderResult {
    return {
      provider: this.id,
      tier: this.tier,
      content: '',
      citations: [],
      durationMs: Math.round(performance.now() - start),
      error,
    };
  }
}

function citations(
  sources: TavilySource[] | undefined,
  provider: string,
): Citation[] {
  return (sources ?? [])
    .filter((source) => Boolean(source.url))
    .map((source) => ({
      url: source.url,
      title: source.title,
      provider,
    }));
}

function message(error: TavilyResearchTask['error']): string | undefined {
  return typeof error === 'string' ? error : error?.message;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Request aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.max(1, milliseconds));
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Request aborted'));
      },
      { once: true },
    );
  });
}
