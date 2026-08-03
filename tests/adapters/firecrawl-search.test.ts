import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { FirecrawlSearchProvider } from '../../src/adapters/firecrawl-search.js';
import { getProvider, initializeProviders } from '../../src/adapters/index.js';

function jsonResponse(status: number, data: unknown): Response {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers({}),
    text: async () => JSON.stringify(data),
  } as Response;
}

function provider(
  options: Record<string, unknown> = {},
): FirecrawlSearchProvider {
  return new FirecrawlSearchProvider({
    ...options,
    credentials: { env: { FIRECRAWL_API_KEY: 'firecrawl-test-key' } },
  });
}

function requestBody(mock: ReturnType<typeof vi.fn>): unknown {
  const [, options] = mock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(options.body as string);
}

describe('Firecrawl Search provider', () => {
  const originalFetch = globalThis.fetch;

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses web and limit 10 by default', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { success: true, data: {} }));
    globalThis.fetch = fetchMock;

    const result = await provider().execute('default search', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(requestBody(fetchMock)).toEqual({
      query: 'default search',
      limit: 10,
      sources: ['web'],
    });
  });

  it('sends every supported configured search option', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { success: true, data: {} }));
    globalThis.fetch = fetchMock;

    await provider({
      sources: ['web', 'news'],
      limit: 7,
      tbs: 'qdr:w',
      country: 'US',
      location: 'Toronto, Ontario, Canada',
      includeDomains: ['Docs.Firecrawl.dev'],
      categories: ['github', 'research', 'pdf'],
      ignoreInvalidURLs: true,
    }).execute('configured search', { timeout: 10 });

    expect(requestBody(fetchMock)).toEqual({
      query: 'configured search',
      limit: 7,
      sources: ['web', 'news'],
      tbs: 'qdr:w',
      country: 'US',
      location: 'Toronto, Ontario, Canada',
      includeDomains: ['docs.firecrawl.dev'],
      categories: [{ type: 'github' }, { type: 'research' }, { type: 'pdf' }],
      ignoreInvalidURLs: true,
    });
  });

  it('renders news-only responses with dates and normalized snippets', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        data: {
          news: [
            {
              title: 'News title',
              url: 'https://news.example/story',
              snippet: '  A fresh\n update.  ',
              date: ' 2026-08-03 ',
            },
          ],
        },
      }),
    );

    const result = await provider({ sources: ['news'] }).execute('news', {
      timeout: 10,
    });

    expect(result.content).toBe(
      '## News\n\n- **[News title](https://news.example/story)** (2026-08-03)\n  A fresh update.',
    );
    expect(result.citations).toEqual([
      {
        url: 'https://news.example/story',
        title: 'News title',
        snippet: 'A fresh update.',
        provider: 'firecrawl-search',
      },
    ]);
  });

  it('combines web and news results while deduplicating equivalent URLs', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        data: {
          web: [
            {
              title: 'Web result',
              url: 'https://example.com',
              description: '  Web\n description ',
            },
          ],
          news: [
            {
              title: 'Duplicate news',
              url: 'https://example.com/#today',
              snippet: 'ignored duplicate',
              date: '2026-08-02',
            },
            {
              title: 'Distinct news',
              url: 'https://news.example/story',
              snippet: 'News summary',
              date: '2026-08-03',
            },
          ],
        },
      }),
    );

    const result = await provider({ sources: ['web', 'news'] }).execute(
      'mixed',
      { timeout: 10 },
    );

    expect(result.content).toBe(
      '## Web\n\n- **[Web result](https://example.com)**\n  Web description\n\n## News\n\n- **[Distinct news](https://news.example/story)** (2026-08-03)\n  News summary',
    );
    expect(result.citations.map((citation) => citation.url)).toEqual([
      'https://example.com',
      'https://news.example/story',
    ]);
  });

  it('ignores malformed results without a safe absolute HTTP(S) URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        data: {
          web: [
            null,
            {},
            { url: '' },
            { url: 42 },
            { url: 'not a URL' },
            { url: 'javascript:alert(1)' },
            { url: 'ftp://example.com' },
            { url: 'https://ok.example' },
          ],
          news: 'not an array',
        },
      }),
    );

    const result = await provider({ sources: ['web', 'news'] }).execute(
      'malformed',
      { timeout: 10 },
    );

    expect(result.content).toContain('https://ok.example');
    expect(result.citations).toEqual([
      {
        url: 'https://ok.example',
        provider: 'firecrawl-search',
      },
    ]);
  });

  it.each([
    [0, { billableUnits: 0, unit: 'credit' }],
    [4, { billableUnits: 4, unit: 'credit' }],
    [-1, undefined],
    [1.5, undefined],
    ['4', undefined],
  ])(
    'surfaces only valid provider-reported creditsUsed values (%s)',
    async (creditsUsed, usage) => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(200, { success: true, data: {}, creditsUsed }),
        );

      const result = await provider().execute('credits', { timeout: 10 });

      expect(result.usage).toEqual(usage);
    },
  );

  it('rejects invalid configured options before fetch', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const result = await provider({ limit: 101 }).execute('invalid', {
      timeout: 10,
    });

    expect(result.error).toContain('limit');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['empty sources', { sources: [] }, 'sources'],
    ['unsupported source', { sources: ['images'] }, 'sources'],
    ['empty categories', { categories: [] }, 'categories'],
    ['unsupported category', { categories: ['video'] }, 'categories'],
    [
      'invalid hostname',
      { includeDomains: ['https://example.com'] },
      'hostnames',
    ],
  ])('rejects %s before fetch', async (_name, options, expectedError) => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const result = await provider(options).execute('invalid config', {
      timeout: 10,
    });

    expect(result.error).toContain(expectedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects conflicting domain filters before fetch', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const result = await provider({
      includeDomains: ['example.com'],
      excludeDomains: ['other.example'],
    }).execute('invalid domains', { timeout: 10 });

    expect(result.error).toContain('mutually exclusive');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports API success:false and errors safely', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { success: false, error: 'Request timed out' }),
      );

    const result = await provider().execute('failure', { timeout: 10 });

    expect(result.error).toBe('Request timed out');
    expect(result.content).toBe('');
    expect(result.citations).toEqual([]);
  });

  it('reports an API error even when success:false is omitted', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { error: 'Search unavailable' }),
      );

    const result = await provider().execute('failure', { timeout: 10 });

    expect(result.error).toBe('Search unavailable');
    expect(result.content).toBe('');
    expect(result.citations).toEqual([]);
  });

  it('uses a fixed minimal web request for health checks', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { success: true, data: {} }));
    globalThis.fetch = fetchMock;

    const result = await provider({
      sources: ['news'],
      limit: 100,
      categories: ['pdf'],
    }).test();

    expect(result).toEqual({ ok: true });
    expect(requestBody(fetchMock)).toEqual({
      query: 'test',
      limit: 1,
      sources: ['web'],
    });
  });

  it('receives configured options through registry initialization', async () => {
    await initializeProviders({
      credentials: { env: { FIRECRAWL_API_KEY: 'firecrawl-test-key' } },
      providers: {
        'firecrawl-search': {
          options: {
            sources: ['news'],
            limit: 3,
            excludeDomains: ['spam.example'],
          },
        },
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { success: true, data: {} }));
    globalThis.fetch = fetchMock;

    await getProvider('firecrawl-search')!.execute('registry options', {
      timeout: 10,
    });

    expect(requestBody(fetchMock)).toEqual({
      query: 'registry options',
      limit: 3,
      sources: ['news'],
      excludeDomains: ['spam.example'],
    });
  });
});
