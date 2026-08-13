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

type YouEffort = 'lite' | 'standard' | 'deep' | 'exhaustive' | 'frontier';
export interface YouResearchBackgroundProviderOptions
  extends BaseProviderOptions {
  researchEffort?: YouEffort;
  outputSchema?: Record<string, unknown>;
  includeDomains?: string[];
  excludeDomains?: string[];
  boostDomains?: string[];
  freshness?: string;
  country?: string;
}
interface YouSource {
  url: string;
  title?: string;
  snippets?: string[];
}
interface YouOutput {
  content?: string | Record<string, unknown>;
  sources?: YouSource[];
}
interface YouTask {
  task_id: string;
  status: string;
  created_at?: string;
  error?: string | { message?: string };
  result?: { output?: YouOutput } | null;
}
const URL = 'https://api.you.com/v1/research';
const statuses: Record<string, AsyncTaskHandle['status']> = {
  queued: 'pending',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** Durable You.com Research adapter bound only to `you-research/research`. */
export class YouResearchBackgroundProvider extends BackgroundBaseProvider {
  readonly id = 'you-research-background';
  get envVar(): string {
    return 'YOU_COM_API_KEY';
  }
  get displayName(): string {
    return 'You.com Research Background Adapter';
  }
  readonly tier: ProviderTier = 'deep-research';
  private readonly configured: YouResearchBackgroundProviderOptions;
  constructor(options: YouResearchBackgroundProviderOptions = {}) {
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
            'You.com research task timed out locally; the remote task may still be running.',
          );
        await wait(Math.min(1_000, deadline - Date.now()), options.signal);
        const next = await this.poll(handle);
        handle.status = next.status;
        if (next.status === 'failed' || next.status === 'cancelled')
          return this.error(
            start,
            next.message ?? `You.com research task ${next.status}`,
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
      response = await this.request<YouTask>(URL, {
        method: 'POST',
        headers: this.headers(),
        body: this.body(query),
        timeout: Math.min(options.timeout * 1_000, 30_000),
        signal: options.signal,
      });
    } catch (error) {
      throw new UnsafeToRetrySubmissionError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (
      response.status !== 200 &&
      response.status !== 201 &&
      response.status !== 202
    )
      throw new UnsafeToRetrySubmissionError(
        this.formatError(response.status, response.data),
      );
    const status = statuses[response.data.status];
    return {
      provider: this.id,
      taskId: response.data.task_id,
      query,
      submittedAt: Date.parse(response.data.created_at ?? '') || Date.now(),
      status: status ?? 'pending',
      providerStatus: response.data.status,
      ...(status
        ? {}
        : {
            lastPollError: `Unknown You.com research status: ${response.data.status}`,
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
          message: `Unknown You.com research status: ${response.data.status}`,
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
      if (statuses[response.data.status] !== 'completed')
        return this.error(
          start,
          message(response.data.error) ??
            `Task is not complete: status=${response.data.status}`,
        );
      const output = response.data.result?.output;
      const content = output?.content;
      return {
        provider: this.id,
        tier: this.tier,
        content:
          typeof content === 'string'
            ? content
            : content
              ? JSON.stringify(content, null, 2)
              : '',
        citations: citations(output?.sources, this.id),
        durationMs: Math.round(performance.now() - start),
      };
    } catch (error) {
      return this.error(start, this.formatCatchError(error));
    }
  }
  private headers(): Record<string, string> {
    return { 'X-API-Key': this.getApiKey() };
  }
  private body(input: string): Record<string, unknown> {
    const source_control = {
      ...(this.configured.includeDomains && {
        include_domains: this.configured.includeDomains,
      }),
      ...(this.configured.excludeDomains && {
        exclude_domains: this.configured.excludeDomains,
      }),
      ...(this.configured.boostDomains && {
        boost_domains: this.configured.boostDomains,
      }),
      ...(this.configured.freshness && {
        freshness: this.configured.freshness,
      }),
      ...(this.configured.country && {
        country: this.configured.country.toUpperCase(),
      }),
    };
    return {
      input,
      research_effort: this.configured.researchEffort ?? 'standard',
      background: true,
      ...(this.configured.outputSchema && {
        output_schema: this.configured.outputSchema,
      }),
      ...(Object.keys(source_control).length > 0 && { source_control }),
    };
  }
  private task(id: string, timeout: number) {
    return this.request<YouTask>(`${URL}/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: this.headers(),
      timeout,
    });
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
  sources: YouSource[] | undefined,
  provider: string,
): Citation[] {
  const seen = new Set<string>();
  return (sources ?? [])
    .filter(
      (source) =>
        Boolean(source.url) &&
        !seen.has(source.url) &&
        Boolean(seen.add(source.url)),
    )
    .map((source) => ({
      url: source.url,
      title: source.title,
      snippet: source.snippets?.[0]?.slice(0, 200),
      provider,
    }));
}
function message(error: YouTask['error']): string | undefined {
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
