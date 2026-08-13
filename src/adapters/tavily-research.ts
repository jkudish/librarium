import { z } from 'zod';
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

const TavilyId = z.string().trim().min(1).max(255);
const TavilySource = z.object({
  title: z.string().min(1).optional(),
  url: z.string().url(),
  favicon: z.string().url().optional(),
});
type TavilySource = z.infer<typeof TavilySource>;
const TavilyPending = z.object({
  request_id: TavilyId,
  created_at: z.string().datetime({ offset: true }),
  status: z.literal('pending'),
  input: z.string().min(1),
  model: z.enum(['mini', 'pro', 'auto']),
  response_time: z.number().nonnegative(),
});
const TavilyInProgress = z.object({
  request_id: TavilyId,
  status: z.literal('in_progress'),
  response_time: z.number().nonnegative(),
});
const TavilyCompleted = z.object({
  request_id: TavilyId,
  created_at: z.string().datetime({ offset: true }),
  status: z.literal('completed'),
  content: z.union([
    z.string().trim().min(1),
    z
      .record(z.string(), z.unknown())
      .refine((value) => Object.keys(value).length > 0),
  ]),
  sources: z.array(TavilySource),
  response_time: z.number().nonnegative(),
});
const TavilyFailed = z.object({
  request_id: TavilyId,
  status: z.literal('failed'),
  error: z.union([z.string().min(1), z.object({ message: z.string().min(1) })]),
});
type TavilyTerminal =
  | z.infer<typeof TavilyCompleted>
  | z.infer<typeof TavilyFailed>;

const URL = 'https://api.tavily.com/research';

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
      response = await this.request<unknown>(URL, {
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
    const parsed = TavilyPending.safeParse(response.data);
    if (!parsed.success) {
      const id = TavilyId.safeParse(
        (response.data as { request_id?: unknown })?.request_id,
      );
      if (!id.success)
        throw new UnsafeToRetrySubmissionError(
          'Tavily returned an invalid research handle',
        );
      return {
        provider: this.id,
        taskId: id.data,
        query,
        submittedAt: Date.now(),
        status: 'failed',
        providerStatus: 'invalid_response',
        lastPollError: 'Tavily returned a malformed create response',
      };
    }
    return {
      provider: this.id,
      taskId: parsed.data.request_id,
      query,
      submittedAt: Date.parse(parsed.data.created_at),
      status: 'pending',
      providerStatus: 'pending',
    };
  }

  async poll(handle: AsyncTaskHandle): Promise<AsyncPollResult> {
    const response = await this.task(handle.taskId, 15_000);
    if (response.status === 202) {
      const parsed = TavilyInProgress.safeParse(response.data);
      return parsed.success
        ? { status: 'running', rawStatus: 'in_progress' }
        : {
            status: 'failed',
            rawStatus: 'invalid_response',
            message: 'Tavily returned a malformed in-progress response',
          };
    }
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
    const parsed = z
      .union([TavilyCompleted, TavilyFailed])
      .safeParse(response.data);
    if (!parsed.success)
      return {
        status: 'failed',
        rawStatus: 'invalid_response',
        message: 'Tavily returned a malformed terminal response',
      };
    return parsed.data.status === 'completed'
      ? { status: 'completed', rawStatus: 'completed' }
      : {
          status: 'failed',
          rawStatus: 'failed',
          message: message(parsed.data.error),
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
      const parsed = z
        .union([TavilyCompleted, TavilyFailed])
        .safeParse(response.data);
      if (!parsed.success)
        return this.error(
          start,
          'Tavily returned a malformed terminal response',
        );
      const task: TavilyTerminal = parsed.data;
      if (task.status !== 'completed')
        return this.error(start, message(task.error));
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
    return this.request<unknown>(`${URL}/${encodeURIComponent(requestId)}`, {
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

function message(error: z.infer<typeof TavilyFailed>['error']): string {
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
