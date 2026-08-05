import {
  INITIAL_RETRY_DELAY_MS,
  MAX_RESPONSE_SIZE,
  MAX_RETRIES,
} from '../constants.js';

const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;

interface RetrySettings {
  /** Total attempts, including the initial request. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export type HttpRetryPolicy =
  | { mode: 'never' }
  | ({ mode: 'safe' } & RetrySettings)
  | ({
      mode: 'idempotent';
      idempotencyKey: string;
      idempotencyHeader?: string;
    } & RetrySettings);

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number; // ms
  signal?: AbortSignal;
  /**
   * GET requests retry transient failures by default. Mutating requests do not
   * retry unless their idempotency is declared explicitly.
   */
  retry?: HttpRetryPolicy;
}

export interface HttpResponse<T = unknown> {
  status: number;
  statusText: string;
  data: T;
  headers: Record<string, string>;
  durationMs: number;
}

export class HttpRequestAbortedError extends Error {
  constructor() {
    super('Request aborted');
    this.name = 'HttpRequestAbortedError';
  }
}

export class HttpRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = 'HttpRequestTimeoutError';
  }
}

export class HttpResponseTooLargeError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`Response exceeds ${limitBytes} bytes`);
    this.name = 'HttpResponseTooLargeError';
    this.limitBytes = limitBytes;
  }
}

interface ResolvedRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  idempotencyHeader?: string;
  idempotencyKey?: string;
}

/**
 * Thin fetch wrapper with bounded response reads, explicit retry safety,
 * timeout/abort handling, and duration tracking.
 */
export async function httpRequest<T = unknown>(
  url: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse<T>> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeout = 30000,
    signal,
  } = options;
  const retry = resolveRetryPolicy(method, options.retry);
  let lastError: Error | undefined;
  let retryDelayMs = 0;

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    if (attempt > 1) {
      await abortableSleep(retryDelayMs, signal);
    }

    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = (): void => controller.abort();
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);

    if (signal?.aborted) {
      clearTimeout(timeoutId);
      throw new HttpRequestAbortedError();
    }
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    const start = performance.now();

    try {
      const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...headers,
      };
      if (retry.idempotencyHeader && retry.idempotencyKey) {
        requestHeaders[retry.idempotencyHeader] = retry.idempotencyKey;
      }

      const fetchOptions: RequestInit = {
        method,
        headers: requestHeaders,
        signal: controller.signal,
      };

      if (body !== undefined) {
        fetchOptions.body = JSON.stringify(body);
      }

      const response = await fetch(url, fetchOptions);
      const durationMs = Math.round(performance.now() - start);
      const retryableStatus = response.status === 429 || response.status >= 500;

      if (retryableStatus && attempt < retry.maxAttempts) {
        retryDelayMs = retryDelayForResponse(response, attempt, retry);
        await cancelResponseBody(response);
        continue;
      }

      const text = await readBoundedBody(response, MAX_RESPONSE_SIZE);
      let data: T;
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = text as T;
      }

      return {
        status: response.status,
        statusText: response.statusText,
        data,
        headers: Object.fromEntries(response.headers.entries()),
        durationMs,
      };
    } catch (error) {
      if (error instanceof HttpResponseTooLargeError) {
        throw error;
      }
      if (signal?.aborted) {
        throw new HttpRequestAbortedError();
      }
      if (isAbortError(error)) {
        lastError = timedOut
          ? new HttpRequestTimeoutError(timeout)
          : new HttpRequestAbortedError();
      } else {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      if (
        lastError instanceof HttpRequestAbortedError ||
        attempt >= retry.maxAttempts
      ) {
        break;
      }
      retryDelayMs = jitteredBackoff(attempt, retry);
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  throw lastError ?? new Error('Request failed after retries');
}

function resolveRetryPolicy(
  method: NonNullable<HttpRequestOptions['method']>,
  policy: HttpRetryPolicy | undefined,
): ResolvedRetryPolicy {
  const resolved =
    policy ?? (method === 'GET' ? { mode: 'safe' } : { mode: 'never' });

  if (resolved.mode === 'never') {
    return {
      maxAttempts: 1,
      baseDelayMs: INITIAL_RETRY_DELAY_MS,
      maxDelayMs: DEFAULT_MAX_RETRY_DELAY_MS,
    };
  }
  if (resolved.mode === 'safe' && method !== 'GET') {
    throw new TypeError(`Safe retry policy cannot be used with ${method}`);
  }

  const maxAttempts = resolved.maxAttempts ?? MAX_RETRIES + 1;
  const baseDelayMs = resolved.baseDelayMs ?? INITIAL_RETRY_DELAY_MS;
  const maxDelayMs = resolved.maxDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('Retry maxAttempts must be a positive integer');
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new TypeError('Retry baseDelayMs must be a non-negative number');
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new TypeError('Retry maxDelayMs must be a non-negative number');
  }

  if (resolved.mode === 'idempotent') {
    if (!resolved.idempotencyKey.trim()) {
      throw new TypeError('Idempotent retry policy requires a key');
    }
    const idempotencyHeader = resolved.idempotencyHeader ?? 'Idempotency-Key';
    if (!idempotencyHeader.trim()) {
      throw new TypeError('Idempotency header must not be empty');
    }
    return {
      maxAttempts,
      baseDelayMs,
      maxDelayMs,
      idempotencyHeader,
      idempotencyKey: resolved.idempotencyKey,
    };
  }

  return { maxAttempts, baseDelayMs, maxDelayMs };
}

function retryDelayForResponse(
  response: Response,
  attempt: number,
  retry: ResolvedRetryPolicy,
): number {
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
  return retryAfter === undefined
    ? jitteredBackoff(attempt, retry)
    : Math.min(retryAfter, retry.maxDelayMs);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function jitteredBackoff(
  attempt: number,
  retry: Pick<ResolvedRetryPolicy, 'baseDelayMs' | 'maxDelayMs'>,
): number {
  const cap = Math.min(
    retry.maxDelayMs,
    retry.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  return Math.floor(cap / 2 + Math.random() * (cap / 2));
}

async function readBoundedBody(
  response: Response,
  limitBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    await cancelResponseBody(response);
    throw new HttpResponseTooLargeError(limitBytes);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limitBytes) {
      throw new HttpResponseTooLargeError(limitBytes);
    }
    return text;
  }

  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > limitBytes) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the deterministic size error if stream cleanup fails.
        }
        throw new HttpResponseTooLargeError(limitBytes);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } finally {
    reader.releaseLock();
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The next attempt must not be hidden by best-effort connection cleanup.
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new HttpRequestAbortedError());
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      reject(new HttpRequestAbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
