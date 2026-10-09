import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveSearchApiGoogleAiOverviewCitations } from '../../src/adapters/searchapi-google.js';
import {
  SEARCHAPI_GOOGLE_AI_OVERVIEW_MAX_LOGICAL_OPERATIONS,
  SEARCHAPI_GOOGLE_AI_OVERVIEW_NO_OVERVIEW_ERROR,
  SEARCHAPI_GOOGLE_AI_OVERVIEW_UNPARSED_ERROR,
  SearchApiGoogleAiOverviewProvider,
} from '../../src/adapters/searchapi-google-ai-overview.js';
import { ProviderMetaSchema } from '../../src/contracts/interchange/research-result.js';
import type {
  HttpClient,
  HttpRequestOptions,
  HttpResponse,
} from '../../src/core/http-client.js';
import {
  SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY,
  SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_TOKEN,
  searchApiGoogleAiOverviewFixtures,
} from '../fixtures/searchapi-google-ai-overview.js';

interface RecordedRequest {
  url: string;
  options: HttpRequestOptions;
}

/** Sanitized SearchAPI shapes shared with the PHP package's driver tests. */
function sharedFixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL(`../fixtures/searchapi/${name}.json`, import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>;
}

/** Answer each request by its SearchAPI engine and record the URLs. */
function engineProvider(
  pages: { google: unknown; google_ai_overview?: unknown },
  options: { zeroRetention?: boolean } = {},
): { provider: SearchApiGoogleAiOverviewProvider; calls: URL[] } {
  const calls: URL[] = [];
  const provider = new SearchApiGoogleAiOverviewProvider({
    apiKey: SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY,
    ...options,
    httpClient: async <T>(url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      const engine = parsed.searchParams.get('engine');
      return response(
        200,
        (engine === 'google'
          ? pages.google
          : (pages.google_ai_overview ?? {})) as T,
      );
    },
  });
  return { provider, calls };
}

function response<T>(status: number, data: T): HttpResponse<T> {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {},
    data,
    durationMs: 1,
  };
}

describe('SearchAPI Google AI Overview adapter', () => {
  it('performs the exact private two-stage sequence and normalizes only stage two', async () => {
    const calls: RecordedRequest[] = [];
    const controller = new AbortController();
    const retry = { mode: 'safe', maxAttempts: 2 } as const;
    const provider = new SearchApiGoogleAiOverviewProvider({
      apiKey: SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY,
      zeroRetention: true,
      retry,
      httpClient: async <T>(url, options = {}) => {
        calls.push({ url, options });
        return response(
          200,
          (calls.length === 1
            ? searchApiGoogleAiOverviewFixtures.stageOneWithToken
            : searchApiGoogleAiOverviewFixtures.successfulOverview) as T,
        );
      },
    });

    const result = await provider.execute('synthetic query', {
      timeout: 7,
      signal: controller.signal,
    });

    expect(provider.maxLogicalOperations).toBe(
      SEARCHAPI_GOOGLE_AI_OVERVIEW_MAX_LOGICAL_OPERATIONS,
    );
    expect(SEARCHAPI_GOOGLE_AI_OVERVIEW_MAX_LOGICAL_OPERATIONS).toBe(2);
    expect(calls).toHaveLength(2);

    const first = calls[0];
    const second = calls[1];
    if (!first || !second) throw new Error('Expected both synthetic stages');
    const firstUrl = new URL(first.url);
    const secondUrl = new URL(second.url);

    expect(firstUrl.searchParams.get('engine')).toBe('google');
    expect(firstUrl.searchParams.get('q')).toBe('synthetic query');
    expect(firstUrl.searchParams.has('page_token')).toBe(false);
    expect(secondUrl.searchParams.get('engine')).toBe('google_ai_overview');
    expect(secondUrl.searchParams.get('page_token')).toBe(
      SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_TOKEN,
    );
    expect(secondUrl.searchParams.has('q')).toBe(false);

    for (const request of calls) {
      const url = new URL(request.url);
      expect(url.searchParams.has('api_key')).toBe(false);
      expect(url.searchParams.get('zero_retention')).toBe('true');
      expect(request.options).toMatchObject({
        headers: {
          Authorization: `Bearer ${SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY}`,
        },
        timeout: 7000,
        signal: controller.signal,
        retry,
      });
    }
    expect(result).toMatchObject({
      provider: 'searchapi-google-ai-overview',
      tier: 'ai-grounded',
      content: searchApiGoogleAiOverviewFixtures.successfulOverview.markdown,
      citations: [
        {
          url: 'https://evidence.example.test/overview',
          title: 'Synthetic overview evidence',
          provider: 'searchapi-google-ai-overview',
        },
      ],
    });
    expect(result.content).not.toContain('Organic content must not render');
    expect(result.citations).not.toContainEqual(
      expect.objectContaining({ url: expect.stringContaining('organic') }),
    );
  });

  it('rejects credential-bearing reference URLs from the second stage', async () => {
    const calls: string[] = [];
    const provider = new SearchApiGoogleAiOverviewProvider({
      apiKey: SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY,
      httpClient: async <T>(url) => {
        calls.push(url);
        return response(
          200,
          (calls.length === 1
            ? searchApiGoogleAiOverviewFixtures.stageOneWithToken
            : {
                markdown: 'Non-empty grounded overview.',
                reference_links: [
                  {
                    url: 'https://username:password@evidence.example.test/private',
                    title: 'Unsafe reference',
                  },
                ],
              }) as T,
        );
      },
    });

    const result = await provider.execute('unsafe reference', { timeout: 7 });

    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({
      content: 'Non-empty grounded overview.',
      citations: [],
    });
    expect(JSON.stringify(result)).not.toContain('username:password');
  });

  it.each([
    ['missing', searchApiGoogleAiOverviewFixtures.missingToken],
    ['invalid', searchApiGoogleAiOverviewFixtures.invalidToken],
  ])(
    'stops after stage one as no AI overview for a %s token',
    async (_label, firstStage) => {
      const calls: string[] = [];
      const provider = new SearchApiGoogleAiOverviewProvider({
        apiKey: SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY,
        httpClient: async <T>(url) => {
          calls.push(url);
          return response(200, firstStage as T);
        },
      });

      const result = await provider.execute('missing token', { timeout: 7 });

      expect(calls).toHaveLength(1);
      expect(new URL(calls[0] as string).searchParams.get('engine')).toBe(
        'google',
      );
      expect(result).toMatchObject({
        content: '',
        citations: [],
        preventFallback: true,
      });
      expect(result.error).toBe(SEARCHAPI_GOOGLE_AI_OVERVIEW_NO_OVERVIEW_ERROR);
      expect(result.content).not.toContain('No organic fallback');
    },
  );

  it('reports an expired token after exactly two logical operations and redacts errors', async () => {
    const calls: string[] = [];
    const provider = new SearchApiGoogleAiOverviewProvider({
      apiKey: SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY,
      httpClient: async <T>(url) => {
        calls.push(url);
        return calls.length === 1
          ? response(
              200,
              searchApiGoogleAiOverviewFixtures.stageOneWithToken as T,
            )
          : response(400, searchApiGoogleAiOverviewFixtures.expiredToken as T);
      },
    });

    const result = await provider.execute('expired token', { timeout: 7 });

    expect(calls).toHaveLength(2);
    expect(result.preventFallback).toBe(true);
    expect(result.error).toContain('page_token expired');
    expect(result.error).toContain('[REDACTED]');
    expect(result.error).not.toContain(
      SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY,
    );
  });

  it('contains a second-stage failure without a third operation or fallback', async () => {
    const calls: string[] = [];
    const provider = new SearchApiGoogleAiOverviewProvider({
      apiKey: SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY,
      zeroRetention: true,
      httpClient: async <T>(url) => {
        calls.push(url);
        return calls.length === 1
          ? response(
              200,
              searchApiGoogleAiOverviewFixtures.stageOneWithToken as T,
            )
          : response(
              503,
              searchApiGoogleAiOverviewFixtures.secondStageFailure as T,
            );
      },
    });

    const result = await provider.execute('stage two failure', { timeout: 7 });

    expect(calls).toHaveLength(2);
    expect(calls.map((url) => new URL(url).searchParams.get('engine'))).toEqual(
      ['google', 'google_ai_overview'],
    );
    expect(result).toMatchObject({
      content: '',
      citations: [],
      preventFallback: true,
    });
    expect(result.error).toContain('503');
  });

  it('honors an abort between stages without starting stage two', async () => {
    const controller = new AbortController();
    const calls: RecordedRequest[] = [];
    const provider = new SearchApiGoogleAiOverviewProvider({
      apiKey: SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY,
      zeroRetention: true,
      httpClient: async <T>(url, options = {}) => {
        calls.push({ url, options });
        controller.abort();
        return response(
          200,
          searchApiGoogleAiOverviewFixtures.stageOneWithToken as T,
        );
      },
    });

    const result = await provider.execute('abort between stages', {
      timeout: 7,
      signal: controller.signal,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.signal).toBe(controller.signal);
    expect(result).toMatchObject({
      content: '',
      citations: [],
      preventFallback: true,
      error: 'Request aborted',
    });
  });

  it('fails a token page without overview material as no AI overview', async () => {
    const calls: string[] = [];
    const provider = new SearchApiGoogleAiOverviewProvider({
      apiKey: SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY,
      httpClient: (async <T>(url) => {
        calls.push(url);
        return response(
          200,
          (calls.length % 2 === 1
            ? searchApiGoogleAiOverviewFixtures.stageOneWithToken
            : searchApiGoogleAiOverviewFixtures.noResult) as T,
        );
      }) as HttpClient,
    });

    const result = await provider.execute('no result', { timeout: 7 });
    expect(result).toMatchObject({
      content: '',
      citations: [],
      preventFallback: true,
      error: SEARCHAPI_GOOGLE_AI_OVERVIEW_NO_OVERVIEW_ERROR,
    });
    expect(calls).toHaveLength(2);

    calls.length = 0;
    await expect(provider.test()).resolves.toEqual({
      ok: false,
      error: SEARCHAPI_GOOGLE_AI_OVERVIEW_NO_OVERVIEW_ERROR,
    });
    expect(calls).toHaveLength(2);
  });

  it('reads an inline AI Overview from the first search without a second request', async () => {
    const { provider, calls } = engineProvider(
      { google: sharedFixture('google-inline-ai-overview') },
      { zeroRetention: true },
    );

    const result = await provider.execute('what is example brand', {
      timeout: 7,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.searchParams.get('engine')).toBe('google');
    expect(calls[0]?.searchParams.get('zero_retention')).toBe('true');
    expect(result.error).toBeUndefined();
    expect(result.content).toMatch(
      /^Example Brand is a synthetic photo tool\./,
    );
    expect(
      result.citations.map((citation) => [
        citation.url,
        citation.providerReference,
        citation.publisher,
      ]),
    ).toEqual([
      [
        'https://example.com',
        'https://www.google.com/goto?url=CAESOFN5bnRoZXRpYy1vcGFxdWUtdG9rZW4tb25l',
        'Example Brand',
      ],
      [
        'https://reviews.example.org',
        'https://www.google.com/goto?url=CAESOFN5bnRoZXRpYy1vcGFxdWUtdG9rZW4tdHdv',
        'Example Reviews',
      ],
    ]);
    expect(result.citations[0]).toMatchObject({
      title: 'Example Brand — Home',
      snippet: 'Synthetic snippet.',
      provider: 'searchapi-google-ai-overview',
    });
    expect(result.providerMeta).toEqual({
      'searchapi:ai_overview_retrieval': 'inline',
      'searchapi:request_count': 1,
    });
    expect(ProviderMetaSchema.safeParse(result.providerMeta).success).toBe(
      true,
    );
  });

  it('prefers an inline overview over a page_token in the same response', async () => {
    const inline = sharedFixture('google-inline-ai-overview');
    const { provider, calls } = engineProvider({
      google: {
        ...inline,
        ai_overview: {
          ...(inline.ai_overview as Record<string, unknown>),
          page_token: 'unused-synthetic-token',
        },
      },
      google_ai_overview: { markdown: 'Must not be requested.' },
    });

    const result = await provider.execute('inline and token', { timeout: 7 });

    expect(calls).toHaveLength(1);
    expect(result.content).not.toContain('Must not be requested.');
    expect(result.providerMeta?.['searchapi:request_count']).toBe(1);
  });

  it('follows page_token only when the first search has no inline overview, despite its not-available error', async () => {
    const { provider, calls } = engineProvider({
      google: sharedFixture('google-page-token'),
      google_ai_overview: sharedFixture('google-ai-overview-page'),
    });

    const result = await provider.execute('best synthetic photo tools', {
      timeout: 7,
    });

    expect(calls.map((url) => url.searchParams.get('engine'))).toEqual([
      'google',
      'google_ai_overview',
    ]);
    expect(calls[1]?.searchParams.get('page_token')).toBe(
      'synthetic-page-token',
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toMatch(/^Synthetic tools include Example Brand/);
    // goto → favicon origin; plain link kept; url?q= target recovered;
    // Google shopping and an opaque link without favicon yield nothing.
    expect(
      result.citations.map((citation) => [
        citation.url,
        citation.providerReference,
      ]),
    ).toEqual([
      [
        'https://example.com',
        'https://www.google.com/goto?url=CAESOFN5bnRoZXRpYy1vcGFxdWUtdG9rZW4tb25l',
      ],
      ['https://www.example.net/guide', undefined],
      [
        'https://www.example.org/legacy',
        'https://www.google.com/url?q=https://www.example.org/legacy&sa=U',
      ],
    ]);
    expect(result.providerMeta).toEqual({
      'searchapi:ai_overview_retrieval': 'page_token',
      'searchapi:request_count': 2,
    });
  });

  it.each([
    {
      label: 'no ai_overview key',
      first: sharedFixture('google-no-ai-overview'),
      second: undefined,
      error: SEARCHAPI_GOOGLE_AI_OVERVIEW_NO_OVERVIEW_ERROR,
      requests: 1,
    },
    {
      label: 'empty ai_overview',
      first: { ai_overview: {} },
      second: undefined,
      error: SEARCHAPI_GOOGLE_AI_OVERVIEW_NO_OVERVIEW_ERROR,
      requests: 1,
    },
    {
      label: 'inline references without readable text and no token',
      first: {
        ai_overview: {
          markdown: 'broken [link](https://x',
          reference_links: [{ link: 'https://www.example.com/' }],
        },
      },
      second: undefined,
      error: SEARCHAPI_GOOGLE_AI_OVERVIEW_UNPARSED_ERROR,
      requests: 1,
    },
    {
      label: 'token page with no overview material',
      first: sharedFixture('google-page-token'),
      second: { search_metadata: { id: 'x' } },
      error: SEARCHAPI_GOOGLE_AI_OVERVIEW_NO_OVERVIEW_ERROR,
      requests: 2,
    },
    {
      label: 'token page with unreadable overview material',
      first: sharedFixture('google-page-token'),
      second: { text_blocks: [{ type: 'image' }] },
      error: SEARCHAPI_GOOGLE_AI_OVERVIEW_UNPARSED_ERROR,
      requests: 2,
    },
  ])(
    'distinguishes a missing from an unreadable overview: $label',
    async ({ first, second, error, requests }) => {
      const { provider, calls } = engineProvider({
        google: first,
        google_ai_overview: second,
      });

      const result = await provider.execute('overview failure', { timeout: 7 });

      expect(calls).toHaveLength(requests);
      expect(result).toMatchObject({
        content: '',
        citations: [],
        preventFallback: true,
        error,
      });
      expect(result.providerMeta).toBeUndefined();
    },
  );

  it('keeps oversized redirect links out of the 255-character provider reference', async () => {
    const link = `https://www.google.com/goto?url=CAES${'A'.repeat(300)}`;
    const { provider } = engineProvider({
      google: {
        ai_overview: {
          markdown: 'Synthetic overview.',
          reference_links: [
            {
              link,
              favicon:
                'https://encrypted-tbn1.gstatic.com/faviconV2?url=https://example.com&client=AIM',
            },
          ],
        },
      },
    });

    const result = await provider.execute('oversized', { timeout: 7 });

    expect(result.citations).toEqual([
      { url: 'https://example.com', provider: 'searchapi-google-ai-overview' },
    ]);
  });
});

describe('SearchAPI Google AI Overview citation resolution', () => {
  const provider = 'searchapi-google-ai-overview';
  const favicon = (site: string) =>
    `https://encrypted-tbn1.gstatic.com/faviconV2?url=${site}&client=AIM`;

  it('prefers a publisher url field over the Google link', () => {
    expect(
      resolveSearchApiGoogleAiOverviewCitations(
        [
          {
            url: 'https://publisher.example/page',
            link: 'https://www.google.com/goto?url=opaque',
            title: ' Publisher page ',
          },
        ],
        provider,
      ),
    ).toEqual([
      {
        url: 'https://publisher.example/page',
        title: 'Publisher page',
        provider,
        providerReference: 'https://www.google.com/goto?url=opaque',
      },
    ]);
  });

  it('never resolves to Google, credential-bearing, or non-http targets', () => {
    expect(
      resolveSearchApiGoogleAiOverviewCitations(
        [
          {
            link: 'https://www.google.com/url?q=https://www.google.com/search',
            favicon: favicon('https://www.google.com'),
          },
          {
            link: 'https://www.google.com/url?q=https://user:pass@private.example/',
          },
          { link: 'https://www.google.com/goto?url=javascript:alert(1)' },
          { link: 'https://www.google.com/goto?url=x', favicon: 'not a url' },
          {
            link: 'https://www.google.com/goto?url=x',
            favicon: favicon('ftp://files.example'),
          },
        ],
        provider,
      ),
    ).toEqual([]);
  });

  it('falls back to the favicon origin when the redirect target is Google', () => {
    expect(
      resolveSearchApiGoogleAiOverviewCitations(
        [
          {
            link: 'https://www.google.com/url?q=https://maps.google.com/x',
            favicon: favicon('https://Shop.Example:8443/path?x=1'),
          },
        ],
        provider,
      ),
    ).toEqual([
      {
        url: 'https://shop.example:8443',
        provider,
        providerReference:
          'https://www.google.com/url?q=https://maps.google.com/x',
      },
    ]);
  });

  it('deduplicates by citation URL and provider reference together', () => {
    const goto = 'https://www.google.com/goto?url=one';
    const citations = resolveSearchApiGoogleAiOverviewCitations(
      [
        { link: goto, favicon: favicon('https://example.com') },
        { link: goto, favicon: favicon('https://example.com') },
        {
          link: 'https://www.google.com/goto?url=two',
          favicon: favicon('https://example.com'),
        },
        { link: 'https://example.com/a' },
        { link: 'https://example.com/a' },
      ],
      provider,
    );

    expect(
      citations.map((citation) => [citation.url, citation.providerReference]),
    ).toEqual([
      ['https://example.com', goto],
      ['https://example.com', 'https://www.google.com/goto?url=two'],
      ['https://example.com/a', undefined],
    ]);
  });
});
