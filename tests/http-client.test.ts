import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { httpRequest } from '../src/core/http-client.js';

// Mock constants to reduce retry delays in tests
vi.mock('../src/constants.js', async (importOriginal) => {
  const original =
    (await importOriginal()) as typeof import('../src/constants.js');
  return {
    ...original,
    MAX_RETRIES: 2,
    INITIAL_RETRY_DELAY_MS: 10,
    MAX_RESPONSE_SIZE: 10 * 1024 * 1024,
  };
});

describe('httpRequest', () => {
  const originalFetch = globalThis.fetch;

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
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
