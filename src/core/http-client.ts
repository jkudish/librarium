import {
  INITIAL_RETRY_DELAY_MS,
  MAX_RESPONSE_SIZE,
  MAX_RETRIES,
} from '../constants.js';

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number; // ms
  signal?: AbortSignal;
}

export interface HttpResponse<T = unknown> {
  status: number;
  statusText: string;
  data: T;
  headers: Record<string, string>;
  durationMs: number;
}

/**
 * Thin fetch wrapper with retry, timeout, and duration tracking.
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

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1);
      await sleep(delay);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // Link external signal
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeoutId);
        throw new Error('Request aborted');
      }
      signal.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
    }

    const start = performance.now();

    try {
      const fetchOptions: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        signal: controller.signal,
      };

      if (body !== undefined) {
        fetchOptions.body = JSON.stringify(body);
      }

      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);

      const durationMs = Math.round(performance.now() - start);

      // Don't retry client errors (4xx) except 429 (rate limit)
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      ) {
        const text = await response.text();
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
      }

      // Retry on 5xx and 429
      if (response.status >= 500 || response.status === 429) {
        lastError = new Error(
          `HTTP ${response.status}: ${response.statusText}`,
        );
        if (attempt < MAX_RETRIES) continue;
      }

      const text = await response.text();
      if (text.length > MAX_RESPONSE_SIZE) {
        throw new Error(`Response exceeds ${MAX_RESPONSE_SIZE} bytes`);
      }

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
    } catch (e) {
      clearTimeout(timeoutId);
      if (e instanceof Error && e.name === 'AbortError') {
        if (signal?.aborted) {
          throw new Error('Request aborted');
        }
        lastError = new Error(`Request timed out after ${timeout}ms`);
      } else {
        lastError = e instanceof Error ? e : new Error(String(e));
      }

      if (attempt >= MAX_RETRIES) break;
    }
  }

  throw lastError ?? new Error('Request failed after retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
