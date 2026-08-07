import { describe, expect, it, vi } from 'vitest';
import { PerplexitySearchProvider } from '../../src/adapters/perplexity-search.js';
import type { HttpClient, HttpResponse } from '../../src/core/http-client.js';

function response<T>(data: T, status = 200): HttpResponse<T> {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    data,
    headers: {},
    durationMs: 1,
  };
}

function transport(data: unknown, status = 200) {
  return vi.fn(async () => response(data, status)) as unknown as HttpClient;
}

function provider(
  options: ConstructorParameters<typeof PerplexitySearchProvider>[0] = {},
) {
  return new PerplexitySearchProvider({
    credentials: { env: { PERPLEXITY_API_KEY: 'pplx-test-key' } },
    ...options,
  });
}

function requestBody(mock: ReturnType<typeof vi.fn>): unknown {
  return mock.mock.calls[0]?.[1]?.body;
}

describe('Perplexity Search provider', () => {
  it('preserves the no-options single-query request and legacy snippet limits', async () => {
    const httpClient = transport({
      id: 'search-1',
      results: [
        {
          url: 'https://example.test/result',
          title: 'Result',
          snippet: 'x'.repeat(350),
        },
      ],
    });

    const result = await provider({ httpClient }).execute('base query', {
      timeout: 10,
    });

    expect(httpClient).toHaveBeenCalledTimes(1);
    expect(requestBody(httpClient as ReturnType<typeof vi.fn>)).toEqual({
      query: 'base query',
      max_results: 10,
    });
    expect(result.content).toBe(
      `- **[Result](https://example.test/result)**\n  ${'x'.repeat(300)}`,
    );
    expect(result.citations).toEqual([
      {
        url: 'https://example.test/result',
        title: 'Result',
        snippet: 'x'.repeat(200),
        provider: 'perplexity-search',
      },
    ]);
  });

  it('maps each supported Search API option and holds local metering metadata back', async () => {
    const httpClient = transport({ id: 'search-2', results: [] });

    await provider({
      httpClient,
      perRequestUsd: 0.005,
      maxResults: 20,
      country: 'ca',
      searchLanguageFilter: ['EN', 'fr'],
      searchDomainAllowlist: ['docs.perplexity.ai', 'example.test'],
      maxTokens: 50_000,
      maxTokensPerPage: 4_096,
    }).execute('configured', { timeout: 10 });

    expect(requestBody(httpClient as ReturnType<typeof vi.fn>)).toEqual({
      query: 'configured',
      max_results: 20,
      country: 'CA',
      search_language_filter: ['en', 'fr'],
      search_domain_filter: ['docs.perplexity.ai', 'example.test'],
      max_tokens: 50_000,
      max_tokens_per_page: 4_096,
    });
  });

  it('maps the Search context size only on its own', async () => {
    const httpClient = transport({ id: 'search-3', results: [] });

    await provider({ httpClient, searchContextSize: 'high' }).execute('query', {
      timeout: 10,
    });

    expect(requestBody(httpClient as ReturnType<typeof vi.fn>)).toEqual({
      query: 'query',
      max_results: 10,
      search_context_size: 'high',
    });
  });

  it('maps a domain denylist with Perplexity’s required prefix', async () => {
    const httpClient = transport({ id: 'search-denylist', results: [] });

    await provider({
      httpClient,
      searchDomainDenylist: ['ads.example', 'spam.example'],
    }).execute('query', { timeout: 10 });

    expect(requestBody(httpClient as ReturnType<typeof vi.fn>)).toEqual({
      query: 'query',
      max_results: 10,
      search_domain_filter: ['-ads.example', '-spam.example'],
    });
  });

  it('makes one request with at most five trimmed, unique queries in deterministic order', async () => {
    const httpClient = transport({ id: 'search-4', results: [] });

    await provider({
      httpClient,
      additionalQueries: [
        '  perspective one  ',
        'base',
        'perspective one',
        'two',
      ],
    }).execute('base', { timeout: 10 });

    expect(httpClient).toHaveBeenCalledTimes(1);
    expect(requestBody(httpClient as ReturnType<typeof vi.fn>)).toEqual({
      query: ['base', 'perspective one', 'two'],
      max_results: 10,
    });
  });

  it('allows exactly four additional queries, for at most five in the request', async () => {
    const httpClient = transport({ id: 'search-five', results: [] });

    await provider({
      httpClient,
      additionalQueries: ['one', 'two', 'three', 'four'],
    }).execute('base', { timeout: 10 });

    expect(requestBody(httpClient as ReturnType<typeof vi.fn>)).toEqual({
      query: ['base', 'one', 'two', 'three', 'four'],
      max_results: 10,
    });
  });

  it.each([
    ['unknown option', { searchRecencyFilter: 'week' }, 'Unrecognized key'],
    ['result count', { maxResults: 21 }, 'maxResults'],
    ['country', { country: 'ZZ' }, 'country'],
    ['language', { searchLanguageFilter: ['zz'] }, 'searchLanguageFilter'],
    [
      'too many domains',
      { searchDomainAllowlist: Array(21).fill('a.test') },
      'searchDomainAllowlist',
    ],
    [
      'long domain',
      { searchDomainDenylist: ['a'.repeat(254)] },
      'searchDomainDenylist',
    ],
    [
      'query count',
      { additionalQueries: ['a', 'b', 'c', 'd', 'e'] },
      'additionalQueries',
    ],
    ['empty query', { additionalQueries: [' '] }, 'additionalQueries'],
    ['token budget', { maxTokens: 0 }, 'maxTokens'],
    [
      'per-page token budget',
      { maxTokensPerPage: 1_000_001 },
      'maxTokensPerPage',
    ],
    ['context size', { searchContextSize: 'large' }, 'searchContextSize'],
    [
      'domain mode conflict',
      {
        searchDomainAllowlist: ['allow.test'],
        searchDomainDenylist: ['deny.test'],
      },
      'mutually exclusive',
    ],
    [
      'context/token conflict',
      { searchContextSize: 'low', maxTokensPerPage: 1 },
      'cannot be combined',
    ],
  ])('rejects invalid %s before HTTP', async (_name, options, error) => {
    const httpClient = transport({ id: 'unexpected', results: [] });

    const result = await provider({ httpClient, ...options }).execute('query', {
      timeout: 10,
    });

    expect(result.error).toContain(error);
    expect(httpClient).not.toHaveBeenCalled();
  });

  it('bounds enhanced multi-query output, preserves first order, and safely truncates Unicode code points', async () => {
    const longTitle = `${'t'.repeat(511)}😀title after limit`;
    const longSnippet = `${'s'.repeat(499)}😀${'z'.repeat(2_100)}`;
    const results = [
      {
        url: 'https://example.test/first?utm_source=one',
        title: longTitle,
        snippet: longSnippet,
      },
      {
        url: 'http://www.example.test/first',
        title: 'duplicate URL',
        snippet: 'ignored',
      },
      ...Array.from({ length: 98 }, (_, index) => ({
        url: `https://example.test/${index + 2}`,
        title: `Title ${index}`.padEnd(512, 'x'),
        snippet: 'snippet'.repeat(400),
      })),
      {
        url: 'https://example.test/outside-upstream-limit',
        title: 'must not be considered',
        snippet: 'outside',
      },
    ];
    const httpClient = transport({ id: 'search-5', results });

    const result = await provider({
      httpClient,
      additionalQueries: ['other perspective'],
    }).execute('base', { timeout: 10 });

    expect(result.citations).toHaveLength(99);
    expect(result.citations[0]).toMatchObject({
      url: 'https://example.test/first?utm_source=one',
      title: `${'t'.repeat(511)}😀`,
      snippet: `${'s'.repeat(499)}😀`,
    });
    expect(Array.from(result.citations[0]?.title ?? '')).toHaveLength(512);
    expect(Array.from(result.citations[0]?.snippet ?? '')).toHaveLength(500);
    expect(result.citations.map((citation) => citation.url)).not.toContain(
      'https://example.test/outside-upstream-limit',
    );
    expect(Array.from(result.content)).toHaveLength(64_000);
    expect(result.content).toContain(`${'t'.repeat(511)}😀`);
  });

  it('returns empty, HTTP-error, and health-check outcomes through the injectable transport', async () => {
    const emptyClient = transport({ id: 'empty', results: [] });
    await expect(
      provider({ httpClient: emptyClient }).execute('empty', { timeout: 10 }),
    ).resolves.toMatchObject({ content: 'No results found.', citations: [] });

    const errorClient = transport({ error: 'bad request' }, 400);
    await expect(
      provider({ httpClient: errorClient }).execute('error', { timeout: 10 }),
    ).resolves.toMatchObject({
      error: expect.stringContaining('API returned 400'),
    });

    const healthClient = transport({ id: 'health', results: [] });
    await expect(
      provider({
        httpClient: healthClient,
        additionalQueries: ['ignored by health check'],
      }).test(),
    ).resolves.toEqual({ ok: true });
    expect(requestBody(healthClient as ReturnType<typeof vi.fn>)).toEqual({
      query: 'test',
      max_results: 1,
    });
  });
});
