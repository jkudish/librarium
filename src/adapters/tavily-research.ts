import { z } from 'zod';
import { UnsafeToRetrySubmissionError } from '../core/errors.js';
import type {
  AsyncPollResult,
  AsyncTaskHandle,
  Citation,
  ProviderFailureDiagnostic,
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
const CredentialFreeHttpUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      const parsed = new globalThis.URL(value);
      return (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.username === '' &&
        parsed.password === ''
      );
    } catch {
      return false;
    }
  });
const TavilySource = z.object({
  title: z.string().min(1).optional(),
  url: CredentialFreeHttpUrl,
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
const SUBMISSION_FAILED =
  'Tavily Research submission failed before a valid handle was returned.';
const POLL_FAILED = 'Tavily Research status check failed.';
const RETRIEVAL_FAILED = 'Tavily Research retrieval failed.';
const EXECUTION_FAILED = 'Tavily Research execution failed.';

class TavilyResearchSubmissionError extends UnsafeToRetrySubmissionError {
  readonly failureDiagnostic: ProviderFailureDiagnostic;

  constructor(failureDiagnostic: ProviderFailureDiagnostic) {
    super(SUBMISSION_FAILED);
    this.failureDiagnostic = failureDiagnostic;
  }
}

class TavilyResearchLifecycleError extends Error {
  readonly failureDiagnostic: ProviderFailureDiagnostic;

  constructor(message: string, failureDiagnostic: ProviderFailureDiagnostic) {
    super(message);
    this.name = 'TavilyResearchLifecycleError';
    this.failureDiagnostic = failureDiagnostic;
  }
}

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
            { kind: 'timeout' },
          );
        await wait(Math.min(1_000, deadline - Date.now()), options.signal);
        const next = await this.poll(handle);
        handle.status = next.status;
        if (next.status === 'failed' || next.status === 'cancelled')
          return this.error(
            start,
            next.message ?? 'Tavily Research task ended without a result.',
            { kind: 'provider' },
          );
      }
      const result = await this.retrieve(handle);
      return { ...result, durationMs: Math.round(performance.now() - start) };
    } catch (error) {
      return error instanceof TavilyResearchSubmissionError
        ? this.error(start, error.message, error.failureDiagnostic)
        : error instanceof TavilyResearchLifecycleError
          ? this.error(start, error.message, error.failureDiagnostic)
          : this.error(
              start,
              EXECUTION_FAILED,
              this.catchDiagnostic(error, options.signal),
            );
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
      throw new TavilyResearchSubmissionError(
        this.catchDiagnostic(error, options.signal),
      );
    }
    if (response.status !== 201) {
      throw new TavilyResearchSubmissionError(
        this.httpDiagnostic(response.status, response.data),
      );
    }
    const parsed = TavilyPending.safeParse(response.data);
    if (!parsed.success) {
      const id = TavilyId.safeParse(
        (response.data as { request_id?: unknown })?.request_id,
      );
      if (!id.success)
        throw new TavilyResearchSubmissionError({
          kind: 'provider',
          httpStatus: 201,
        });
      return {
        provider: this.id,
        taskId: id.data,
        query,
        submittedAt: Date.now(),
        status: 'pending',
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
    let response;
    try {
      response = await this.task(handle.taskId, 15_000);
    } catch (error) {
      throw new TavilyResearchLifecycleError(
        POLL_FAILED,
        this.catchDiagnostic(error),
      );
    }
    if (response.status === 202) {
      const parsed = TavilyInProgress.safeParse(response.data);
      if (!parsed.success) {
        throw new TavilyResearchLifecycleError(POLL_FAILED, {
          kind: 'provider',
          httpStatus: 202,
        });
      }
      return { status: 'running', rawStatus: 'in_progress' };
    }
    if (response.status !== 200) {
      throw new TavilyResearchLifecycleError(
        POLL_FAILED,
        this.httpDiagnostic(response.status, response.data),
      );
    }
    const parsed = z
      .union([TavilyCompleted, TavilyFailed])
      .safeParse(response.data);
    if (!parsed.success) {
      throw new TavilyResearchLifecycleError(POLL_FAILED, {
        kind: 'provider',
        httpStatus: 200,
      });
    }
    return parsed.data.status === 'completed'
      ? { status: 'completed', rawStatus: 'completed' }
      : {
          status: 'failed',
          rawStatus: 'failed',
          message: 'Tavily Research task failed.',
          failureDiagnostic: { kind: 'provider' },
        };
  }

  async retrieve(handle: AsyncTaskHandle): Promise<ProviderResult> {
    const start = performance.now();
    try {
      const response = await this.task(handle.taskId, 30_000);
      if (response.status !== 200)
        return this.error(
          start,
          RETRIEVAL_FAILED,
          this.httpDiagnostic(response.status, response.data),
        );
      const parsed = z
        .union([TavilyCompleted, TavilyFailed])
        .safeParse(response.data);
      if (!parsed.success)
        return this.error(start, RETRIEVAL_FAILED, {
          kind: 'provider',
          httpStatus: 200,
        });
      const task: TavilyTerminal = parsed.data;
      if (task.status !== 'completed')
        return this.error(start, RETRIEVAL_FAILED, {
          kind: 'provider',
          httpStatus: 200,
        });
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
      return this.error(start, RETRIEVAL_FAILED, this.catchDiagnostic(error));
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

  private error(
    start: number,
    error: string,
    failureDiagnostic?: ProviderFailureDiagnostic,
  ): ProviderResult {
    return {
      provider: this.id,
      tier: this.tier,
      content: '',
      citations: [],
      durationMs: Math.round(performance.now() - start),
      error,
      ...(failureDiagnostic && { failureDiagnostic }),
    };
  }

  private httpDiagnostic(
    status: number,
    body: unknown,
  ): ProviderFailureDiagnostic {
    const httpStatus =
      Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : undefined;
    const detail = submissionFailureText(body);
    const kind: ProviderFailureDiagnostic['kind'] =
      status === 429
        ? 'rate_limit'
        : status === 432
          ? 'plan_required'
          : status === 433
            ? 'billing'
            : status === 401
              ? 'authentication'
              : status === 403
                ? looksPlanRestricted(detail)
                  ? 'plan_required'
                  : 'authentication'
                : status === 402
                  ? 'billing'
                  : status === 408 || status === 504
                    ? 'timeout'
                    : status >= 400 && status < 500
                      ? 'invalid_request'
                      : 'provider';
    return { kind, ...(httpStatus !== undefined && { httpStatus }) };
  }

  private catchDiagnostic(
    error: unknown,
    signal?: AbortSignal,
  ): ProviderFailureDiagnostic {
    if (
      signal?.aborted ||
      (error instanceof DOMException &&
        (error.name === 'AbortError' || error.name === 'TimeoutError'))
    ) {
      return { kind: 'timeout' };
    }
    const detail = error instanceof Error ? error.message : '';
    if (/API key not found/i.test(detail)) return { kind: 'authentication' };
    if (
      error instanceof TypeError ||
      /fetch failed|failed to fetch|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(
        detail,
      )
    ) {
      return { kind: 'network' };
    }
    return { kind: 'provider' };
  }
}

function submissionFailureText(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 512).toLowerCase();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return '';
  }
  const record = value as Record<string, unknown>;
  const nested =
    typeof record.error === 'object' &&
    record.error !== null &&
    !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : undefined;
  const nestedDetail =
    typeof record.detail === 'object' &&
    record.detail !== null &&
    !Array.isArray(record.detail)
      ? (record.detail as Record<string, unknown>)
      : undefined;
  return [
    record.message,
    record.detail,
    typeof record.error === 'string' ? record.error : undefined,
    nested?.message,
    nested?.detail,
    nested?.code,
    nestedDetail?.message,
    nestedDetail?.detail,
    nestedDetail?.code,
    typeof nestedDetail?.error === 'string' ? nestedDetail.error : undefined,
  ]
    .filter((item): item is string => typeof item === 'string')
    .join(' ')
    .slice(0, 512)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
}

function looksPlanRestricted(detail: string): boolean {
  return /\b(plan|subscription|upgrade|quota|credit limit)\b/i.test(detail);
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
