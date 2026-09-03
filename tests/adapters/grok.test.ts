import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  GrokCombinedProvider,
  GrokProvider,
  GrokXOnlyProvider,
} from '../../src/adapters/grok.js';
import {
  buildGrokRequestBody,
  classifyGrokSourceKind,
  DEFAULT_GROK_MODEL,
  validateGrokOptions,
} from '../../src/adapters/grok-responses.js';

vi.mock('../../src/constants.js', async (importOriginal) => {
  const original =
    (await importOriginal()) as typeof import('../../src/constants.js');
  return { ...original, MAX_RETRIES: 0 };
});

function jsonResponse(status: number, data: unknown): Response {
  return {
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    headers: new Headers({}),
    text: async () => JSON.stringify(data),
  } as Response;
}

function provider(model?: string): GrokProvider {
  return new GrokProvider({
    ...(model ? { model } : {}),
    credentials: { env: { XAI_API_KEY: 'xai-test-key' } },
  });
}

function outputResponse(text = 'Grounded answer.'): Record<string, unknown> {
  return {
    model: 'grok-4.6',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  };
}

describe('GrokProvider', () => {
  const originalFetch = globalThis.fetch;

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats a null error field on a successful response as success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'grok-4.6',
        error: null,
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Grounded answer.',
                annotations: [],
              },
            ],
          },
        ],
      }),
    );

    const result = await provider().execute('ground this', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.content).toBe('Grounded answer.');
  });

  it('preserves inline citations and normalizes deduplicated URL annotations', async () => {
    const answer =
      'The official report confirms the result [[1]](https://source.example/a). Another source adds context [[2]](https://source.example/b).';
    const firstMarker = answer.indexOf('[[1]]');
    const secondMarker = answer.indexOf('[[2]]');
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'grok-4.6',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: answer,
                annotations: [
                  {
                    type: 'url_citation',
                    url: 'https://source.example/a',
                    start_index: firstMarker,
                    end_index: firstMarker + 5,
                    title: '1',
                  },
                  {
                    type: 'url_citation',
                    url: 'https://source.example/a',
                    start_index: firstMarker,
                    end_index: firstMarker + 5,
                    title: '3',
                  },
                  {
                    type: 'url_citation',
                    url: 'https://source.example/b',
                    start_index: secondMarker,
                    end_index: secondMarker + 5,
                    title: '2',
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    const result = await provider().execute('ground this', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.content).toBe(answer);
    expect(result.citations).toEqual([
      {
        url: 'https://source.example/a',
        title: 'The official report confirms the result',
        provider: 'grok',
      },
      {
        url: 'https://source.example/b',
        title: 'Another source adds context',
        provider: 'grok',
      },
    ]);
    expect(result.citations.some((citation) => citation.title === '1')).toBe(
      false,
    );
  });

  it('returns annotation-less output without treating it as an error', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, outputResponse()));

    const result = await provider().execute('ground this', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.content).toBe('Grounded answer.');
    expect(result.citations).toEqual([]);
  });

  it('extracts honest token usage and preserves server-side tool usage raw', async () => {
    const usage = {
      input_tokens: 120,
      output_tokens: 45,
      total_tokens: 165,
      reasoning_tokens: 20,
      cached_tokens: 10,
    };
    const serverSideToolUsage = {
      WEB_SEARCH: { successful_calls: 2 },
    };
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ...outputResponse(),
        usage,
        server_side_tool_usage: serverSideToolUsage,
      }),
    );

    const result = await provider().execute('ground this', { timeout: 10 });

    expect(result.tokenUsage).toEqual({ input: 120, output: 45 });
    expect(result.usage?.inputTokens).toBe(120);
    expect(result.usage?.outputTokens).toBe(45);
    expect(result.usage?.totalTokens).toBe(165);
    expect(result.usage?.raw).toMatchObject({
      strategy: 'web',
      usage,
      server_side_tool_usage: serverSideToolUsage,
    });
    expect(result.usage?.costUsd).toBeUndefined();
  });

  it('converts reported cost_in_usd_ticks into a reported costUsd', async () => {
    // Live-captured shape: xAI nests per-tool call counts and an actual cost
    // (in 10^-10 USD ticks) inside the usage object.
    const usage = {
      input_tokens: 9896,
      output_tokens: 619,
      total_tokens: 10515,
      cost_in_usd_ticks: 300244000,
      server_side_tool_usage_details: {
        web_search_calls: 2,
        x_search_calls: 0,
      },
    };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ...outputResponse(), usage }));

    const result = await provider().execute('ground this', { timeout: 10 });

    expect(result.usage?.costUsd).toBeCloseTo(0.0300244, 10);
    expect(result.usage?.raw).toMatchObject({ strategy: 'web', usage });
  });

  it('sends the exact shipping model and only the Responses API web_search tool', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, outputResponse()));
    globalThis.fetch = fetchMock;

    await provider().execute('ground this', { timeout: 12 });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(url).toBe('https://api.x.ai/v1/responses');
    expect((options.headers as Record<string, string>).Authorization).toBe(
      'Bearer xai-test-key',
    );
    expect(body).toEqual({
      model: 'grok-4.6',
      input: [{ role: 'user', content: 'ground this' }],
      tools: [{ type: 'web_search' }],
    });
    expect(JSON.stringify(body)).not.toContain('x_search');
  });

  it.each([
    [400, { error: 'Malformed request' }, 'Malformed request'],
    [401, { error: { message: 'Unauthorized' } }, 'XAI_API_KEY'],
    [403, { message: 'Forbidden' }, 'team admin'],
    [429, { error: { message: 'Rate limited' } }, 'xAI Console rate limits'],
  ])('normalizes %i API errors', async (status, data, hint) => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(status, data));

    const result = await provider().execute('ground this', { timeout: 10 });

    expect(result.content).toBe('');
    expect(result.citations).toEqual([]);
    expect(result.error).toContain(`API returned ${status}`);
    expect(result.error).toContain(hint);
    expect(result.failureDiagnostic).toEqual({
      kind:
        status === 401
          ? 'authentication'
          : status === 403
            ? 'authentication'
            : status === 429
              ? 'rate_limit'
              : 'invalid_request',
      httpStatus: status,
    });
  });

  it('normalizes network failures without throwing', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'));

    const result = await provider().execute('ground this', { timeout: 10 });

    expect(result.error).toContain('Network error connecting to Grok (xAI)');
    expect(result.failureDiagnostic).toEqual({ kind: 'network' });
  });

  it('wires the timeout and caller abort signal through the HTTP client', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, outputResponse()));
    globalThis.fetch = fetchMock;

    await provider().execute('ground this', {
      timeout: 12,
      signal: controller.signal,
    });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 12000);
    expect(options.signal).toBeDefined();
  });

  it('uses grok-4.3 when configured as a model override', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, outputResponse()));
    globalThis.fetch = fetchMock;

    const result = await provider('grok-4.3').execute('ground this', {
      timeout: 10,
    });

    expect(result.model).toBe('grok-4.6');
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(options.body as string).model).toBe('grok-4.3');
  });

  it('handles a successful response with no output text gracefully', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));

    const result = await provider().execute('ground this', { timeout: 10 });

    expect(result.error).toBe('Grok response did not include output text');
  });

  it('uses the authenticated models endpoint for its health check', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
    globalThis.fetch = fetchMock;

    await expect(provider().test()).resolves.toEqual({ ok: true });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.x.ai/v1/models');
    expect(options.method).toBe('GET');
    expect((options.headers as Record<string, string>).Authorization).toBe(
      'Bearer xai-test-key',
    );
  });
});

describe('GrokProvider — live-verified edge cases', () => {
  const originalFetch = globalThis.fetch;

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds the API key hint to a 400 bad-key response (xAI reports bad keys as 400, not 401)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, {
        error: { message: 'Incorrect API key provided.' },
      }),
    );

    const result = await provider().execute('q', { timeout: 10 });

    expect(result.error).toContain('400');
    expect(result.error).toContain('XAI_API_KEY');
    expect(result.failureDiagnostic).toEqual({
      kind: 'authentication',
      httpStatus: 400,
    });
  });

  // NaN cannot appear on the JSON wire (it serializes to null), so null is
  // the realistic degenerate value alongside a negative number.
  it.each([[-1], [null]])(
    'omits costUsd when cost_in_usd_ticks is %s',
    async (ticks) => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(
        jsonResponse(200, {
          ...outputResponse(),
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cost_in_usd_ticks: ticks,
          },
        }),
      );

      const result = await provider().execute('q', { timeout: 10 });

      expect(result.error).toBeUndefined();
      expect(result.usage?.costUsd).toBeUndefined();
    },
  );

  it('drops url_citation annotations that lack a url', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'grok-4.6',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Answer.',
                annotations: [
                  {
                    type: 'url_citation',
                    start_index: 0,
                    end_index: 5,
                    title: '1',
                  },
                  {
                    type: 'url_citation',
                    url: 'https://example.com/ok',
                    start_index: 0,
                    end_index: 5,
                    title: '2',
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    const result = await provider().execute('q', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.url).toBe('https://example.com/ok');
  });
});

describe('Grok search strategies', () => {
  const originalFetch = globalThis.fetch;

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('binds every shipping adapter to the exact grok-4.6 default', () => {
    const credentials = { env: { XAI_API_KEY: 'xai-test-key' } };
    expect(DEFAULT_GROK_MODEL).toBe('grok-4.6');
    expect([
      new GrokProvider({ credentials }).model,
      new GrokXOnlyProvider({ credentials }).model,
      new GrokCombinedProvider({ credentials }).model,
    ]).toEqual(['grok-4.6', 'grok-4.6', 'grok-4.6']);
  });

  it('classifies citation source kinds from URL identity only', () => {
    expect(classifyGrokSourceKind('https://x.com/xai/status/123')).toBe(
      'x_post',
    );
    expect(classifyGrokSourceKind('https://twitter.com/i/status/99')).toBe(
      'x_post',
    );
    expect(classifyGrokSourceKind('https://example.com/report')).toBe(
      'web_page',
    );
    expect(classifyGrokSourceKind('https://x.com/xai')).toBe('unknown');
    expect(classifyGrokSourceKind('not-a-url')).toBe('unknown');
  });

  it('validates handle maximums and mutual exclusions before launch', () => {
    expect(() =>
      validateGrokOptions('x', {
        allowedXHandles: Array.from({ length: 21 }, (_, i) => `user${i}`),
      }),
    ).toThrow(/at most 20/);
    expect(() =>
      validateGrokOptions('x', {
        allowedXHandles: ['elonmusk'],
        excludedXHandles: ['xai'],
      }),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      validateGrokOptions('web', {
        allowedDomains: ['x.ai'],
        excludedDomains: ['example.com'],
      }),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      validateGrokOptions('web', {
        allowedDomains: Array.from({ length: 6 }, (_, i) => `site${i}.test`),
      }),
    ).toThrow(/at most 5/);
    expect(() =>
      validateGrokOptions('web', { allowedXHandles: ['elonmusk'] }),
    ).toThrow(/not supported by the web/);
    expect(() => validateGrokOptions('x', { undocumented: true })).toThrow(
      /Unknown Grok option: undocumented/,
    );
    expect(() => validateGrokOptions('x', { enableImageSearch: true })).toThrow(
      /not supported by the x/,
    );
    expect(() =>
      validateGrokOptions('web', { enableVideoUnderstanding: true }),
    ).toThrow(/not supported by the web/);
    expect(() => validateGrokOptions('x', { maxTurns: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => validateGrokOptions('x', { perRequestUsd: 0 })).toThrow(
      /positive number/,
    );
    expect(() =>
      validateGrokOptions('x', {
        fromDate: '2025-10-10',
        toDate: '2025-10-01',
      }),
    ).toThrow(/fromDate must be on or before toDate/);
    expect(() => validateGrokOptions('x', { fromDate: '2025-02-29' })).toThrow(
      /ISO8601 date/,
    );
    expect(() =>
      validateGrokOptions('web', { allowedDomains: ['https://x.ai/path'] }),
    ).toThrow(/valid hostname/);
    expect(
      validateGrokOptions('x', {
        allowedXHandles: ['@ElonMusk'],
        fromDate: '2025-10-01',
        toDate: '2025-10-10',
      }),
    ).toEqual(
      expect.objectContaining({
        allowedXHandles: ['ElonMusk'],
        fromDate: '2025-10-01',
        toDate: '2025-10-10',
      }),
    );
  });

  it('builds X-only and combined tool arrays from immutable strategies', () => {
    expect(
      buildGrokRequestBody('grok-4.6', 'q', 'x', {
        allowedXHandles: ['elonmusk'],
        maxTurns: 3,
      }),
    ).toEqual({
      model: 'grok-4.6',
      input: [{ role: 'user', content: 'q' }],
      tools: [{ type: 'x_search', allowed_x_handles: ['elonmusk'] }],
      max_turns: 3,
    });

    expect(
      buildGrokRequestBody('grok-4.6', 'q', 'combined', {
        allowedDomains: ['x.ai'],
        enableImageUnderstanding: true,
        enableVideoUnderstanding: true,
        maxOutputTokens: 2048,
      }),
    ).toEqual({
      model: 'grok-4.6',
      input: [{ role: 'user', content: 'q' }],
      tools: [
        {
          type: 'web_search',
          filters: { allowed_domains: ['x.ai'] },
          enable_image_understanding: true,
        },
        {
          type: 'x_search',
          enable_image_understanding: true,
          enable_video_understanding: true,
        },
      ],
      max_output_tokens: 2048,
    });
  });

  it('sends only x_search for the X-only adapter', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, outputResponse()));
    globalThis.fetch = fetchMock;

    const adapter = new GrokXOnlyProvider({
      credentials: { env: { XAI_API_KEY: 'xai-test-key' } },
      searchOptions: { allowedXHandles: ['xai'] },
    });
    const result = await adapter.execute('x only', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.provider).toBe('grok-x-only');
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.tools).toEqual([
      { type: 'x_search', allowed_x_handles: ['xai'] },
    ]);
    expect(JSON.stringify(body.tools)).not.toContain('web_search');
  });

  it('sends both tools once for the combined adapter', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, outputResponse()));
    globalThis.fetch = fetchMock;

    const adapter = new GrokCombinedProvider({
      credentials: { env: { XAI_API_KEY: 'xai-test-key' } },
    });
    const result = await adapter.execute('combined', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.provider).toBe('grok-combined');
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.tools).toEqual([{ type: 'web_search' }, { type: 'x_search' }]);
  });

  it('rejects invalid search options at construction time', () => {
    expect(
      () =>
        new GrokProvider({
          searchOptions: { allowedXHandles: ['xai'] },
        }),
    ).toThrow(/not supported by the web/);
  });
});
