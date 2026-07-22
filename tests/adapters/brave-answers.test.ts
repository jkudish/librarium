import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { BraveAnswersProvider } from '../../src/adapters/brave-answers.js';

function sseResponse(
  chunks: string[],
  headers: Record<string, string> = {},
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function streamEvent(content: string, model = 'brave'): string {
  return `data: ${JSON.stringify({
    model,
    choices: [{ delta: { content } }],
  })}\n\n`;
}

function provider(): BraveAnswersProvider {
  return new BraveAnswersProvider({
    credentials: { env: { BRAVE_API_KEY: 'mock-brave-key' } },
  });
}

describe('Brave Answers provider', () => {
  const originalFetch = globalThis.fetch;

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('assembles streamed answers, strips inline metadata, and extracts citations and usage headers', async () => {
    const citation = JSON.stringify({
      start_index: 8,
      end_index: 18,
      number: 1,
      url: 'https://example.com/source',
      title: 'Source title',
      snippet: 'Source excerpt',
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(
      sseResponse(
        [
          streamEvent(`Finding <citation>${citation.slice(0, 42)}`),
          streamEvent(
            `${citation.slice(42)}</citation> confirmed. <enum_item>{"name":"Entity"}</enum_item>`,
          ),
          'data: [DONE]\n\n',
        ],
        {
          'x-request-requests': '1',
          'x-request-queries': '2',
          'x-request-tokens-in': '12',
          'x-request-tokens-out': '34',
          'x-request-cost-breakdown': '{"total_usd":0.00023}',
        },
      ),
    );
    globalThis.fetch = fetchMock;

    const result = await provider().execute('what is confirmed?', {
      timeout: 10,
    });

    expect(result.error).toBeUndefined();
    expect(result.content).toBe('Finding  confirmed.');
    expect(result.citations).toEqual([
      {
        url: 'https://example.com/source',
        title: 'Source title',
        snippet: 'Source excerpt',
        provider: 'brave-answers',
      },
    ]);
    expect(result.model).toBe('brave');
    expect(result.tokenUsage).toEqual({ input: 12, output: 34 });
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      totalTokens: 46,
      costUsd: 0.00023,
      raw: {
        requestQueries: 2,
        requestRequests: 1,
        requestTokensIn: 12,
        requestTokensOut: 34,
        requestCostBreakdown: '{"total_usd":0.00023}',
      },
    });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.search.brave.com/res/v1/chat/completions');
    expect(JSON.parse(options.body as string)).toEqual({
      model: 'brave',
      messages: [{ role: 'user', content: 'what is confirmed?' }],
      stream: true,
      web_search_options: { enable_citations: true },
    });
  });

  it('preserves a citation tag split across response chunks', async () => {
    const event = streamEvent(
      'A <citation>{"url":"https://example.com/chunk","snippet":"Chunked"}</citation> answer.',
    );
    const splitAt = event.indexOf('"snippet"');
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([
          event.slice(0, splitAt),
          event.slice(splitAt),
          'data: [DONE]\n\n',
        ]),
      );

    const result = await provider().execute('chunked citation', {
      timeout: 10,
    });

    expect(result.error).toBeUndefined();
    expect(result.content).toBe('A  answer.');
    expect(result.citations).toEqual([
      {
        url: 'https://example.com/chunk',
        snippet: 'Chunked',
        provider: 'brave-answers',
      },
    ]);
  });

  it('returns an empty successful result when the stream has no citations', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([streamEvent('Plain answer.'), 'data: [DONE]\n\n']),
      );

    const result = await provider().execute('no sources', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.content).toBe('Plain answer.');
    expect(result.citations).toEqual([]);
    expect(result.usage).toBeUndefined();
  });

  it('normalizes 401 errors from the nested Brave error envelope', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      errorResponse(401, {
        error: { code: 'SUBSCRIPTION_TOKEN_INVALID', detail: 'Token rejected' },
      }),
    );

    const result = await provider().execute('auth failure', { timeout: 10 });

    expect(result.error).toContain('401');
    expect(result.error).toContain('Token rejected');
    expect(result.error).toContain('Answers plan');
  });

  it('normalizes 402 errors from the top-level Brave error envelope', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      errorResponse(402, {
        type: 'payment_required',
        error: 'Billing needed',
      }),
    );

    const result = await provider().execute('billing failure', { timeout: 10 });

    expect(result.error).toContain('402');
    expect(result.error).toContain('payment_required');
    expect(result.error).toContain('Payment Required');
  });

  it('does not truncate a long query and normalizes a 422 validation rejection', async () => {
    const longQuery = 'q'.repeat(20_000);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        errorResponse(422, { error: { code: 'VALIDATION' } }),
      );
    globalThis.fetch = fetchMock;

    const result = await provider().execute(longQuery, { timeout: 10 });

    expect(
      JSON.parse(fetchMock.mock.calls[0][1].body as string).messages[0],
    ).toEqual({ role: 'user', content: longQuery });
    expect(result.error).toContain('422');
    expect(result.error).toContain('VALIDATION');
    expect(result.error).toContain('shorter query');
  });

  it('normalizes 429 errors from the top-level Brave error envelope', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      errorResponse(429, {
        type: 'rate_limit_exceeded',
        error: 'Too many requests',
      }),
    );

    const result = await provider().execute('rate limited', { timeout: 10 });

    expect(result.error).toContain('429');
    expect(result.error).toContain('rate_limit_exceeded');
    expect(result.error).toContain('rate limit');
  });

  it('returns a normalized result for network errors', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'));

    const result = await provider().execute('offline', { timeout: 10 });

    expect(result.content).toBe('');
    expect(result.citations).toEqual([]);
    expect(result.error).toContain(
      'Network error connecting to Brave AI Answers',
    );
  });

  it('health-checks the streamed Answers capability', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([streamEvent('pong'), 'data: [DONE]\n\n']),
      );
    globalThis.fetch = fetchMock;

    await expect(provider().test()).resolves.toEqual({ ok: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject(
      {
        model: 'brave',
        stream: true,
        web_search_options: { enable_citations: true },
      },
    );
  });
});

describe('Brave Answers provider — stream robustness', () => {
  const originalFetch = globalThis.fetch;

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles a literal closing tag inside citation JSON strings without corrupting content', async () => {
    const citation = JSON.stringify({
      url: 'https://example.com/tricky',
      title: 'Tricky title',
      snippet: 'web text with a literal </citation> inside the snippet',
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([
          streamEvent(`Before <citation>${citation}</citation> after.`),
          'data: [DONE]\n\n',
        ]),
      );

    const result = await provider().execute('q', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.content).toBe('Before  after.');
    expect(result.citations).toEqual([
      {
        url: 'https://example.com/tricky',
        title: 'Tricky title',
        snippet: 'web text with a literal </citation> inside the snippet',
        provider: 'brave-answers',
      },
    ]);
  });

  it('survives a payload with many embedded closing tags inside a JSON string', async () => {
    const citation = JSON.stringify({
      url: 'https://example.com/many',
      snippet: `${'</citation> '.repeat(40)}end`,
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([
          streamEvent(`Start <citation>${citation}</citation> end.`),
          'data: [DONE]\n\n',
        ]),
      );

    const result = await provider().execute('q', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.content).toBe('Start  end.');
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.url).toBe('https://example.com/many');
  });

  it('drops an unclosed citation tag tail instead of leaking payload into content', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([
          streamEvent(
            'Answer text. <citation>{"url":"https://example.com/x","snippet":"trunca',
          ),
          'data: [DONE]\n\n',
        ]),
      );

    const result = await provider().execute('q', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.content).toBe('Answer text.');
    expect(result.citations).toEqual([]);
  });

  it('skips a malformed stream frame without discarding the rest of the answer', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([
          streamEvent('First part. '),
          'data: {broken json\n\n',
          streamEvent('Second part.'),
          'data: [DONE]\n\n',
        ]),
      );

    const result = await provider().execute('q', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.content).toBe('First part. Second part.');
  });

  it('fails with a normalized error when the stream exceeds the response size cap', async () => {
    const oversized = `data: ${'x'.repeat(10 * 1024 * 1024 + 64)}`;
    globalThis.fetch = vi.fn().mockResolvedValueOnce(sseResponse([oversized]));

    const result = await provider().execute('q', { timeout: 10 });

    expect(result.error).toMatch(/exceeds/i);
    expect(result.content).toBe('');
  });

  it('returns a normalized error instead of throwing when aborted mid-stream', async () => {
    const encoder = new TextEncoder();
    const abortController = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(streamEvent('Partial answer. ')));
        // Never close: the stream hangs until the caller aborts.
        setTimeout(() => abortController.abort(), 20);
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    const result = await provider().execute('q', {
      timeout: 10,
      signal: abortController.signal,
    });

    expect(result.error).toMatch(/abort/i);
    expect(result.content).toBe('');
  });
});
