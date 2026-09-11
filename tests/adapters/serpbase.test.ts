import { describe, expect, it, vi } from 'vitest';
import { SerpBaseProvider } from '../../src/adapters/serpbase.js';
import {
  type HttpClient,
  HttpRequestAbortedError,
  HttpRequestTimeoutError,
  type HttpResponse,
  httpRequest,
} from '../../src/core/http-client.js';
import {
  buildProviderMetering,
  estimateMetering,
} from '../../src/core/metering.js';

const credential = 'serpbase-test-credential';

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

function success(kind: 'search' | 'news', results: unknown[] = []) {
  return {
    status: 0,
    request_id: 'request-1',
    elapsed_ms: 12,
    credits_charged: 1,
    search_type: kind,
    query: 'normalized query',
    page: 1,
    [kind === 'search' ? 'organic' : 'news']: results,
  };
}

function provider(
  kind: 'search' | 'news',
  options: Record<string, unknown> = {},
) {
  return new SerpBaseProvider(kind, {
    credentials: { env: { SERPBASE_API_KEY: credential } },
    ...options,
  });
}

describe('SerpBase provider', () => {
  it('sends every Search option in one non-retried POST and keeps pricing local', async () => {
    const httpClient = transport(success('search'));
    const signal = new AbortController().signal;

    await provider('search', {
      httpClient,
      creditUsd: 0.004,
      hl: 'fr',
      gl: 'ca',
      page: 3,
      device: 'mobile',
      includeRichResults: true,
    }).execute('québec weather', { timeout: 7, signal });

    expect(httpClient).toHaveBeenCalledOnce();
    expect(httpClient).toHaveBeenCalledWith(
      'https://api.serpbase.dev/google/search',
      {
        method: 'POST',
        headers: { 'X-API-Key': credential },
        body: {
          q: 'québec weather',
          hl: 'fr',
          gl: 'ca',
          page: 3,
          device: 'mobile',
        },
        timeout: 7_000,
        signal,
        retry: { mode: 'never' },
        redirect: 'manual',
      },
    );
  });

  it('refuses redirects through the production transport without exposing error bodies', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Bearer unrelated-secret' }), {
        status: 302,
        headers: { location: 'https://other-origin.test' },
      }),
    );
    try {
      const result = await provider('search', {
        httpClient: httpRequest,
      }).execute('query', { timeout: 2 });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('manual');
      expect(result.error).toBe('SerpBase rejected the request (HTTP 302).');
      expect(JSON.stringify(result)).not.toContain('unrelated-secret');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('rejects signed evidence URLs and omits sensitive opaque fields', async () => {
    const urls = [
      'https://safe.test/?sig=private',
      'https://safe.test/#session_id=private',
      'https://safe.test/?next=%252F%253Ftoken%253Dprivate',
    ];
    for (const link of urls) {
      const result = await provider('search', {
        httpClient: transport(
          success('search', [{ rank: 1, title: 'Result', link }]),
        ),
      }).execute('query', { timeout: 2 });
      expect(result.error).toContain('safe HTTP(S) URL');
      expect(result.citations).toEqual([]);
    }
    const result = await provider('search', {
      includeRichResults: true,
      httpClient: transport({
        ...success('search'),
        featured_snippet: {
          auth: 'private-auth',
          bearer: 'private-bearer',
          session_id: 'private-session',
          'X-Goog-Signature': 'private-signature',
          safe: 'kept',
          link: urls[0],
        },
      }),
    }).execute('query', { timeout: 2 });
    expect(result.content).toContain('kept');
    expect(result.content).not.toContain('private');
    expect(result.content).toContain('[omitted unsafe URL]');
  });

  it('bounds retained primary text without rejecting ordinary authentication documentation URLs', async () => {
    const item = {
      rank: 1,
      title: 'é'.repeat(1500),
      snippet: 'z'.repeat(3000),
      link: 'https://docs.test/authentication?q=token',
    };
    const result = await provider('search', {
      httpClient: transport(success('search', [item])),
    }).execute('query', { timeout: 2 });
    expect(result.error).toBeUndefined();
    expect(new TextEncoder().encode(result.citations[0].title).length).toBe(
      2000,
    );
    expect(result.citations[0].snippet?.length).toBe(2000);
    const oversized = await provider('search', {
      httpClient: transport(
        success(
          'search',
          Array.from({ length: 101 }, () => item),
        ),
      ),
    }).execute('query', { timeout: 2 });
    expect(oversized.error).toContain('exceeds 100');
    expect(oversized.usage?.billableUnits).toBe(1);
  });

  it('requires bounded envelope metadata and classifies HTTP timeouts', async () => {
    for (const patch of [
      { request_id: undefined },
      { request_id: 'x'.repeat(256) },
      { elapsed_ms: undefined },
      { elapsed_ms: Infinity },
    ]) {
      const result = await provider('search', {
        httpClient: transport({ ...success('search'), ...patch }),
      }).execute('query', { timeout: 2 });
      expect(result.error).toContain('Malformed SerpBase');
      expect(result.usage?.billableUnits).toBe(1);
    }
    for (const status of [408, 504]) {
      const result = await provider('search', {
        httpClient: transport({ error: 'private response' }, status),
      }).execute('query', { timeout: 2 });
      expect(result.failureDiagnostic?.kind).toBe('timeout');
      expect(result.error).not.toContain('private response');
    }
  });

  it('uses endpoint defaults by omission and rejects endpoint-inappropriate options', async () => {
    const searchClient = transport(success('search'));
    await provider('search', { httpClient: searchClient }).execute('query', {
      timeout: 2,
    });
    expect(searchClient.mock.calls[0]?.[1]?.body).toEqual({ q: 'query' });

    const newsClient = transport(success('news'));
    const result = await provider('news', {
      httpClient: newsClient,
      device: 'pc',
    }).execute('query', { timeout: 2 });
    expect(result.error).toContain('Unrecognized key');
    expect(result.failureDiagnostic).toEqual({ kind: 'invalid_request' });
    expect(newsClient).not.toHaveBeenCalled();
  });

  it('preserves documented organic rank and ignores rich modules by default', async () => {
    const httpClient = transport({
      ...success('search', [
        {
          rank: 7,
          position: 99,
          title: 'A [ranked] result',
          link: 'https://example.test/a?q=(safe)',
          snippet: 'Snippet with https://untrusted-display.test and @name',
        },
      ]),
      featured_snippet: { text: 'hidden' },
      people_also_ask: [
        {
          question: 'Hidden?',
          snippet: 'Hidden',
          link: 'https://example.test/hidden',
        },
      ],
      related_searches: ['hidden suggestion'],
    });

    const result = await provider('search', { httpClient }).execute('query', {
      timeout: 2,
    });

    expect(result.content).toContain(
      '### 7. [A \\[ranked\\] result](https://example.test/a?q=\\(safe\\))',
    );
    expect(result.content).not.toContain('Featured Snippet');
    expect(result.content).not.toContain('People Also Ask');
    expect(result.content).not.toContain('Related Searches');
    expect(result.citations).toEqual([
      expect.objectContaining({
        url: 'https://example.test/a?q=(safe)',
        provider: 'serpbase-search',
        sourceKind: 'web_page',
      }),
    ]);
    expect(result.usage).toEqual({ billableUnits: 1, unit: 'credit' });
  });

  it('projects opted-in rich results conservatively and deduplicates sourced citations', async () => {
    const httpClient = transport({
      ...success('search', [
        {
          rank: 1,
          title: 'Organic',
          link: 'https://example.test/shared?utm_source=organic',
          snippet: 'Organic snippet',
        },
      ]),
      featured_snippet: {
        unconfirmed_field: 'literal value',
        link: 'https://feature.test/source',
        thumbnail_url: 'https://images.test/private.jpg',
        prototype: 'omitted',
      },
      top_stories: [{ unknown: 'story value' }],
      knowledge_graph: { nested: { fact: 'entity value' } },
      people_also_ask: [
        {
          question: 'What is shared?',
          snippet: 'A sourced answer.',
          link: 'https://example.test/shared',
          displayed_link: 'example.test',
        },
        {
          question: 'What is unique?',
          snippet: 'Another sourced answer.',
          link: 'https://paa.test/unique',
          displayed_link: 'paa.test',
        },
        {
          question: 'Unsafe source?',
          snippet: 'Must not become evidence.',
          link: 'javascript:alert(1)',
          displayed_link: 'unsafe.test',
        },
      ],
      related_searches: ['suggestion one', 'suggestion one', 'suggestion two'],
    });

    const result = await provider('search', {
      httpClient,
      includeRichResults: true,
    }).execute('query', { timeout: 2 });

    expect(result.content).toContain('## Featured Snippet\n\n```json');
    expect(result.content).toContain('"unconfirmed_field": "literal value"');
    expect(result.content).not.toContain('thumbnail_url');
    expect(result.content).not.toContain('prototype');
    expect(result.content).toContain('## Top Stories\n\n```json');
    expect(result.content).toContain('## Knowledge Graph\n\n```json');
    expect(result.content).toContain('## People Also Ask');
    expect(result.content).toContain(
      '[Source: paa.test](https://paa.test/unique)',
    );
    expect(result.content).not.toContain('javascript:');
    expect(result.content).toContain(
      '## Related Searches\n\n- suggestion one\n- suggestion two',
    );
    expect(result.citations.map(({ url }) => url)).toEqual([
      'https://example.test/shared?utm_source=organic',
      'https://paa.test/unique',
    ]);
  });

  it('omits absent and wrong-shaped opaque rich modules without guessing a schema', async () => {
    const httpClient = transport({
      ...success('search'),
      featured_snippet: [],
      top_stories: { title: 'not a documented list' },
      knowledge_graph: undefined,
    });

    const result = await provider('search', {
      httpClient,
      includeRichResults: true,
    }).execute('query', { timeout: 2 });

    expect(result.content).toBe('No results found.');
    expect(result.citations).toEqual([]);
  });

  it('bounds opaque rich projection and fails the module closed on reflected credentials', async () => {
    const httpClient = transport({
      ...success('search'),
      featured_snippet: {
        public: 'bounded feature content',
      },
      top_stories: [
        {
          unsafe_url: 'file:///etc/passwd',
          fence: '```breakout',
          long: '😀'.repeat(3_000),
          child: { one: { two: { three: { four: 'too deep' } } } },
        },
        ...Array.from({ length: 25 }, (_, index) => ({ index })),
      ],
      knowledge_graph: Object.fromEntries(
        Array.from({ length: 25 }, (_, index) => [`field_${index}`, index]),
      ),
    });

    const result = await provider('search', {
      httpClient,
      includeRichResults: true,
    }).execute('query', { timeout: 2 });

    expect(result.content).toContain('Featured Snippet');
    expect(result.content).not.toContain(credential);
    expect(result.content).toContain('[omitted unsafe URL]');
    expect(result.content).toContain('\\u0060\\u0060\\u0060breakout');
    expect(result.content).toContain('[truncated]');
    expect(result.content).not.toContain('field_20');
    const topStories = result.content.match(
      /## Top Stories\n\n(```json[\s\S]*?```)/,
    );
    expect(topStories?.[1]).toBeDefined();
    expect(
      new TextEncoder().encode(topStories?.[1]).length,
    ).toBeLessThanOrEqual(8_000);
  });

  it.each([
    [
      'organic title',
      { organic: [{ rank: 1, title: credential, link: 'https://safe.test' }] },
    ],
    [
      'organic URL',
      {
        organic: [
          { rank: 1, title: 'Safe', link: `https://safe.test/${credential}` },
        ],
      },
    ],
    [
      'PAA snippet',
      {
        people_also_ask: [
          {
            question: 'Question',
            snippet: `reflected ${credential}`,
            link: 'https://safe.test/paa',
          },
        ],
      },
    ],
    ['related suggestion', { related_searches: [`reflected ${credential}`] }],
    ['request id', { request_id: `request-${credential}` }],
  ])(
    'fails the entire response closed on credential reflection in %s',
    async (_case, patch) => {
      const httpClient = transport({
        ...success('search'),
        ...patch,
      });

      const result = await provider('search', {
        httpClient,
        includeRichResults: true,
      }).execute('query', { timeout: 2 });

      expect(result.error).toBe(
        'SerpBase response omitted because it reflected the configured credential.',
      );
      expect(result.content).toBe('');
      expect(result.citations).toEqual([]);
      expect(result.providerMeta).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(credential);
      expect(result.usage).toEqual({ billableUnits: 1, unit: 'credit' });
    },
  );

  it('maps documented News fields while keeping relative time opaque', async () => {
    const httpClient = transport(
      success('news', [
        {
          rank: 2,
          title: 'Relative report',
          link: 'https://news.test/relative',
          source: 'News Desk',
          published_at: '2 days ago',
          snippet: 'Relative timestamp.',
        },
        {
          rank: 4,
          title: 'Timestamped report',
          link: 'https://news.test/timestamped',
          source: 'Wire',
          published_at: '2026-09-11T12:34:56Z',
        },
      ]),
    );

    const result = await provider('news', {
      httpClient,
      hl: 'en',
      gl: 'us',
      page: 2,
    }).execute('headlines', { timeout: 4 });

    expect(httpClient.mock.calls[0]?.[0]).toBe(
      'https://api.serpbase.dev/google/news',
    );
    expect(httpClient.mock.calls[0]?.[1]?.body).toEqual({
      q: 'headlines',
      hl: 'en',
      gl: 'us',
      page: 2,
    });
    expect(result.content).toContain('### 2. [Relative report]');
    expect(result.content).toContain('News Desk · 2 days ago');
    expect(result.citations[0]).not.toHaveProperty('publishedAt');
    expect(result.citations[1]).toMatchObject({
      publisher: 'Wire',
      publishedAt: '2026-09-11T12:34:56Z',
      sourceKind: 'news_article',
    });
  });

  it.each([
    [1000, 'invalid_request'],
    [1001, 'authentication'],
    [1020, 'billing'],
    [1029, 'rate_limit'],
    [1504, 'timeout'],
    [1502, 'provider'],
  ] as const)(
    'treats business status %i as a failure with honest charged credits',
    async (status, kind) => {
      const httpClient = transport({
        status,
        error: `failure ${status}`,
        request_id: 'failed-request',
        elapsed_ms: 4,
        credits_charged: 0.5,
      });

      const result = await provider('search', { httpClient }).execute('query', {
        timeout: 2,
      });

      expect(result.error).toBe(`SerpBase reported business status ${status}.`);
      expect(result.failureDiagnostic).toEqual({ kind });
      expect(result.usage).toEqual({ billableUnits: 0.5, unit: 'credit' });
      expect(result.content).toBe('');
    },
  );

  it('distinguishes an empty success from malformed successful payloads', async () => {
    await expect(
      provider('search', { httpClient: transport(success('search')) }).execute(
        'empty',
        { timeout: 2 },
      ),
    ).resolves.toMatchObject({ content: 'No results found.', citations: [] });

    for (const malformed of [
      'not an object',
      { ...success('search'), status: '0' },
      { ...success('search'), credits_charged: '1' },
      { ...success('search'), organic: {} },
      {
        ...success('search'),
        organic: [
          { rank: 1, title: 'Unsafe', link: 'https://user:pass@example.test' },
        ],
      },
    ]) {
      const result = await provider('search', {
        httpClient: transport(malformed),
      }).execute('malformed', { timeout: 2 });
      expect(result.error).toContain('Malformed SerpBase search response');
      expect(result.content).toBe('');
      if (typeof malformed === 'object' && malformed?.credits_charged === 1) {
        expect(result.usage).toEqual({ billableUnits: 1, unit: 'credit' });
      }
    }
  });

  it('reports missing credentials as unavailable without dispatching', async () => {
    const httpClient = transport(success('search'));
    const instance = new SerpBaseProvider('search', { httpClient });

    const result = await instance.execute('query', { timeout: 2 });
    expect(result.error).toContain('Set SERPBASE_API_KEY');
    expect(result.failureDiagnostic).toEqual({ kind: 'authentication' });
    expect(result.content).toBe('');
    expect(httpClient).not.toHaveBeenCalled();
    await expect(instance.test()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('SERPBASE_API_KEY'),
    });
  });

  it('preserves deadline and cancellation signals without retrying', async () => {
    const timeoutClient = vi.fn(async () => {
      throw new HttpRequestTimeoutError(1_000);
    }) as unknown as HttpClient;
    const timedOut = await provider('search', {
      httpClient: timeoutClient,
    }).execute('slow', { timeout: 1 });
    expect(timedOut.error).toContain('Request timed out after 1000ms');
    expect(timedOut.failureDiagnostic).toEqual({ kind: 'timeout' });
    expect(timeoutClient).toHaveBeenCalledOnce();

    const abortClient = vi.fn(async () => {
      throw new HttpRequestAbortedError();
    }) as unknown as HttpClient;
    const signal = AbortSignal.abort();
    const cancelled = await provider('news', {
      httpClient: abortClient,
    }).execute('cancelled', { timeout: 1, signal });
    expect(cancelled.error).toBe('Request aborted');
    expect(cancelled.failureDiagnostic).toBeUndefined();
    expect(abortClient.mock.calls[0]?.[1]?.signal).toBe(signal);
    expect(abortClient).toHaveBeenCalledOnce();
  });

  it('keeps pre-dispatch USD configured-only and actual credits distinct', () => {
    expect(estimateMetering('serpbase-search')).toMatchObject({
      billableUnits: 1,
      unit: 'credit',
      costConfidence: 'estimated',
    });
    expect(
      estimateMetering('serpbase-search')?.estimatedCostUsd,
    ).toBeUndefined();
    expect(
      estimateMetering('serpbase-news', { options: { creditUsd: 0.003 } }),
    ).toMatchObject({
      estimatedCostUsd: 0.003,
      billableUnits: 1,
      unit: 'credit',
      costConfidence: 'configured',
    });
    expect(
      buildProviderMetering('serpbase-search', undefined, {
        billableUnits: 1,
        unit: 'credit',
      }).actual,
    ).toEqual({ billableUnits: 1, source: 'provider_reported' });
  });
});
