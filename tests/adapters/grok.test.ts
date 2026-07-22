import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { GrokProvider } from '../../src/adapters/grok.js';

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
    model: 'grok-4.5',
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
        model: 'grok-4.5',
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
        model: 'grok-4.5',
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
    expect(result.usage).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      totalTokens: 165,
      raw: {
        usage,
        server_side_tool_usage: serverSideToolUsage,
      },
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
    expect(result.usage?.raw).toEqual({ usage });
  });

  it('sends only the Responses API web_search tool with authorization', async () => {
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
      model: 'grok-4.5',
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
  });

  it('normalizes network failures without throwing', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'));

    const result = await provider().execute('ground this', { timeout: 10 });

    expect(result.error).toContain('Network error connecting to Grok (xAI)');
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

    expect(result.model).toBe('grok-4.5');
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
  });

  it.each([[-1], [Number.NaN]])(
    'omits costUsd when cost_in_usd_ticks is %s',
    async (ticks) => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(
        jsonResponse(200, {
          ...outputResponse(),
          usage: { input_tokens: 10, output_tokens: 5, cost_in_usd_ticks: ticks },
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
        model: 'grok-4.5',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Answer.',
                annotations: [
                  { type: 'url_citation', start_index: 0, end_index: 5, title: '1' },
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
