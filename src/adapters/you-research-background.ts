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
const YouId = z.string().uuid();
const YouSource = z.object({
  url: z.string().url(),
  title: z.string().min(1).optional(),
  snippets: z.array(z.string()).optional(),
});
type YouSource = z.infer<typeof YouSource>;
const YouOutput = z.object({
  content: z.union([
    z.string().trim().min(1),
    z
      .record(z.string(), z.unknown())
      .refine((value) => Object.keys(value).length > 0),
  ]),
  content_type: z.enum(['text', 'object']).optional(),
  sources: z.array(YouSource),
});
const YouSubmit = z.object({
  task_id: YouId,
  type: z.literal('research'),
  status: z.literal('queued'),
  created_at: z.string().datetime({ offset: true }),
  stream_url: z.string().min(1).optional(),
});
const YouTask = z.object({
  id: YouId,
  task_type: z.literal('research'),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }).nullable().optional(),
  completed_at: z.string().datetime({ offset: true }).nullable().optional(),
  error: z.string().min(1).nullable(),
  result: z
    .object({ output: YouOutput, warnings: z.array(z.unknown()).optional() })
    .nullable(),
});
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
      response = await this.request<unknown>(URL, {
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
    const parsed = YouSubmit.safeParse(response.data);
    if (!parsed.success) {
      const id = YouId.safeParse(
        (response.data as { task_id?: unknown })?.task_id,
      );
      if (!id.success)
        throw new UnsafeToRetrySubmissionError(
          'You.com returned an invalid research handle',
        );
      return {
        provider: this.id,
        taskId: id.data,
        query,
        submittedAt: Date.now(),
        status: 'failed',
        providerStatus: 'invalid_response',
        lastPollError: 'You.com returned a malformed create response',
      };
    }
    return {
      provider: this.id,
      taskId: parsed.data.task_id,
      query,
      submittedAt: Date.parse(parsed.data.created_at),
      status: 'pending',
      providerStatus: 'queued',
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
    const parsed = YouTask.safeParse(response.data);
    if (!parsed.success)
      return {
        status: 'failed',
        rawStatus: 'invalid_response',
        message: 'You.com returned a malformed status response',
      };
    const status = statuses[parsed.data.status];
    return status
      ? {
          status,
          rawStatus: parsed.data.status,
          message: parsed.data.error ?? undefined,
        }
      : {
          status: 'failed',
          rawStatus: 'invalid_status',
          message: 'Unknown You.com status',
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
      const parsed = YouTask.safeParse(response.data);
      if (!parsed.success)
        return this.error(
          start,
          'You.com returned a malformed completed response',
        );
      if (statuses[parsed.data.status] !== 'completed')
        return this.error(
          start,
          parsed.data.error ??
            `Task is not complete: status=${parsed.data.status}`,
        );
      const output = parsed.data.result?.output;
      if (!output) return this.error(start, 'You.com completed without output');
      const content = output.content;
      return {
        provider: this.id,
        tier: this.tier,
        content:
          typeof content === 'string'
            ? content
            : JSON.stringify(content, null, 2),
        citations: citations(output.sources, this.id),
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
    return this.request<unknown>(`${URL}/${encodeURIComponent(id)}`, {
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
