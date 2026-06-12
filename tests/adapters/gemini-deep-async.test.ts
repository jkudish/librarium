import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiDeepProvider } from '../../src/adapters/gemini-deep.js';
import type { AsyncTaskHandle } from '../../src/types.js';

function jsonResponse(status: number, data: unknown): Response {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers({}),
    text: async () => JSON.stringify(data),
  } as Response;
}

function makeProvider(): GeminiDeepProvider {
  const provider = new GeminiDeepProvider();
  provider.configure({
    credentials: { env: { GEMINI_API_KEY: 'gemini-key' } },
  });
  return provider;
}

function makeHandle(taskId = 'int-123'): AsyncTaskHandle {
  return {
    provider: 'gemini-deep',
    taskId,
    query: 'history of TPUs',
    submittedAt: Date.now(),
    status: 'pending',
  };
}

describe('GeminiDeepProvider Interactions API', () => {
  const originalFetch = globalThis.fetch;

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('submits to /v1beta/interactions with the deep-research envelope and returns a pending handle', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'int-123',
        status: 'in_progress',
      }),
    );
    globalThis.fetch = fetchMock;

    const handle = await makeProvider().submit('history of TPUs', {
      timeout: 1800,
    });

    expect(handle.taskId).toBe('int-123');
    expect(handle.status).toBe('running');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
    );
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('gemini-key');
    expect(headers['Api-Revision']).toBe('2026-05-20');

    const body = JSON.parse(init.body as string) as {
      agent: string;
      input: string;
      background: boolean;
      agent_config: { type: string };
      tools: Array<{ type: string }>;
    };
    expect(body.agent).toBe('deep-research-preview-04-2026');
    expect(body.input).toBe('history of TPUs');
    expect(body.background).toBe(true);
    expect(body.agent_config.type).toBe('deep-research');
    expect(body.tools).toEqual([{ type: 'google_search' }]);
  });

  it('submits the -max agent when overridden via model config', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { id: 'int-9', status: 'in_progress' }),
      );
    globalThis.fetch = fetchMock;

    const provider = new GeminiDeepProvider({
      model: 'deep-research-max-preview-04-2026',
    });
    provider.configure({
      credentials: { env: { GEMINI_API_KEY: 'gemini-key' } },
    });
    await provider.submit('history of TPUs', { timeout: 1800 });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { agent: string };
    expect(body.agent).toBe('deep-research-max-preview-04-2026');
  });

  it('throws on submit failure so the dispatcher falls back to sync', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(403, { error: { message: 'preview not enabled' } }),
      );
    await expect(
      makeProvider().submit('history of TPUs', { timeout: 1800 }),
    ).rejects.toThrow();
  });

  it('maps poll statuses (in_progress running, failed with message)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { id: 'int-123', status: 'in_progress' }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: 'int-123',
          status: 'failed',
          error: { message: 'agent overloaded' },
        }),
      );

    const provider = makeProvider();
    expect(await provider.poll(makeHandle())).toEqual({
      status: 'running',
      message: undefined,
    });
    expect(await provider.poll(makeHandle())).toEqual({
      status: 'failed',
      message: 'agent overloaded',
    });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/interactions/int-123',
    );
  });

  it('throws on a transport-level poll failure so polling retries', async () => {
    // A 4xx that is not 429 is returned without internal retry, exercising the
    // non-200 throw path quickly (a 5xx would resolve only after the client's
    // own backoff retries). Either way poll() throws so the caller retries.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(502, { error: 'bad gateway' }));

    await expect(makeProvider().poll(makeHandle())).rejects.toThrow(
      'Poll returned HTTP 502',
    );
  });

  it('returns a terminal failure for non-retryable client errors', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { error: 'bad key' }));

    const result = await makeProvider().poll(makeHandle());
    expect(result.status).toBe('failed');
    expect(result.message).toContain('401');
  });

  it('retrieves a completed interaction with output_text, annotation citations, and usage', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'int-123',
        status: 'completed',
        agent: 'deep-research-preview-04-2026',
        created: '2026-05-20T10:00:00.000Z',
        updated: '2026-05-20T10:02:00.000Z',
        output_text: 'Deep research report on TPUs.',
        steps: [
          {
            type: 'model_output',
            content: [
              {
                type: 'text',
                text: 'Deep research report on TPUs.',
                annotations: [
                  {
                    type: 'url_citation',
                    url: 'https://example.com/tpu',
                    title: 'TPU history',
                    start_index: 0,
                    end_index: 10,
                  },
                  {
                    type: 'url_citation',
                    url: 'https://example.com/tpu',
                    title: 'TPU history (dupe)',
                  },
                  {
                    type: 'place_citation',
                    url: 'https://maps.example.com/dc',
                    name: 'Data center',
                  },
                ],
              },
            ],
          },
        ],
        usage: {
          total_input_tokens: 120,
          total_output_tokens: 3400,
          total_tokens: 3520,
        },
      }),
    );

    const result = await makeProvider().retrieve(makeHandle());
    expect(result.error).toBeUndefined();
    expect(result.content).toBe('Deep research report on TPUs.');
    // Duplicate URL dropped; place_citation mapped via its url.
    expect(result.citations).toHaveLength(2);
    expect(result.citations[0]).toEqual({
      url: 'https://example.com/tpu',
      title: 'TPU history',
      provider: 'gemini-deep',
    });
    expect(result.citations[1]).toEqual({
      url: 'https://maps.example.com/dc',
      title: 'Data center',
      provider: 'gemini-deep',
    });
    expect(result.durationMs).toBe(120_000);
    expect(result.model).toBe('deep-research-preview-04-2026');
    expect(result.tokenUsage).toEqual({ input: 120, output: 3400 });
    expect(result.usage).toEqual({
      inputTokens: 120,
      outputTokens: 3400,
      totalTokens: 3520,
      raw: {
        total_input_tokens: 120,
        total_output_tokens: 3400,
        total_tokens: 3520,
      },
    });
  });

  it('falls back to steps text when output_text is absent', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'int-123',
        status: 'completed',
        steps: [
          {
            type: 'model_output',
            content: [
              { type: 'text', text: 'Part one.' },
              { type: 'text', text: 'Part two.' },
            ],
          },
        ],
      }),
    );

    const result = await makeProvider().retrieve(makeHandle());
    expect(result.content).toBe('Part one.\nPart two.');
  });

  it('returns an error result for failed or not-yet-completed interactions', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: 'int-123',
          status: 'failed',
          error: { message: 'research failed' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { id: 'int-123', status: 'in_progress' }),
      );

    const provider = makeProvider();
    const failed = await provider.retrieve(makeHandle());
    expect(failed.error).toBe('research failed');

    const pending = await provider.retrieve(makeHandle());
    expect(pending.error).toContain('not completed yet');
    expect(pending.error).toContain('in_progress');
  });
});
