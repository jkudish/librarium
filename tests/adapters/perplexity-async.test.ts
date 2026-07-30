import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PerplexitySonarDeepProvider } from '../../src/adapters/perplexity-sonar-deep.js';
import { UnsafeToRetrySubmissionError } from '../../src/core/errors.js';
import type { AsyncTaskHandle } from '../../src/types.js';

function jsonResponse(status: number, data: unknown): Response {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers({}),
    text: async () => JSON.stringify(data),
  } as Response;
}

function makeProvider(): PerplexitySonarDeepProvider {
  return new PerplexitySonarDeepProvider({
    credentials: { env: { PERPLEXITY_API_KEY: 'pplx-key' } },
  });
}

function makeHandle(taskId = 'req-123'): AsyncTaskHandle {
  return {
    provider: 'perplexity-sonar-deep',
    taskId,
    query: 'postgres pooling',
    submittedAt: Date.now(),
    status: 'pending',
  };
}

describe('PerplexitySonarDeepProvider async API', () => {
  const originalFetch = globalThis.fetch;

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('submits to /v1/async/sonar with the request envelope and returns a pending handle', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'req-123',
        model: 'sonar-deep-research',
        created_at: 1_781_136_000,
        status: 'CREATED',
        response: null,
      }),
    );
    globalThis.fetch = fetchMock;

    const handle = await makeProvider().submit('postgres pooling', {
      timeout: 1800,
    });

    expect(handle.taskId).toBe('req-123');
    expect(handle.status).toBe('pending');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.perplexity.ai/v1/async/sonar');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as {
      request: { model: string; messages: Array<{ content: string }> };
    };
    expect(body.request.model).toBe('sonar-deep-research');
    expect(body.request.messages[0]?.content).toBe('postgres pooling');
  });

  it.each([429, 500])(
    'does not retry an HTTP %s background submission',
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(status, { error: { message: 'submission failed' } }),
        );
      globalThis.fetch = fetchMock;

      await expect(
        makeProvider().submit('postgres pooling', { timeout: 1800 }),
      ).rejects.toBeInstanceOf(UnsafeToRetrySubmissionError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('does not retry or fall through after an ambiguous transport failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('socket timed out'));
    globalThis.fetch = fetchMock;

    await expect(
      makeProvider().submit('postgres pooling', { timeout: 1800 }),
    ).rejects.toBeInstanceOf(UnsafeToRetrySubmissionError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps poll statuses (IN_PROGRESS running, FAILED with message)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { id: 'req-123', status: 'IN_PROGRESS' }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: 'req-123',
          status: 'FAILED',
          error_message: 'model overloaded',
        }),
      );

    const provider = makeProvider();
    expect(await provider.poll(makeHandle())).toEqual({
      status: 'running',
      message: undefined,
      rawStatus: 'IN_PROGRESS',
    });
    expect(await provider.poll(makeHandle())).toEqual({
      status: 'failed',
      message: 'model overloaded',
      rawStatus: 'FAILED',
    });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[0]).toBe(
      'https://api.perplexity.ai/v1/async/sonar/req-123',
    );
  });

  it('retrieves a completed task with content, search_results citations, and usage', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'req-123',
        model: 'sonar-deep-research',
        created_at: 1_781_136_000,
        started_at: 1_781_136_010,
        completed_at: 1_781_136_130,
        status: 'COMPLETED',
        response: {
          id: 'cmpl-1',
          model: 'sonar-deep-research',
          choices: [
            { message: { role: 'assistant', content: 'Deep findings.' } },
          ],
          citations: ['https://example.com/a'],
          search_results: [
            {
              url: 'https://example.com/a',
              title: 'Source A',
              snippet: 'about pooling',
            },
            { url: 'https://example.com/b', title: 'Source B' },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 2000,
            total_tokens: 2100,
            cost: { total_cost: 0.41 },
          },
        },
      }),
    );

    const result = await makeProvider().retrieve(makeHandle());
    expect(result.error).toBeUndefined();
    expect(result.content).toBe('Deep findings.');
    expect(result.citations).toHaveLength(2);
    expect(result.citations[0]?.title).toBe('Source A');
    expect(result.durationMs).toBe(120_000);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 2000,
      totalTokens: 2100,
      costUsd: 0.41,
      raw: {
        prompt_tokens: 100,
        completion_tokens: 2000,
        total_tokens: 2100,
        cost: { total_cost: 0.41 },
      },
    });
  });

  it('returns an error result for failed or not-yet-completed tasks', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: 'req-123',
          status: 'FAILED',
          failed_at: 1_781_136_100,
          created_at: 1_781_136_000,
          error_message: 'research failed',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { id: 'req-123', status: 'IN_PROGRESS' }),
      );

    const provider = makeProvider();
    const failed = await provider.retrieve(makeHandle());
    expect(failed.error).toBe('research failed');

    const pending = await provider.retrieve(makeHandle());
    expect(pending.error).toContain('not completed yet');
    expect(pending.error).toContain('IN_PROGRESS');
  });

  it('falls back to the citations list when search_results is absent', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'req-123',
        status: 'COMPLETED',
        response: {
          id: 'cmpl-1',
          choices: [{ message: { role: 'assistant', content: 'x' } }],
          citations: ['https://example.com/only'],
        },
      }),
    );
    const result = await makeProvider().retrieve(makeHandle());
    expect(result.citations).toEqual([
      { url: 'https://example.com/only', provider: 'perplexity-sonar-deep' },
    ]);
  });
});
