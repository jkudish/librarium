import {
  DATAFORSEO_DESCRIPTORS,
  type DataForSeoAdapterId,
  DataForSeoError,
  dataForSeoCompletedResult,
  dataForSeoCost,
  dataForSeoOptionsSchema,
  dataForSeoReceipt,
  dataForSeoTask,
  dataForSeoTaskFailure,
  isDataForSeoPending,
  mapDataForSeoResult,
  splitCredential,
} from '../core/dataforseo.js';
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
} from '../types.js';
import {
  BackgroundBaseProvider,
  BaseProvider,
  type BaseProviderOptions,
} from './base.js';

const ORIGIN = 'https://api.dataforseo.com';

export interface DataForSeoProviderOptions extends BaseProviderOptions {
  model?: string;
  options?: Record<string, unknown>;
}

function parseOptions(id: DataForSeoAdapterId, options: unknown) {
  const parsed = dataForSeoOptionsSchema(id).safeParse(options ?? {});
  return parsed.success
    ? { ok: true as const, value: parsed.data as Record<string, unknown> }
    : {
        ok: false as const,
        message: parsed.error.issues
          .map(
            (issue) => `${issue.path.join('.') || 'options'}: ${issue.message}`,
          )
          .join('; '),
      };
}

function diagnostic(
  error: unknown,
  signal?: AbortSignal,
): ProviderFailureDiagnostic {
  if (error instanceof DataForSeoError)
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
  if (
    error instanceof Error &&
    /credential|API key not found/i.test(error.message)
  )
    return { kind: 'authentication' };
  return { kind: 'network' };
}

function safeMessage(error: unknown): string {
  return error instanceof DataForSeoError
    ? error.message
    : error instanceof Error && /credential/i.test(error.message)
      ? error.message
      : 'DataForSEO could not be reached.';
}

/** Resolve `login:password` from a configured key or the two env vars. */
function credential(provider: {
  configured(): string | undefined;
  env(name: string): string | undefined;
}): string {
  const configured = provider.configured();
  const login = provider.env('DATAFORSEO_LOGIN');
  const password = provider.env('DATAFORSEO_PASSWORD');
  const value =
    configured && splitCredential(configured).length === 2
      ? configured
      : login && password
        ? `${login}:${password}`
        : undefined;
  if (!value || splitCredential(value).length !== 2)
    throw new Error(
      'DataForSEO credential not found. Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD.',
    );
  return value;
}

function authorization(value: string): string {
  return `Basic ${btoa(
    Array.from(new TextEncoder().encode(value), (byte) =>
      String.fromCharCode(byte),
    ).join(''),
  )}`;
}

/**
 * Inline DataForSEO profiles: the scraper and AI Mode Live endpoints and the
 * LLM Responses Live endpoint. One POST, never retried, because DataForSEO
 * bills a request it accepted even when the response is lost.
 */
export class DataForSeoProvider extends BaseProvider {
  readonly tier: ProviderTier = 'ai-grounded';
  readonly id: DataForSeoAdapterId;
  private readonly configured: DataForSeoProviderOptions;

  constructor(
    id: DataForSeoAdapterId,
    options: DataForSeoProviderOptions = {},
  ) {
    super(options);
    this.id = id;
    this.configured = options;
  }

  get envVar(): string {
    return 'DATAFORSEO_LOGIN';
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const parsed = parseOptions(this.id, this.configured.options);
    if (!parsed.ok)
      return failure(this.id, this.tier, start, parsed.message, {
        kind: 'invalid_request',
      });
    // Set once DataForSEO accepted (and billed) the task, so a result that
    // then fails validation or mapping still reports its charge.
    let billed: string | undefined;
    try {
      const descriptor = DATAFORSEO_DESCRIPTORS[this.id];
      const task = dataForSeoTask(
        this.id,
        query,
        parsed.value,
        this.configured.model,
      );
      const key = this.credential();
      const operation =
        descriptor.seType === 'llm_responses' ? 'live' : 'live/advanced';
      const response = await this.request<unknown>(
        `${ORIGIN}/v3/${descriptor.family}/${operation}`,
        {
          method: 'POST',
          headers: { Authorization: authorization(key) },
          body: [task],
          timeout: options.timeout * 1000,
          signal: options.signal,
          retry: { mode: 'never' },
          redirect: 'manual',
        },
      );
      const receipt = dataForSeoReceipt({
        id: this.id,
        status: response.status,
        body: response.data,
        operation,
        credential: key,
        expectedStatus: 20000,
        prompt: query,
        options: parsed.value,
        model: this.configured.model,
      });
      billed = dataForSeoCost(receipt.cost);
      const result = dataForSeoCompletedResult(
        this.id,
        receipt,
        parsed.value,
        query,
      );
      return mapDataForSeoResult({
        id: this.id,
        result,
        receipt,
        cost: dataForSeoCost(receipt.cost),
        durationMs: Math.round(performance.now() - start),
        options: parsed.value,
        model: this.configured.model,
      });
    } catch (error) {
      return failure(
        this.id,
        this.tier,
        start,
        safeMessage(error),
        diagnostic(error, options.signal),
        billed === undefined
          ? undefined
          : { costUsdDecimal: billed, costUsd: Number(billed) },
      );
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      this.credential();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: safeMessage(error) };
    }
  }

  private credential(): string {
    return credential({
      configured: () => this.configuredCredential(),
      env: (name) => this.envCredential(name),
    });
  }
}

/**
 * Standard-priority DataForSEO tasks: `task_post` once, then `task_get` until
 * the task finishes. The submission is never retried.
 */
export class DataForSeoTaskProvider extends BackgroundBaseProvider {
  readonly tier: ProviderTier = 'ai-grounded';
  readonly id: DataForSeoAdapterId;
  private readonly configured: DataForSeoProviderOptions;

  constructor(
    id: DataForSeoAdapterId,
    options: DataForSeoProviderOptions = {},
  ) {
    super(options);
    this.id = id;
    this.configured = options;
  }

  get envVar(): string {
    return 'DATAFORSEO_LOGIN';
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
          return failure(
            this.id,
            this.tier,
            start,
            polled.message ?? 'DataForSEO task failed.',
            polled.failureDiagnostic,
          );
        if (Date.now() >= deadline)
          return failure(
            this.id,
            this.tier,
            start,
            'DataForSEO task timed out.',
            { kind: 'timeout' },
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
        safeMessage(error),
        diagnostic(error, options.signal),
      );
    }
  }

  async submit(
    query: string,
    options: ProviderOptions,
  ): Promise<AsyncTaskHandle> {
    const parsed = parseOptions(this.id, this.configured.options);
    if (!parsed.ok)
      throw new UnsafeToRetrySubmissionError(parsed.message, {
        kind: 'invalid_request',
      });
    const descriptor = DATAFORSEO_DESCRIPTORS[this.id];
    let task: Record<string, unknown>;
    let key: string;
    try {
      task = dataForSeoTask(this.id, query, parsed.value);
      key = this.credential();
    } catch (error) {
      throw new UnsafeToRetrySubmissionError(
        safeMessage(error),
        diagnostic(error),
      );
    }
    let response: { status: number; data: unknown };
    try {
      response = await this.request<unknown>(
        `${ORIGIN}/v3/${descriptor.family}/task_post`,
        {
          method: 'POST',
          headers: { Authorization: authorization(key) },
          body: [task],
          timeout: Math.min(options.timeout * 1000, 60_000),
          signal: options.signal,
          retry: { mode: 'never' },
          redirect: 'manual',
        },
      );
    } catch (error) {
      throw new UnsafeToRetrySubmissionError(
        'The DataForSEO submission outcome is unknown and was not retried.',
        diagnostic(error, options.signal),
      );
    }
    try {
      const created = dataForSeoReceipt({
        id: this.id,
        status: response.status,
        body: response.data,
        operation: 'task_post',
        credential: key,
        expectedStatus: 20100,
        prompt: query,
        options: parsed.value,
      });
      if (created.result_count !== 0 || (created.result ?? null) !== null)
        throw new DataForSeoError(
          'provider',
          'DataForSEO returned a contradictory task creation receipt.',
        );
      const cost = dataForSeoCost(created.cost);
      return {
        provider: this.id,
        taskId: created.id,
        query,
        submittedAt: Date.now(),
        status: 'pending',
        providerStatus: String(created.status_code),
        ...(cost !== undefined && {
          usage: { costUsdDecimal: cost, costUsd: Number(cost) },
        }),
      };
    } catch (error) {
      // A 2xx envelope that fails validation may still describe a created,
      // billed task; only a definitive rejection proves it was not created.
      const known =
        error instanceof DataForSeoError && error.kind !== 'provider';
      throw new UnsafeToRetrySubmissionError(
        safeMessage(error),
        known ? diagnostic(error) : { kind: 'provider' },
      );
    }
  }

  async poll(handle: AsyncTaskHandle): Promise<AsyncPollResult> {
    const observed = await this.observe(handle);
    if (observed.kind === 'pending')
      return { status: 'running', rawStatus: observed.raw };
    if (observed.kind === 'failed')
      return {
        status: 'failed',
        message: observed.error.message,
        failureDiagnostic: diagnostic(observed.error),
        ...(handle.usage && { usage: handle.usage }),
      };
    return {
      status: 'completed',
      rawStatus: '20000',
      ...(handle.usage && { usage: handle.usage }),
    };
  }

  async retrieve(handle: AsyncTaskHandle): Promise<ProviderResult> {
    const start = performance.now();
    const observed = await this.observe(handle).catch((error: unknown) => ({
      kind: 'failed' as const,
      error:
        error instanceof DataForSeoError
          ? error
          : new DataForSeoError(
              'provider',
              'DataForSEO could not return the accepted task.',
            ),
    }));
    if (observed.kind !== 'completed')
      return failure(
        this.id,
        this.tier,
        start,
        observed.kind === 'failed'
          ? observed.error.message
          : 'DataForSEO task is not complete.',
        observed.kind === 'failed'
          ? diagnostic(observed.error)
          : { kind: 'provider' },
        handle.usage,
      );
    try {
      const cost = handle.usage?.costUsdDecimal;
      return mapDataForSeoResult({
        id: this.id,
        result: observed.result,
        receipt: observed.receipt,
        ...(cost !== undefined && { cost }),
        durationMs: Math.round(performance.now() - start),
        options: observed.options,
      });
    } catch (error) {
      return failure(
        this.id,
        this.tier,
        start,
        safeMessage(error),
        diagnostic(error),
        handle.usage,
      );
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      this.credential();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: safeMessage(error) };
    }
  }

  /** One `task_get`. Transient HTTP failures throw so the caller polls again. */
  private async observe(handle: AsyncTaskHandle): Promise<
    | { kind: 'pending'; raw: string }
    | { kind: 'failed'; error: DataForSeoError }
    | {
        kind: 'completed';
        receipt: ReturnType<typeof dataForSeoReceipt>;
        result: Record<string, unknown>;
        options: Record<string, unknown>;
      }
  > {
    const parsed = parseOptions(this.id, this.configured.options);
    if (!parsed.ok)
      return {
        kind: 'failed',
        error: new DataForSeoError('invalid_request', parsed.message),
      };
    const key = this.credential();
    const descriptor = DATAFORSEO_DESCRIPTORS[this.id];
    const operation = `task_get/advanced/${handle.taskId}`;
    const response = await this.request<unknown>(
      `${ORIGIN}/v3/${descriptor.family}/${operation}`,
      {
        method: 'GET',
        headers: { Authorization: authorization(key) },
        timeout: 60_000,
        redirect: 'manual',
      },
    );
    const status = (response.data as { status_code?: unknown } | null)
      ?.status_code;
    if (response.status === 429 || response.status >= 500 || status === 50000)
      throw new DataForSeoError(
        'provider',
        'DataForSEO temporarily could not return the accepted task.',
        response.status,
      );
    try {
      const receipt = dataForSeoReceipt({
        id: this.id,
        status: response.status,
        body: response.data,
        operation,
        credential: key,
        expectedId: handle.taskId,
        ...(handle.query && { prompt: handle.query }),
        options: parsed.value,
      });
      if (isDataForSeoPending(receipt))
        return { kind: 'pending', raw: String(receipt.status_code) };
      if (receipt.status_code !== 20000)
        return {
          kind: 'failed',
          error: dataForSeoTaskFailure(receipt.status_code),
        };
      const result = dataForSeoCompletedResult(
        this.id,
        receipt,
        parsed.value,
        handle.query || undefined,
      );
      return { kind: 'completed', receipt, result, options: parsed.value };
    } catch (error) {
      if (error instanceof DataForSeoError) return { kind: 'failed', error };
      throw error;
    }
  }

  private credential(): string {
    return credential({
      configured: () => this.configuredCredential(),
      env: (name) => this.envCredential(name),
    });
  }
}

function failure(
  provider: string,
  tier: ProviderTier,
  start: number,
  error: string,
  failureDiagnostic?: ProviderFailureDiagnostic,
  usage?: AsyncTaskHandle['usage'],
): ProviderResult {
  return {
    provider,
    tier,
    content: '',
    citations: [],
    durationMs: Math.round(performance.now() - start),
    error,
    ...(failureDiagnostic && { failureDiagnostic }),
    ...(usage && { usage }),
  };
}
