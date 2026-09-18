import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  HttpRequestAbortedError,
  HttpRequestTimeoutError,
  HttpResponseTooLargeError,
  httpRequest,
  httpStreamRequest,
} from '../src/core/http-client.js';

// Mock constants to reduce retry delays in tests
vi.mock('../src/constants.js', async (importOriginal) => {
  const original =
    (await importOriginal()) as typeof import('../src/constants.js');
  return {
    ...original,
    MAX_RETRIES: 2,
    INITIAL_RETRY_DELAY_MS: 10,
    MAX_RESPONSE_SIZE: 1024,
  };
});

describe('httpRequest', () => {
  const originalFetch = globalThis.fetch;

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('successful GET request', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ result: 'success' }),
    });

    const response = await httpRequest('https://api.example.com/data');
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ result: 'success' });
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it('successful POST with body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: new Headers({}),
      text: async () => JSON.stringify({ id: 42 }),
    });

    const response = await httpRequest('https://api.example.com/data', {
      method: 'POST',
      body: { query: 'test query' },
      headers: { Authorization: 'Bearer sk-test' },
    });

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ id: 42 });

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const fetchOptions = fetchCall[1] as RequestInit;
    expect(fetchOptions.method).toBe('POST');
    expect(fetchOptions.body).toBe(JSON.stringify({ query: 'test query' }));
    expect((fetchOptions.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-test',
    );
  });

  it('does not retry mutating requests by default', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers({}),
      text: async () => 'Server Error',
    });
    globalThis.fetch = fetchMock;

    const response = await httpRequest('https://api.example.com/data', {
      method: 'POST',
      body: { query: 'paid request' },
    });

    expect(response.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retries a mutating request only with an explicit idempotency key', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 500,
        statusText: 'Internal Server Error',
        headers: new Headers({}),
        text: async () => 'Server Error',
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers({}),
        text: async () => JSON.stringify({ ok: true }),
      });
    globalThis.fetch = fetchMock;

    const response = await httpRequest('https://api.example.com/data', {
      method: 'POST',
      body: { query: 'idempotent request' },
      retry: {
        mode: 'idempotent',
        idempotencyKey: 'run-123',
        maxAttempts: 2,
        baseDelayMs: 0,
      },
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const headers = fetchMock.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(headers['Idempotency-Key']).toBe('run-123');
  });

  it('overrides a caller idempotency header case-insensitively', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({}),
      text: async () => '{}',
    });
    globalThis.fetch = fetchMock;

    await httpRequest('https://api.example.com/data', {
      method: 'POST',
      headers: { 'idempotency-key': 'stale-key' },
      retry: {
        mode: 'idempotent',
        idempotencyKey: 'authoritative-key',
      },
    });

    const headers = fetchMock.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(headers['Idempotency-Key']).toBe('authoritative-key');
    expect(headers['idempotency-key']).toBeUndefined();
  });

  it('rejects safe retry policy on a mutating request', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    await expect(
      httpRequest('https://api.example.com/data', {
        method: 'POST',
        retry: { mode: 'safe' },
      }),
    ).rejects.toThrow('Safe retry policy cannot be used with POST');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('timeout via AbortController', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          // Simulate the signal aborting
          const signal = options.signal!;
          signal.addEventListener('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );

    await expect(
      httpRequest('https://api.example.com/slow', { timeout: 50 }),
    ).rejects.toThrow('timed out');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'rejects invalid buffered timeout %s before fetch',
    async (timeout) => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      await expect(
        httpRequest('https://api.example.com/invalid-timeout', { timeout }),
      ).rejects.toThrow('HTTP timeout must be a positive integer');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('retries on 500 errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 500,
        statusText: 'Internal Server Error',
        headers: new Headers({}),
        text: async () => 'Server Error',
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers({}),
        text: async () => JSON.stringify({ ok: true }),
      });

    globalThis.fetch = fetchMock;

    const response = await httpRequest('https://api.example.com/data');
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 rate limit', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({}),
        text: async () => 'Rate limited',
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers({}),
        text: async () => JSON.stringify({ ok: true }),
      });

    globalThis.fetch = fetchMock;

    const response = await httpRequest('https://api.example.com/data');
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After before retrying', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({ 'retry-after': '2' }),
        text: async () => 'Rate limited',
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers({}),
        text: async () => JSON.stringify({ ok: true }),
      });
    globalThis.fetch = fetchMock;

    const request = httpRequest('https://api.example.com/data', {
      retry: { mode: 'safe', maxAttempts: 2 },
    });
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    await expect(request).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors an HTTP-date Retry-After and caps the delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T20:00:00Z'));
    const retryAt = new Date(Date.now() + 60_000).toUTCString();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 503,
        statusText: 'Unavailable',
        headers: new Headers({ 'retry-after': retryAt }),
        text: async () => 'Unavailable',
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers({}),
        text: async () => '{}',
      });
    globalThis.fetch = fetchMock;

    const request = httpRequest('https://api.example.com/data', {
      retry: { mode: 'safe', maxAttempts: 2, maxDelayMs: 500 },
    });
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    await expect(request).resolves.toMatchObject({ status: 200 });
  });

  it('cancels a retryable response body before the next attempt', async () => {
    const cancel = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 503,
        statusText: 'Unavailable',
        headers: new Headers({}),
        body: new ReadableStream({ cancel }),
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers({}),
        text: async () => '{}',
      });
    globalThis.fetch = fetchMock;

    await httpRequest('https://api.example.com/data', {
      retry: { mode: 'safe', maxAttempts: 2, baseDelayMs: 0 },
    });

    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns the final 429 response body after exhausting retries', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Headers({}),
      text: async () => JSON.stringify({ error: 'Rate limited' }),
    });
    globalThis.fetch = fetchMock;

    const response = await httpRequest('https://api.example.com/data');

    expect(response.status).toBe(429);
    expect(response.data).toEqual({ error: 'Rate limited' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry on 400 client error', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      status: 400,
      statusText: 'Bad Request',
      headers: new Headers({}),
      text: async () => JSON.stringify({ error: 'Invalid query' }),
    });

    globalThis.fetch = fetchMock;

    const response = await httpRequest('https://api.example.com/data');
    expect(response.status).toBe(400);
    expect(response.data).toEqual({ error: 'Invalid query' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('tracks duration', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              status: 200,
              statusText: 'OK',
              headers: new Headers({}),
              text: async () => JSON.stringify({}),
            });
          }, 20);
        }),
    );

    const response = await httpRequest('https://api.example.com/data');
    expect(response.durationMs).toBeGreaterThanOrEqual(10);
  });

  it('passes custom headers through', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: new Headers({}),
      text: async () => '{}',
    });

    await httpRequest('https://api.example.com/data', {
      headers: {
        'X-Custom-Header': 'custom-value',
        Authorization: 'Bearer token-123',
      },
    });

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const fetchOptions = fetchCall[1] as RequestInit;
    const headers = fetchOptions.headers as Record<string, string>;
    expect(headers['X-Custom-Header']).toBe('custom-value');
    expect(headers.Authorization).toBe('Bearer token-123');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('parses JSON response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: new Headers({}),
      text: async () => JSON.stringify({ nested: { key: 'value' } }),
    });

    const response = await httpRequest('https://api.example.com/data');
    expect(response.data).toEqual({ nested: { key: 'value' } });
  });

  it('falls back to text for non-JSON response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: new Headers({}),
      text: async () => 'Plain text response',
    });

    const response = await httpRequest<string>('https://api.example.com/data');
    expect(response.data).toBe('Plain text response');
  });

  it('enforces the byte limit while streaming a 4xx response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('😀'.repeat(300), { status: 400 }));
    globalThis.fetch = fetchMock;

    await expect(
      httpRequest('https://api.example.com/data'),
    ).rejects.toBeInstanceOf(HttpResponseTooLargeError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects an oversized declared response before reading it', async () => {
    const text = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-length': '1025' }),
      body: null,
      text,
    });

    await expect(
      httpRequest('https://api.example.com/data'),
    ).rejects.toBeInstanceOf(HttpResponseTooLargeError);
    expect(text).not.toHaveBeenCalled();
  });

  it('aborts immediately while waiting to retry', async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers({}),
      text: async () => 'Server Error',
    });

    const request = httpRequest('https://api.example.com/data', {
      signal: controller.signal,
      retry: {
        mode: 'safe',
        maxAttempts: 2,
        baseDelayMs: 10_000,
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    await expect(request).rejects.toBeInstanceOf(HttpRequestAbortedError);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it('aborts with external signal', async () => {
    const controller = new AbortController();

    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = options.signal!;
          signal.addEventListener('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );

    // Abort after a short delay
    setTimeout(() => controller.abort(), 20);

    await expect(
      httpRequest('https://api.example.com/slow', {
        timeout: 30000,
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted');
  });
});

describe('httpStreamRequest', () => {
  const originalFetch = globalThis.fetch;

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('exposes status, headers, and a readable response without buffering it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('streamed body', {
        status: 202,
        statusText: 'Accepted',
        headers: {
          'content-type': 'text/event-stream',
          'x-request-id': 'synthetic-request',
        },
      }),
    );
    globalThis.fetch = fetchMock;

    const response = await httpStreamRequest('https://api.example.com/stream', {
      method: 'POST',
      headers: { Authorization: 'Bearer synthetic-key' },
      body: { stream: true },
    });

    expect(response).toMatchObject({
      status: 202,
      statusText: 'Accepted',
      headers: {
        'content-type': 'text/event-stream',
        'x-request-id': 'synthetic-request',
      },
    });
    expect(await new Response(response.body).text()).toBe('streamed body');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer synthetic-key',
      },
      body: '{"stream":true}',
    });
  });

  it('never retries a streaming request by default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('unavailable', {
        status: 503,
        statusText: 'Unavailable',
      }),
    );
    globalThis.fetch = fetchMock;

    const response = await httpStreamRequest(
      'https://api.example.com/one-attempt',
    );

    expect(response.status).toBe(503);
    expect(await new Response(response.body).text()).toBe('unavailable');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects retry-enabled policies before dispatch', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    await expect(
      httpStreamRequest('https://api.example.com/no-retries', {
        retry: { mode: 'safe' },
      } as never),
    ).rejects.toThrow('only support retry mode "never"');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized declared streaming body before returning it', async () => {
    const cancel = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-length': '1025' }),
      body: new ReadableStream({ cancel }),
    });

    await expect(
      httpStreamRequest('https://api.example.com/declared-large'),
    ).rejects.toBeInstanceOf(HttpResponseTooLargeError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('errors the readable stream when its actual bytes exceed the bound', async () => {
    const cancel = vi.fn();
    const chunks = [new Uint8Array(700), new Uint8Array(400)];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
      },
      cancel,
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(body, { status: 200 }));

    const response = await httpStreamRequest(
      'https://api.example.com/actual-large',
    );
    const reader = response.body.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await expect(reader.read()).rejects.toBeInstanceOf(
      HttpResponseTooLargeError,
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('preserves caller abort during body consumption', async () => {
    const caller = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first chunk'));
      },
      cancel,
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(body, { status: 200 }));

    const response = await httpStreamRequest('https://api.example.com/abort', {
      signal: caller.signal,
      timeout: 30_000,
    });
    const reader = response.body.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    const pending = reader.read();
    caller.abort();

    await expect(pending).rejects.toBeInstanceOf(HttpRequestAbortedError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('keeps the timeout active during body consumption', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(body, { status: 200 }));

    const response = await httpStreamRequest(
      'https://api.example.com/body-timeout',
      { timeout: 20 },
    );
    const reader = response.body.getReader();

    await expect(reader.read()).rejects.toBeInstanceOf(HttpRequestTimeoutError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'rejects invalid streaming timeout %s before fetch',
    async (timeout) => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      await expect(
        httpStreamRequest('https://api.example.com/invalid-timeout', {
          timeout,
        }),
      ).rejects.toThrow('HTTP timeout must be a positive integer');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
