import { describe, expect, it, vi } from 'vitest';
import { SerpApiProvider } from '../../src/adapters/serpapi.js';
import type { HttpClient } from '../../src/core/http-client.js';

describe('SerpAPI authentication', () => {
  const sentinel = 'sentinel-serpapi-credential';

  it('preserves required query authentication', async () => {
    const httpClient = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      data: { organic_results: [] },
      headers: {},
      durationMs: 1,
    })) as HttpClient;
    const provider = new SerpApiProvider({
      credentials: { env: { SERPAPI_API_KEY: sentinel } },
      httpClient,
    });

    await provider.execute('query', { timeout: 10 });

    const [requestUrl] = vi.mocked(httpClient).mock.calls[0];
    expect(new URL(requestUrl).searchParams.get('api_key')).toBe(sentinel);
  });

  it('redacts query credentials from health-check diagnostics', async () => {
    const httpClient = vi.fn(async (url: string) => {
      throw new Error(`upstream rejected ${url}`);
    }) as HttpClient;
    const provider = new SerpApiProvider({
      credentials: { env: { SERPAPI_API_KEY: sentinel } },
      httpClient,
    });

    const result = await provider.test();

    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      'upstream rejected https://serpapi.com/search',
    );
    expect(result.error).toContain('api_key=[REDACTED]');
    expect(result.error).not.toContain(sentinel);
  });
});
