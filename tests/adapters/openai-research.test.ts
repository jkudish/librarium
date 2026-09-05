import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { getProvider, initializeProviders } from '../../src/adapters/index.js';
import { OpenAIResearchProvider } from '../../src/adapters/openai-research.js';
import type { AsyncTaskHandle } from '../../src/types.js';

function jsonResponse(status: number, data: unknown): Response {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(),
    text: async () => JSON.stringify(data),
  } as Response;
}

function provider(
  options: {
    model?: string;
    maxToolCalls?: unknown;
    reasoningEffort?: unknown;
    returnTokenBudget?: unknown;
  } = {},
) {
  return new OpenAIResearchProvider({
    ...options,
    credentials: { env: { OPENAI_API_KEY: 'openai-key' } },
  });
}

function handle(
  status: AsyncTaskHandle['status'] = 'pending',
): AsyncTaskHandle {
  return {
    provider: 'openai-research',
    taskId: 'resp_123',
    query: 'What changed?',
    submittedAt: 1,
    status,
  };
}

describe('OpenAIResearchProvider', () => {
  const originalFetch = globalThis.fetch;

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('submits the canonical async Responses API request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { id: 'resp_123', status: 'queued' }),
      );
    globalThis.fetch = fetchMock;

    const task = await provider({
      maxToolCalls: 3,
      reasoningEffort: 'medium',
      returnTokenBudget: 'unlimited',
    }).submit('What changed?', { timeout: 1800 });
    expect(task).toMatchObject({
      provider: 'openai-research',
      taskId: 'resp_123',
      status: 'pending',
      providerStatus: 'queued',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'gpt-5.6-sol',
      input: [{ role: 'user', content: 'What changed?' }],
      tools: [{ type: 'web_search', return_token_budget: 'unlimited' }],
      reasoning: { effort: 'medium' },
      max_tool_calls: 3,
      background: true,
    });
  });

  it('uses high reasoning, the standard search budget, and omits max_tool_calls by default', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { id: 'resp_123', status: 'queued' }),
      );
    globalThis.fetch = fetchMock;

    await provider().submit('What changed?', { timeout: 1800 });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body.tools).toEqual([
      { type: 'web_search', return_token_budget: 'default' },
    ]);
    expect(body).not.toHaveProperty('max_tool_calls');
  });

  it('rejects invalid options before making a paid request', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    await expect(
      provider({ maxToolCalls: 1.5 }).submit('query', { timeout: 1800 }),
    ).rejects.toThrow('maxToolCalls must be a positive integer');
    await expect(
      provider({ reasoningEffort: 'turbo' }).submit('query', {
        timeout: 1800,
      }),
    ).rejects.toThrow('reasoningEffort must be one of');
    await expect(
      provider({ returnTokenBudget: 'extended' }).submit('query', {
        timeout: 1800,
      }),
    ).rejects.toThrow('returnTokenBudget must be one of: default, unlimited');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps unrelated providers available when OpenAI options are invalid', async () => {
    await expect(
      initializeProviders({
        providers: {
          'openai-research': {
            enabled: true,
            options: { reasoningEffort: 'turbo' },
          },
        },
      }),
    ).resolves.toBeDefined();
    expect(getProvider('gemini-deep')).toBeDefined();
  });

  it('does not submit when the caller signal is already aborted', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider().submit('What changed?', {
        timeout: 1800,
        signal: controller.signal,
      }),
    ).rejects.toThrow('Request aborted');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not retry a failed billable submission', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(500, { error: { message: 'down' } }));
    globalThis.fetch = fetchMock;

    await expect(
      provider().submit('What changed?', { timeout: 1800 }),
    ).rejects.toMatchObject({ name: 'UnsafeToRetrySubmissionError' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps unknown provider statuses retryable and visible', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { id: 'resp_123', status: 'migrating' }),
      );
    await expect(provider().poll(handle('running'))).resolves.toEqual({
      status: 'running',
      rawStatus: 'migrating',
      message: 'Unknown OpenAI response status: migrating',
    });
  });

  it.each([
    ['queued', 'pending'],
    ['in_progress', 'running'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['incomplete', 'failed'],
  ] as const)('maps provider status %s to %s', async (rawStatus, status) => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'resp_123',
        status: rawStatus,
      }),
    );

    await expect(provider().poll(handle('running'))).resolves.toMatchObject({
      status,
      rawStatus,
    });
  });

  it('extracts completed output, citations, model, and usage', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'resp_123',
        status: 'completed',
        model: 'gpt-5.6-sol',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Answer text',
                annotations: [
                  {
                    type: 'url_citation',
                    url: 'https://example.com/source',
                    title: 'Source',
                  },
                ],
              },
            ],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      }),
    );

    await expect(
      provider().retrieve(handle('completed')),
    ).resolves.toMatchObject({
      provider: 'openai-research',
      content: 'Answer text',
      model: 'gpt-5.6-sol',
      citations: [
        {
          url: 'https://example.com/source',
          title: 'Source',
          provider: 'openai-research',
        },
      ],
      tokenUsage: { input: 10, output: 4 },
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
  });

  it('returns an error when retrieval is not complete', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { id: 'resp_123', status: 'in_progress' }),
      );
    await expect(provider().retrieve(handle('running'))).resolves.toMatchObject(
      {
        error: 'Task is not complete: status=in_progress',
        content: '',
        citations: [],
      },
    );
  });

  it('returns an error when retrieval returns a non-success HTTP status', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { error: 'missing' }));
    await expect(
      provider().retrieve(handle('completed')),
    ).resolves.toMatchObject({
      error: 'Retrieve failed with HTTP 404',
      content: '',
      citations: [],
    });
  });

  it('checks the exact configured model for health', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
    globalThis.fetch = fetchMock;
    await expect(
      provider({ model: 'gpt-5.6-sol-custom' }).test(),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.openai.com/v1/models/gpt-5.6-sol-custom',
    );
  });
});
