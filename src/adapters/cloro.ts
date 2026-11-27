import {
  CLORO_ORIGIN,
  CLORO_SURFACES,
  CLORO_TASK_RETENTION_MS,
  CloroError,
  CloroOptionsSchemas,
  type CloroSurface,
  type CloroSurfaceId,
  cloroCredits,
  cloroHttpError,
  cloroPayload,
  errorCode,
  mapCloroResult,
  record,
} from '../core/cloro.js';
import { UnsafeToRetrySubmissionError } from '../core/errors.js';
import {
  HttpRequestAbortedError,
  HttpRequestTimeoutError,
} from '../core/http-client.js';
import type {
  AsyncPollResult,
  AsyncTaskHandle,
  ProviderFailureDiagnostic,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import {
  BackgroundBaseProvider,
  BaseProvider,
  type BaseProviderOptions,
} from './base.js';

export interface CloroProviderOptions extends BaseProviderOptions {
  options?: Record<string, unknown>;
}

/** Cloro documents sync requests running for up to five minutes. */
const SYNC_TIMEOUT_MS = 300_000;

function parse(surface: CloroSurfaceId, options: unknown) {
  const parsed = CloroOptionsSchemas[surface].safeParse(options ?? {});
  if (parsed.success) return parsed.data as Record<string, unknown>;
  throw new CloroError(
    'invalid_request',
    parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'options'}: ${issue.message}`)
      .join('; '),
  );
}

function diagnostic(
  error: unknown,
  signal?: AbortSignal,
): ProviderFailureDiagnostic {
  if (error instanceof CloroError)
    return {
      kind: error.kind,
      ...(error.httpStatus !== undefined && { httpStatus: error.httpStatus }),
    };
  if (
    signal?.aborted ||
    error instanceof HttpRequestAbortedError ||
    error instanceof HttpRequestTimeoutError
  )
    return { kind: 'timeout' };
  if (error instanceof Error && /API key not found/i.test(error.message))
    return { kind: 'authentication' };
  return { kind: 'network' };
}

function message(error: unknown): string {
  return error instanceof CloroError
    ? error.message
    : error instanceof Error && /API key not found/i.test(error.message)
      ? 'Cloro API key not found. Set CLORO_API_KEY.'
      : 'Cloro could not be reached.';
}

function failure(
  provider: string,
  tier: ProviderTier,
  start: number,
  error: unknown,
  usage?: ProviderUsage,
  signal?: AbortSignal,
): ProviderResult {
  return {
    provider,
    tier,
    content: '',
    citations: [],
    durationMs: Math.round(performance.now() - start),
    error: message(error),
    failureDiagnostic: diagnostic(error, signal),
    ...(usage && { usage }),
  };
}

const tierFor = (surface: CloroSurfaceId): ProviderTier =>
  CLORO_SURFACES[surface].kind === 'search' ||
  CLORO_SURFACES[surface].kind === 'news'
    ? 'raw-search'
    : 'ai-grounded';

/**
 * Live priority and Google results: one synchronous `/v1/monitor/*` call.
 * It is never retried. Cloro bills a finished request even when the client
 * gave up on it, and a concurrency 429 returns at once without Retry-After.
 */
export class CloroProvider extends BaseProvider {
  readonly id: string;
  readonly tier: ProviderTier;
  private readonly surface: CloroSurfaceId;
  private readonly configured: CloroProviderOptions;

  constructor(
    id: string,
    surface: CloroSurfaceId,
    options: CloroProviderOptions = {},
  ) {
    super(options);
    this.id = id;
    this.surface = surface;
    this.tier = tierFor(surface);
    this.configured = options;
  }

  get envVar(): string {
    return 'CLORO_API_KEY';
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    let usage: ProviderUsage | undefined;
    try {
      const body = cloroPayload(
        this.surface,
        query,
        parse(this.surface, this.configured.options),
      );
      const response = await this.request<unknown>(
        `${CLORO_ORIGIN}${CLORO_SURFACES[this.surface].path}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.getApiKey()}` },
          body,
          timeout: Math.min(options.timeout * 1000, SYNC_TIMEOUT_MS),
          signal: options.signal,
          retry: { mode: 'never' },
          redirect: 'manual',
        },
      );
      usage = cloroCredits(response.headers['x-credits-charged']);
      if (response.status !== 200)
        throw cloroHttpError(response.status, response.data);
      const data = record(response.data);
      if (data?.success !== true)
        throw new CloroError(
          'provider',
          'Cloro returned an unsuccessful response.',
        );
      return mapCloroResult({
        provider: this.id,
        surface: this.surface,
        result: data.result,
        ...(usage && { usage }),
        durationMs: Math.round(performance.now() - start),
      });
    } catch (error) {
      return failure(this.id, this.tier, start, error, usage, options.signal);
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      this.getApiKey();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  }
}

/**
 * Standard priority: one `/v1/async/task` submission with an idempotency key
 * derived from the attempt, then polling. A resubmission with the same key
 * returns 409 and the existing task id, so it never creates a second task.
 */
export class CloroTaskProvider extends BackgroundBaseProvider {
  readonly id: string;
  readonly tier: ProviderTier;
  private readonly surface: CloroSurfaceId;
  private readonly configured: CloroProviderOptions;

  constructor(
    id: string,
    surface: CloroSurfaceId,
    options: CloroProviderOptions = {},
  ) {
    super(options);
    this.id = id;
    this.surface = surface;
    this.tier = tierFor(surface);
    this.configured = options;
  }

  get envVar(): string {
    return 'CLORO_API_KEY';
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    try {
      const handle = await this.submit(query, options);
      const deadline = Date.now() + options.timeout * 1000;
      for (;;) {
        const polled = await this.poll(handle);
        if (polled.status === 'completed') break;
        if (polled.status === 'failed' || polled.status === 'cancelled')
          return {
            ...failure(
              this.id,
              this.tier,
              start,
              new CloroError(
                polled.failureDiagnostic?.kind ?? 'provider',
                polled.message ?? 'Cloro task failed.',
              ),
              polled.usage,
            ),
          };
        if (Date.now() >= deadline)
          return failure(
            this.id,
            this.tier,
            start,
            new CloroError('timeout', 'Cloro task timed out.'),
          );
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      return {
        ...(await this.retrieve(handle)),
        durationMs: Math.round(performance.now() - start),
      };
    } catch (error) {
      return failure(
        this.id,
        this.tier,
        start,
        error,
        undefined,
        options.signal,
      );
    }
  }

  async submit(
    query: string,
    options: ProviderOptions,
  ): Promise<AsyncTaskHandle> {
    let body: Record<string, unknown>;
    let apiKey: string;
    try {
      body = {
        taskType: (CLORO_SURFACES[this.surface] as CloroSurface).taskType,
        payload: cloroPayload(
          this.surface,
          query,
          parse(this.surface, this.configured.options),
        ),
        idempotencyKey: `librarium-${options.submissionId ?? crypto.randomUUID()}`,
      };
      apiKey = this.getApiKey();
    } catch (error) {
      throw new UnsafeToRetrySubmissionError(message(error), diagnostic(error));
    }
    let response: { status: number; data: unknown };
    try {
      response = await this.request<unknown>(`${CLORO_ORIGIN}/v1/async/task`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body,
        timeout: Math.min(options.timeout * 1000, 60_000),
        signal: options.signal,
        retry: { mode: 'never' },
        redirect: 'manual',
      });
    } catch (error) {
      throw new UnsafeToRetrySubmissionError(
        'The Cloro submission outcome is unknown and was not retried.',
        diagnostic(error, options.signal),
      );
    }
    const data = record(response.data);
    // Our idempotency key already holds a task: adopt it instead of failing.
    const existing = record(record(data?.error)?.details)?.taskId;
    if (response.status === 409 && typeof existing === 'string' && existing)
      return this.handle(existing, query, Date.now());
    if (response.status !== 200 && response.status !== 201)
      throw new UnsafeToRetrySubmissionError(
        message(cloroHttpError(response.status, response.data)),
        diagnostic(cloroHttpError(response.status, response.data)),
      );
    const task = record(data?.task);
    if (data?.success !== true || typeof task?.id !== 'string' || !task.id)
      throw new UnsafeToRetrySubmissionError(
        'Cloro returned an invalid task receipt.',
        { kind: 'provider' },
      );
    const created = Date.parse(String(task.createdAt));
    return this.handle(
      task.id,
      query,
      Number.isNaN(created) ? Date.now() : created,
    );
  }

  async poll(handle: AsyncTaskHandle): Promise<AsyncPollResult> {
    const observed = await this.observe(handle);
    if (observed.kind === 'pending')
      return {
        status: observed.status === 'PROCESSING' ? 'running' : 'pending',
        rawStatus: observed.status,
      };
    if (observed.kind === 'failed')
      return {
        status: 'failed',
        message: observed.error.message,
        failureDiagnostic: diagnostic(observed.error),
        ...(observed.usage && { usage: observed.usage }),
      };
    return {
      status: 'completed',
      rawStatus: 'COMPLETED',
      ...(observed.usage && { usage: observed.usage }),
    };
  }

  async retrieve(handle: AsyncTaskHandle): Promise<ProviderResult> {
    const start = performance.now();
    try {
      const observed = await this.observe(handle);
      if (observed.kind === 'failed')
        return failure(
          this.id,
          this.tier,
          start,
          observed.error,
          observed.usage,
        );
      if (observed.kind === 'pending')
        return failure(
          this.id,
          this.tier,
          start,
          new CloroError('provider', 'Cloro task is not complete.'),
        );
      try {
        return mapCloroResult({
          provider: this.id,
          surface: this.surface,
          result: observed.result,
          ...(observed.usage && { usage: observed.usage }),
          durationMs: Math.round(performance.now() - start),
        });
      } catch (error) {
        return failure(this.id, this.tier, start, error, observed.usage);
      }
    } catch (error) {
      return failure(this.id, this.tier, start, error);
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      this.getApiKey();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  }

  private handle(
    taskId: string,
    query: string,
    submittedAt: number,
  ): AsyncTaskHandle {
    return {
      provider: this.id,
      taskId,
      query,
      submittedAt,
      status: 'pending',
      providerStatus: 'QUEUED',
    };
  }

  /** One status read. Transient failures throw so the caller polls again. */
  private async observe(
    handle: AsyncTaskHandle,
  ): Promise<
    | { kind: 'pending'; status: string }
    | { kind: 'failed'; error: CloroError; usage?: ProviderUsage }
    | { kind: 'completed'; result: unknown; usage?: ProviderUsage }
  > {
    const expired = new CloroError(
      'expired',
      'Cloro deleted the task result 24 hours after the task was created.',
      404,
    );
    if (Date.now() - handle.submittedAt >= CLORO_TASK_RETENTION_MS)
      return { kind: 'failed', error: expired };
    const response = await this.request<unknown>(
      `${CLORO_ORIGIN}/v1/async/task/${encodeURIComponent(handle.taskId)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.getApiKey()}` },
        timeout: 30_000,
        redirect: 'manual',
      },
    );
    if (response.status === 404) return { kind: 'failed', error: expired };
    if (response.status === 401 || response.status === 403)
      return {
        kind: 'failed',
        error: cloroHttpError(response.status, response.data),
      };
    if (response.status !== 200)
      throw cloroHttpError(response.status, response.data);
    const data = record(response.data);
    const task = record(data?.task);
    if (task?.id !== handle.taskId)
      throw new CloroError('provider', 'Cloro returned a different task.');
    const usage = cloroCredits(record(data?.credits)?.creditsCharged);
    switch (task.status) {
      case 'QUEUED':
      case 'PROCESSING':
        return { kind: 'pending', status: task.status };
      case 'COMPLETED':
        return {
          kind: 'completed',
          result: data?.response,
          ...(usage && { usage }),
        };
      case 'FAILED': {
        const code =
          errorCode(data?.response) ??
          errorCode({ error: record(data?.response) });
        return {
          kind: 'failed',
          error: new CloroError(
            code === 'INSUFFICIENT_CREDITS' || code === 'BILLING_SUSPENDED'
              ? 'billing'
              : 'provider',
            `Cloro could not complete the task${code ? ` (${code})` : ''}.`,
          ),
          ...(usage && { usage }),
        };
      }
      default:
        throw new CloroError(
          'provider',
          'Cloro returned an unknown task status.',
        );
    }
  }
}
