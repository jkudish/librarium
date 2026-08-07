import { describe, expect, it, vi } from 'vitest';
import { PerplexityProSearchProvider } from '../../src/adapters/perplexity-pro-search.js';
import { PerplexitySonarProProvider } from '../../src/adapters/perplexity-sonar-pro.js';
import type {
  HttpClient,
  HttpStreamClient,
} from '../../src/core/http-client.js';
import {
  completeProSearchEvents,
  event,
  PRO_SEARCH_CONTENT,
  PRO_SEARCH_USAGE,
  splitEveryByte,
  streamFromStrings,
  streamResponse,
} from '../fixtures/perplexity-pro-search.js';

function provider(httpStreamClient: HttpStreamClient) {
  return new PerplexityProSearchProvider({
    apiKey: 'pplx-synthetic-key',
    httpStreamClient,
  });
}

describe('Perplexity Pro Search provider', () => {
  it('forces Pro Search and assembles split content plus terminal metadata once', async () => {
    const httpStreamClient = vi.fn(async () =>
      streamResponse(splitEveryByte()),
    );

    const result = await provider(httpStreamClient).execute(
      'compare synthetic evidence',
      { timeout: 7 },
    );

    expect(httpStreamClient).toHaveBeenCalledOnce();
    const [url, options] = httpStreamClient.mock.calls[0]!;
    expect(url).toBe('https://api.perplexity.ai/v1/sonar');
    expect(options).toMatchObject({
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        Authorization: 'Bearer pplx-synthetic-key',
      },
      body: {
        model: 'sonar-pro',
        messages: [{ role: 'user', content: 'compare synthetic evidence' }],
        stream: true,
        stream_mode: 'concise',
        web_search_options: { search_type: 'pro' },
      },
      timeout: 7000,
      retry: { mode: 'never' },
    });
    expect(result).toMatchObject({
      provider: 'perplexity-pro-search',
      tier: 'ai-grounded',
      content: PRO_SEARCH_CONTENT,
      model: 'sonar-pro',
      tokenUsage: { input: 11, output: 7 },
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        costUsd: 0.014138,
        raw: PRO_SEARCH_USAGE,
      },
    });
    expect(result.citations).toEqual([
      {
        title: 'Primary source',
        url: 'https://example.test/primary',
        snippet: 'Synthetic primary evidence.',
        provider: 'perplexity-pro-search',
      },
      {
        url: 'https://example.test/citation-only',
        provider: 'perplexity-pro-search',
      },
    ]);
    expect(result.usage?.raw).not.toHaveProperty('search_results');
    expect(result.metering).toBeUndefined();
  });

  it('rejects a successful JSON response because Pro Search must stream', async () => {
    const httpStreamClient = vi.fn(async () =>
      streamResponse(streamFromStrings(['{"choices":[]}']), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await provider(httpStreamClient).execute('not streaming', {
      timeout: 5,
    });

    expect(result.error).toContain('non-streaming response');
    expect(result.content).toBe('');
    expect(httpStreamClient).toHaveBeenCalledOnce();
  });

  it('rejects fast-classified and model-downgraded streams', async () => {
    const fastEvents = completeProSearchEvents();
    fastEvents[4] = fastEvents[4]!.replace(
      '"search_type":"pro"',
      '"search_type":"fast"',
    );
    const fast = await provider(async () =>
      streamResponse(streamFromStrings(fastEvents)),
    ).execute('forced pro', { timeout: 5 });
    expect(fast.error).toContain('downgraded to fast');

    const wrongModelEvents = completeProSearchEvents().map((frame) =>
      frame.replaceAll('"model":"sonar-pro"', '"model":"sonar"'),
    );
    const wrongModel = await provider(async () =>
      streamResponse(streamFromStrings(wrongModelEvents)),
    ).execute('forced model', { timeout: 5 });
    expect(wrongModel.error).toContain('unexpected model: sonar');
  });

  it('rejects streams without Pro reasoning or a terminal completion', async () => {
    const noReasoning = completeProSearchEvents().slice(2);
    const fastLike = await provider(async () =>
      streamResponse(streamFromStrings(noReasoning)),
    ).execute('fast-like stream', { timeout: 5 });
    expect(fastLike.error).toContain('did not prove Pro reasoning');

    const incomplete = completeProSearchEvents().slice(0, 4);
    const truncated = await provider(async () =>
      streamResponse(streamFromStrings(incomplete)),
    ).execute('truncated stream', { timeout: 5 });
    expect(truncated.error).toContain('ended before completion');
  });

  it('rejects malformed frames and malformed terminal metadata', async () => {
    const malformedFrame = [
      ...completeProSearchEvents().slice(0, 2),
      'data: {not-json}\n\n',
    ];
    const malformed = await provider(async () =>
      streamResponse(streamFromStrings(malformedFrame)),
    ).execute('malformed frame', { timeout: 5 });
    expect(malformed.error).toContain('malformed stream data');

    const missingUsage = completeProSearchEvents();
    missingUsage[4] = missingUsage[4]!.replace(
      `,"usage":${JSON.stringify(PRO_SEARCH_USAGE)}`,
      '',
    );
    const noUsage = await provider(async () =>
      streamResponse(streamFromStrings(missingUsage)),
    ).execute('missing usage', { timeout: 5 });
    expect(noUsage.error).toContain('terminal usage was missing');

    const mismatchedContent = completeProSearchEvents();
    mismatchedContent[4] = mismatchedContent[4]!.replace(
      JSON.stringify(PRO_SEARCH_CONTENT),
      JSON.stringify('different terminal content'),
    );
    const inconsistent = await provider(async () =>
      streamResponse(streamFromStrings(mismatchedContent)),
    ).execute('mismatched content', { timeout: 5 });
    expect(inconsistent.error).toContain(
      'terminal content did not match streamed content',
    );
  });

  it('surfaces provider error events without accepting partial content', async () => {
    const frames = [
      ...completeProSearchEvents().slice(0, 3),
      event({ error: { message: 'synthetic provider failure' } }, 'error'),
    ];
    const httpStreamClient = vi.fn(async () =>
      streamResponse(streamFromStrings(frames)),
    );

    const result = await provider(httpStreamClient).execute('provider error', {
      timeout: 5,
    });

    expect(result.error).toContain('synthetic provider failure');
    expect(result.content).toBe('');
    expect(result.citations).toEqual([]);
    expect(httpStreamClient).toHaveBeenCalledOnce();
  });

  it('returns an HTTP error after exactly one outbound attempt', async () => {
    const httpStreamClient = vi.fn(async () =>
      streamResponse(streamFromStrings(['{"error":"unavailable"}']), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await provider(httpStreamClient).execute('one attempt', {
      timeout: 5,
    });

    expect(result.error).toContain('API returned 503');
    expect(httpStreamClient).toHaveBeenCalledOnce();
  });

  it('redacts credentials echoed by HTTP and stream errors', async () => {
    const secret = 'pplx-sensitive-test-key';
    const http = await new PerplexityProSearchProvider({
      apiKey: secret,
      httpStreamClient: async () =>
        streamResponse(
          streamFromStrings([
            JSON.stringify({ error: `Bearer ${secret}`, api_key: secret }),
          ]),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    }).execute('redact HTTP', { timeout: 5 });
    expect(http.error).not.toContain(secret);
    expect(http.error).toContain('[REDACTED]');

    const stream = await new PerplexityProSearchProvider({
      apiKey: secret,
      httpStreamClient: async () =>
        streamResponse(
          streamFromStrings([
            event({ error: { message: `Bearer ${secret}` } }, 'error'),
          ]),
        ),
    }).execute('redact stream', { timeout: 5 });
    expect(stream.error).not.toContain(secret);
    expect(stream.error).toContain('[REDACTED]');
  });

  it('fails closed when the stream never proves Pro search type', async () => {
    const events = completeProSearchEvents().map((frame) =>
      frame
        .replace(',"metadata":{"search_type":"pro"}', '')
        .replace(',"search_type":"pro"', ''),
    );
    const result = await provider(async () =>
      streamResponse(streamFromStrings(events)),
    ).execute('missing Pro marker', { timeout: 5 });

    expect(result.error).toContain('did not prove Pro search type');
    expect(result.content).toBe('');
  });

  it('leaves the standard perplexity-sonar-pro request contract unchanged', async () => {
    const httpClient: HttpClient = vi.fn(async <T>(_url, _options) => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      durationMs: 1,
      data: {
        id: 'standard-sonar',
        model: 'sonar-pro',
        choices: [
          { message: { role: 'assistant', content: 'Standard Sonar Pro' } },
        ],
        citations: ['https://example.test/standard'],
      } as T,
    }));
    const standard = new PerplexitySonarProProvider({
      apiKey: 'pplx-standard-key',
      httpClient,
    });

    const result = await standard.execute('ordinary sonar', { timeout: 4 });

    expect(result.content).toBe('Standard Sonar Pro');
    expect(httpClient).toHaveBeenCalledWith(
      'https://api.perplexity.ai/chat/completions',
      expect.objectContaining({
        method: 'POST',
        body: {
          model: 'sonar-pro',
          messages: [{ role: 'user', content: 'ordinary sonar' }],
        },
      }),
    );
    const request = vi.mocked(httpClient).mock.calls[0]?.[1];
    expect(request?.body).not.toHaveProperty('stream');
    expect(request?.body).not.toHaveProperty('web_search_options');
  });
});
