import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProvider, initializeProviders } from '../../src/adapters/index.js';
import { getBuiltInProviderDescriptor } from '../../src/adapters/provider-descriptors.js';
import { SearchApiProvider } from '../../src/adapters/searchapi.js';
import type { SearchApiGoogleResponse } from '../../src/adapters/searchapi-google.js';
import { dispatch } from '../../src/core/dispatcher.js';
import type {
  HttpClient,
  HttpRequestOptions,
  HttpResponse,
} from '../../src/core/http-client.js';
import {
  createSearchApiRequest,
  SEARCHAPI_ZERO_RETENTION_REMEDIATION,
  searchApiOptionsSchema,
} from '../../src/core/searchapi.js';
import type { Config, Provider, ProviderResult } from '../../src/types.js';

const SYNTHETIC_KEY = 'searchapi-synthetic-test-key';
const originalFetch = globalThis.fetch;

function response<T>(status: number, data: T): HttpResponse<T> {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {},
    data,
    durationMs: 1,
  };
}

function asHttpClient(mock: ReturnType<typeof vi.fn>): HttpClient {
  return mock as unknown as HttpClient;
}

function config(options: Record<string, unknown> = {}): Config {
  return {
    version: 1,
    defaults: {
      outputDir: './agents/librarium',
      maxParallel: 1,
      timeout: 9,
      asyncTimeout: 60,
      asyncPollInterval: 1,
      mode: 'sync',
      llmWebSearch: true,
    },
    providers: {
      searchapi: {
        enabled: true,
        options,
      },
    },
    customProviders: {},
    trustedProviderIds: [],
    groups: {},
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('SearchAPI request and privacy contract', () => {
  it('uses bearer auth for execute, omits URL credentials and retention by default, and preserves request controls', async () => {
    const controller = new AbortController();
    const retry = { mode: 'never' as const };
    const httpClient = vi.fn(async () =>
      response(200, {
        organic_results: [
          {
            title: 'Synthetic result',
            link: 'https://example.test/result',
            snippet: 'Fixture-only content.',
          },
        ],
      }),
    );
    const provider = new SearchApiProvider({
      apiKey: SYNTHETIC_KEY,
      httpClient: asHttpClient(httpClient),
      retry,
    });

    const result = await provider.execute('privacy & transport', {
      timeout: 7,
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      provider: 'searchapi',
      content: expect.stringContaining('Synthetic result'),
      citations: [{ url: 'https://example.test/result' }],
    });
    expect(httpClient).toHaveBeenCalledOnce();

    const [rawUrl, requestOptions] = httpClient.mock.calls[0] as unknown as [
      string,
      HttpRequestOptions,
    ];
    const url = new URL(rawUrl);
    expect(url.origin + url.pathname).toBe(
      'https://www.searchapi.io/api/v1/search',
    );
    expect(url.searchParams.get('engine')).toBe('google');
    expect(url.searchParams.get('q')).toBe('privacy & transport');
    expect(url.searchParams.has('api_key')).toBe(false);
    expect(rawUrl).not.toContain(SYNTHETIC_KEY);
    expect(url.searchParams.has('zero_retention')).toBe(false);
    expect(requestOptions).toMatchObject({
      method: 'GET',
      headers: { Authorization: `Bearer ${SYNTHETIC_KEY}` },
      timeout: 7000,
      signal: controller.signal,
      retry,
    });
  });

  it('uses bearer auth and the configured privacy mode for health checks', async () => {
    const httpClient = vi.fn(async () =>
      response(403, {
        error: 'zero_retention is only available on the Enterprise plan',
      }),
    );
    const provider = new SearchApiProvider({
      apiKey: SYNTHETIC_KEY,
      httpClient: asHttpClient(httpClient),
      zeroRetention: true,
    });

    await expect(provider.test()).resolves.toEqual({
      ok: false,
      error: `API returned 403: ${SEARCHAPI_ZERO_RETENTION_REMEDIATION}`,
    });

    const [rawUrl, requestOptions] = httpClient.mock.calls[0] as unknown as [
      string,
      HttpRequestOptions,
    ];
    const url = new URL(rawUrl);
    expect(url.searchParams.get('q')).toBe('test');
    expect(url.searchParams.get('num')).toBe('1');
    expect(url.searchParams.get('zero_retention')).toBe('true');
    expect(url.searchParams.has('api_key')).toBe(false);
    expect(rawUrl).not.toContain(SYNTHETIC_KEY);
    expect(requestOptions.headers).toEqual({
      Authorization: `Bearer ${SYNTHETIC_KEY}`,
    });
  });

  it('sends zero_retention=true only when explicitly enabled', async () => {
    const calls: string[] = [];
    const httpClient = vi.fn(async (url: string) => {
      calls.push(url);
      return response(200, { organic_results: [] });
    });

    await new SearchApiProvider({
      apiKey: SYNTHETIC_KEY,
      httpClient: asHttpClient(httpClient),
      zeroRetention: false,
    }).execute('false', { timeout: 3 });
    await new SearchApiProvider({
      apiKey: SYNTHETIC_KEY,
      httpClient: asHttpClient(httpClient),
      zeroRetention: true,
    }).execute('true', { timeout: 3 });

    expect(new URL(calls[0] as string).searchParams.has('zero_retention')).toBe(
      false,
    );
    expect(new URL(calls[1] as string).searchParams.get('zero_retention')).toBe(
      'true',
    );
  });

  it('keeps zero retention on every ordinary transport retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'temporary failure' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ organic_results: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    globalThis.fetch = fetchMock;

    const result = await new SearchApiProvider({
      apiKey: SYNTHETIC_KEY,
      zeroRetention: true,
      retry: { mode: 'safe', maxAttempts: 2, baseDelayMs: 0 },
    }).execute('retry privacy', { timeout: 3 });

    expect(result.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [rawUrl, requestOptions] of fetchMock.mock.calls) {
      if (!requestOptions) throw new Error('Fetch options were not recorded');
      const url = new URL(String(rawUrl));
      expect(url.searchParams.get('zero_retention')).toBe('true');
      expect(url.searchParams.has('api_key')).toBe(false);
      expect(String(rawUrl)).not.toContain(SYNTHETIC_KEY);
      expect(
        (requestOptions.headers as Record<string, string>).Authorization,
      ).toBe(`Bearer ${SYNTHETIC_KEY}`);
    }
  });

  it('returns narrow remediation through structured dispatch results and preserves configured pricing', async () => {
    const httpClient = vi.fn(async () =>
      response(403, {
        error: 'zero retention requires an Enterprise account',
        diagnostic: `https://www.searchapi.io/api/v1/search?api_key=${SYNTHETIC_KEY}`,
      }),
    );
    const appConfig = config({ zeroRetention: true, perRequestUsd: 0.012 });
    await initializeProviders({
      ...appConfig,
      credentials: { env: { SEARCHAPI_API_KEY: SYNTHETIC_KEY } },
      httpClient: asHttpClient(httpClient),
    });
    appConfig.providers.searchapi = {
      ...appConfig.providers.searchapi!,
      fallback: 'synthetic-fallback',
    };
    appConfig.providers['synthetic-fallback'] = {
      apiKey: 'synthetic-fallback-key',
      enabled: false,
    };
    const fallbackExecute = vi.fn(
      async (): Promise<ProviderResult> => ({
        provider: 'synthetic-fallback',
        tier: 'raw-search',
        content: 'must not run',
        citations: [],
        durationMs: 1,
      }),
    );
    const fallback: Provider = {
      id: 'synthetic-fallback',
      displayName: 'Synthetic fallback',
      tier: 'raw-search',
      execution: 'inline',
      envVar: 'SYNTHETIC_FALLBACK_KEY',
      execute: fallbackExecute,
    };
    const searchApi = getProvider('searchapi');
    if (!searchApi) throw new Error('SearchAPI provider was not initialized');

    const dispatched = await dispatch({
      config: appConfig,
      providerIds: ['searchapi'],
      query: 'structured error',
      mode: 'sync',
      credentials: { env: { SEARCHAPI_API_KEY: SYNTHETIC_KEY } },
      providerRegistry: {
        getProvider: (id) =>
          id === 'searchapi'
            ? searchApi
            : id === 'synthetic-fallback'
              ? fallback
              : undefined,
      },
    });
    const expectedError = `API returned 403: ${SEARCHAPI_ZERO_RETENTION_REMEDIATION}`;

    expect(dispatched.results).toEqual([
      expect.objectContaining({
        provider: 'searchapi',
        status: 'error',
        error: expectedError,
        preventFallback: true,
        metering: {
          kind: 'request_priced',
          estimate: {
            billableUnits: 1,
            unit: 'request',
            estimatedCostUsd: 0.012,
            costConfidence: 'configured',
            pricingVersion: '2026-08',
          },
          pricingVersion: '2026-08',
        },
      }),
    ]);
    expect(dispatched.reports).toEqual([
      expect.objectContaining({
        id: 'searchapi',
        status: 'error',
        error: expectedError,
        preventFallback: true,
      }),
    ]);
    expect(expectedError).not.toContain(SYNTHETIC_KEY);
    expect(httpClient).toHaveBeenCalledOnce();
    expect(fallbackExecute).not.toHaveBeenCalled();
  });

  it('does not attach retention remediation to auth failures, unrelated 403s, or unrequested privacy', async () => {
    const cases = [
      {
        zeroRetention: true,
        status: 401,
        data: {
          error: `Invalid API key ${SYNTHETIC_KEY}`,
          authorization: `Bearer ${SYNTHETIC_KEY}`,
        },
        expected: 'check that SEARCHAPI_API_KEY is set and valid',
      },
      {
        zeroRetention: true,
        status: 403,
        data: { error: 'Origin is not allowlisted' },
        expected: 'API key may lack required permissions',
      },
      {
        zeroRetention: false,
        status: 403,
        data: {
          error: 'zero_retention is only available on the Enterprise plan',
        },
        expected: 'API key may lack required permissions',
      },
    ];

    for (const fixture of cases) {
      const httpClient = vi.fn(async () =>
        response(fixture.status, fixture.data),
      );
      const result = await new SearchApiProvider({
        apiKey: SYNTHETIC_KEY,
        httpClient: asHttpClient(httpClient),
        zeroRetention: fixture.zeroRetention,
      }).execute('classification', { timeout: 3 });

      expect(result.error).toContain(fixture.expected);
      expect(result.error).not.toContain(SEARCHAPI_ZERO_RETENTION_REMEDIATION);
      expect(result.error).not.toContain(SYNTHETIC_KEY);
      expect(result.preventFallback).toBe(
        fixture.zeroRetention ? true : undefined,
      );
    }
  });

  it('redacts credential material from successful HTTP payload errors', async () => {
    const httpClient = vi.fn(async () =>
      response(200, {
        error: `payload diagnostic Bearer ${SYNTHETIC_KEY} https://www.searchapi.io/api/v1/search?api_key=${SYNTHETIC_KEY}`,
      }),
    );
    const result = await new SearchApiProvider({
      apiKey: SYNTHETIC_KEY,
      httpClient: asHttpClient(httpClient),
    }).execute('payload redaction', { timeout: 3 });

    expect(result.error).toContain('payload diagnostic');
    expect(result.error).not.toContain(SYNTHETIC_KEY);
    expect(result.error).toContain('Bearer [REDACTED]');
  });

  it('redacts credential material from thrown execute and health-check errors', async () => {
    const httpClient = vi.fn(async () => {
      throw new Error(
        `transport diagnostic Bearer ${SYNTHETIC_KEY} https://www.searchapi.io/api/v1/search?api_key=${SYNTHETIC_KEY}`,
      );
    });
    const provider = new SearchApiProvider({
      apiKey: SYNTHETIC_KEY,
      httpClient: asHttpClient(httpClient),
    });

    const result = await provider.execute('redaction', { timeout: 3 });
    const health = await provider.test();

    expect(result.error).toContain('transport diagnostic');
    expect(result.error).not.toContain(SYNTHETIC_KEY);
    expect(health.error).toContain('transport diagnostic');
    expect(health.error).not.toContain(SYNTHETIC_KEY);
  });

  it('uses a strict reusable schema and blocks invalid zeroRetention before HTTP', async () => {
    expect(searchApiOptionsSchema.parse({})).toEqual({ zeroRetention: false });
    expect(
      searchApiOptionsSchema.parse({
        zeroRetention: true,
        perRequestUsd: 0.004,
      }),
    ).toEqual({ zeroRetention: true, perRequestUsd: 0.004 });
    expect(
      searchApiOptionsSchema.safeParse({ zeroRetention: 'true' }).success,
    ).toBe(false);
    expect(searchApiOptionsSchema.safeParse({ unexpected: true }).success).toBe(
      false,
    );
    expect(getBuiltInProviderDescriptor('searchapi')?.optionsSchema).toBe(
      searchApiOptionsSchema,
    );

    const httpClient = vi.fn();
    const initialized = await initializeProviders({
      providers: {
        searchapi: { options: { zeroRetention: 'true' } },
      },
      credentials: { env: { SEARCHAPI_API_KEY: SYNTHETIC_KEY } },
      httpClient: asHttpClient(httpClient),
    });

    expect(initialized.warnings).toEqual([
      expect.stringContaining('Invalid options for searchapi'),
    ]);
    await expect(
      getProvider('searchapi')?.execute('must not run', { timeout: 3 }),
    ).resolves.toMatchObject({ error: 'Invalid options for searchapi' });
    await expect(getProvider('searchapi')?.test?.()).resolves.toEqual({
      ok: false,
      error: 'Invalid options for searchapi',
    });
    expect(httpClient).not.toHaveBeenCalled();
  });

  it('contains no SearchAPI source construction that interpolates a URL key', () => {
    const sources = ['src/adapters/searchapi.ts', 'src/core/searchapi.ts'].map(
      (file) => readFileSync(resolve(process.cwd(), file), 'utf8'),
    );

    for (const source of sources) {
      expect(source).not.toMatch(/[?&]api_key=\$\{/);
      expect(source).not.toMatch(/searchParams\.set\(\s*['"]api_key['"]\s*,/);
    }
  });

  it('rejects raw credential and privacy parameters at the shared helper boundary', () => {
    const input = {
      apiKey: SYNTHETIC_KEY,
      engine: 'google',
      timeout: 1000,
    };

    expect(() =>
      createSearchApiRequest({
        ...input,
        parameters: { api_key: SYNTHETIC_KEY },
      }),
    ).toThrow('credentials must use bearer authentication');
    expect(() =>
      createSearchApiRequest({
        ...input,
        parameters: { zero_retention: false },
      }),
    ).toThrow('must use the zeroRetention option');
  });
});

describe('SearchAPI Google evidence sections', () => {
  const sectionFixtures: Array<{
    name: string;
    heading: string;
    data: SearchApiGoogleResponse;
  }> = [
    {
      name: 'embedded AI Overview',
      heading: 'AI Overview',
      data: {
        ai_overview: {
          page_token: 'synthetic-overview-token',
          text_blocks: [
            { type: 'header', answer: 'Synthetic answer' },
            { type: 'paragraph', answer: 'Fixture-only overview content.' },
            {
              type: 'unordered_list',
              items: [{ type: 'paragraph', answer: 'Fixture detail.' }],
            },
          ],
          reference_links: [
            {
              title: 'Overview evidence',
              link: 'https://overview.example.test/evidence',
              snippet: 'Synthetic citation evidence.',
            },
          ],
        },
      },
    },
    {
      name: 'top stories',
      heading: 'Top Stories',
      data: {
        top_stories: [
          {
            title: 'Synthetic story',
            link: 'https://stories.example.test/article',
            source: 'Synthetic News',
            date: 'today',
          },
        ],
      },
    },
    {
      name: 'discussions and forums',
      heading: 'Discussions & Forums',
      data: {
        discussions_and_forums: [
          {
            title: 'Synthetic discussion',
            link: 'https://forums.example.test/thread',
            source: 'Synthetic Forum',
            date: 'today',
            posts: '12 posts',
          },
        ],
      },
    },
    {
      name: 'inline videos',
      heading: 'Inline Videos',
      data: {
        inline_videos: [
          {
            title: 'Synthetic video',
            link: 'https://videos.example.test/watch',
            source: 'Synthetic Video',
            channel: 'Fixture Channel',
            length: '2:00',
          },
        ],
      },
    },
    {
      name: 'Knowledge Graph sources',
      heading: 'Knowledge Graph Sources',
      data: {
        knowledge_graph: {
          source: {
            name: 'Synthetic Knowledge Source',
            link: 'https://knowledge.example.test/source',
          },
        },
      },
    },
  ];

  for (const fixture of sectionFixtures) {
    it(`renders ${fixture.name} independently with one ordinary Google request`, async () => {
      const httpClient = vi.fn(async () => response(200, fixture.data));
      const result = await new SearchApiProvider({
        apiKey: SYNTHETIC_KEY,
        httpClient: asHttpClient(httpClient),
      }).execute('synthetic section', { timeout: 3 });

      expect(result.content).toContain(`## ${fixture.heading}`);
      expect(result.citations).toHaveLength(1);
      expect(result.citations[0]).toMatchObject({ provider: 'searchapi' });
      expect(httpClient).toHaveBeenCalledOnce();

      const [rawUrl] = httpClient.mock.calls[0] as unknown as [string];
      const url = new URL(rawUrl);
      expect(url.searchParams.get('engine')).toBe('google');
      expect(url.searchParams.has('page_token')).toBe(false);
    });
  }

  it('appends all enriched sections after organic results in a stable order', async () => {
    const data: SearchApiGoogleResponse = {
      organic_results: [
        {
          title: 'Organic baseline',
          link: 'https://organic.example.test/result',
          snippet: 'Existing organic content.',
        },
      ],
      ...Object.assign({}, ...sectionFixtures.map((fixture) => fixture.data)),
    };
    const httpClient = vi.fn(async () => response(200, data));
    const result = await new SearchApiProvider({
      apiKey: SYNTHETIC_KEY,
      httpClient: asHttpClient(httpClient),
    }).execute('all sections', { timeout: 3 });

    expect(result.content).toMatch(
      /^### \[Organic baseline\]\(https:\/\/organic\.example\.test\/result\)\nExisting organic content\./,
    );
    const headings = [
      '## AI Overview',
      '## Top Stories',
      '## Discussions & Forums',
      '## Inline Videos',
      '## Knowledge Graph Sources',
    ];
    for (const [index, heading] of headings.entries()) {
      expect(result.content.indexOf(heading)).toBeGreaterThan(
        index === 0 ? 0 : result.content.indexOf(headings[index - 1]!),
      );
    }
    expect(result.citations).toHaveLength(6);
    expect(
      result.citations.every((citation) => citation.provider === 'searchapi'),
    ).toBe(true);
    expect(httpClient).toHaveBeenCalledOnce();
  });

  it('keeps the historic organic-only Markdown, citations, and empty response behavior', async () => {
    const httpClient = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          organic_results: [
            {
              title: 'First organic result',
              link: 'https://organic.example.test/first',
              snippet: 'First snippet.',
            },
            {
              title: 'Second organic result',
              link: 'https://organic.example.test/second',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(response(200, { organic_results: [] }));
    const provider = new SearchApiProvider({
      apiKey: SYNTHETIC_KEY,
      httpClient: asHttpClient(httpClient),
    });

    await expect(
      provider.execute('organic', { timeout: 3 }),
    ).resolves.toMatchObject({
      content:
        '### [First organic result](https://organic.example.test/first)\nFirst snippet.\n\n### [Second organic result](https://organic.example.test/second)\n',
      citations: [
        { url: 'https://organic.example.test/first', provider: 'searchapi' },
        { url: 'https://organic.example.test/second', provider: 'searchapi' },
      ],
    });
    await expect(
      provider.execute('empty', { timeout: 3 }),
    ).resolves.toMatchObject({
      content: 'No results found.',
      citations: [],
    });
  });

  it('drops malformed optional blocks without failing the organic response', async () => {
    const httpClient = vi.fn(async () =>
      response(200, {
        organic_results: [
          {
            title: 'Organic baseline',
            link: 'https://organic.example.test/result',
          },
        ],
        ai_overview: { markdown: 42, text_blocks: [null, 'not a block'] },
        top_stories: [null, { title: 'Missing link' }, 'not a result'],
        discussions_and_forums: 'not an array',
        inline_videos: [{ title: 'Data URL', link: 'data:text/plain,unsafe' }],
        knowledge_graph: {
          source: {
            name: 'Google navigation',
            link: 'https://www.google.com/search?q=fixture',
          },
        },
      }),
    );

    const result = await new SearchApiProvider({
      apiKey: SYNTHETIC_KEY,
      httpClient: asHttpClient(httpClient),
    }).execute('malformed optional sections', { timeout: 3 });

    expect(result.error).toBeUndefined();
    expect(result.content).toBe(
      '### [Organic baseline](https://organic.example.test/result)\n',
    );
    expect(result.citations).toEqual([
      {
        url: 'https://organic.example.test/result',
        title: 'Organic baseline',
        snippet: undefined,
        provider: 'searchapi',
      },
    ]);
  });

  it('keeps only valid external evidence citations and deduplicates across sections', async () => {
    const httpClient = vi.fn(async () =>
      response(200, {
        organic_results: [
          {
            title: 'Primary source',
            link: 'https://evidence.example.test/primary',
          },
          {
            title: 'Duplicate source',
            link: 'https://evidence.example.test/primary',
          },
        ],
        ai_overview: {
          markdown: 'Synthetic overview.',
          reference_links: [
            {
              title: 'Duplicate overview source',
              link: 'https://evidence.example.test/primary',
            },
            {
              title: 'Valid overview source',
              link: 'http://evidence.example.test/overview',
            },
            {
              title: 'Provider history',
              link: 'https://www.searchapi.io/api/v1/searches/synthetic',
            },
            { title: 'Data image', link: 'data:image/png;base64,synthetic' },
            { title: 'Malformed', link: 'not a url' },
          ],
        },
        top_stories: [
          {
            title: 'Google navigation',
            link: 'https://www.google.com/search?q=fixture',
          },
          { title: 'Valid story', link: 'https://evidence.example.test/story' },
        ],
        discussions_and_forums: [
          {
            title: 'Google Maps navigation',
            link: 'https://maps.google.com/?q=fixture',
          },
        ],
        inline_videos: [
          {
            title: 'Malformed protocol',
            link: 'ftp://evidence.example.test/video',
          },
        ],
        knowledge_graph: {
          sources: [
            {
              name: 'Duplicate Knowledge source',
              link: 'https://evidence.example.test/story',
            },
            {
              name: 'Valid Knowledge source',
              link: 'https://evidence.example.test/knowledge',
            },
          ],
        },
      }),
    );

    const result = await new SearchApiProvider({
      apiKey: SYNTHETIC_KEY,
      httpClient: asHttpClient(httpClient),
    }).execute('citation filtering', { timeout: 3 });

    expect(result.citations.map((citation) => citation.url)).toEqual([
      'https://evidence.example.test/primary',
      'http://evidence.example.test/overview',
      'https://evidence.example.test/story',
      'https://evidence.example.test/knowledge',
    ]);
    expect(
      result.citations.every((citation) => citation.provider === 'searchapi'),
    ).toBe(true);
  });
});
