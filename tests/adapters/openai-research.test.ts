import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  getProvider,
  initializeProviders,
  registerProvider,
} from '../../src/adapters/index.js';
import { OpenAIDeepProvider } from '../../src/adapters/openai-deep.js';
import { OpenAIDeepO3Provider } from '../../src/adapters/openai-deep-o3.js';
import { OpenAIResearchProvider } from '../../src/adapters/openai-research.js';
import {
  type AcceptedTaskPersistenceError,
  dispatch,
} from '../../src/core/dispatcher.js';
import type { AsyncTaskHandle, Config, Provider } from '../../src/types.js';

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

  it('keeps deprecated class exports on canonical provider behavior', () => {
    expect(new OpenAIDeepProvider().id).toBe('openai-research');
    expect(new OpenAIDeepProvider().model).toBe('gpt-5.6-sol');
    expect(new OpenAIDeepO3Provider().id).toBe('openai-research');
    expect(new OpenAIDeepO3Provider().model).toBe('gpt-5.6-sol');
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

  it('does not retry a failed billable submission through sync dispatch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(500, { error: { message: 'down' } }));
    globalThis.fetch = fetchMock;
    const config: Config = {
      version: 1,
      defaults: {
        outputDir: '',
        maxParallel: 1,
        timeout: 30,
        asyncTimeout: 1800,
        asyncPollInterval: 10,
        mode: 'mixed',
        llmWebSearch: true,
      },
      providers: { 'openai-research': { enabled: true } },
      customProviders: {},
      trustedProviderIds: [],
      groups: {},
    };
    await initializeProviders({
      providers: config.providers,
      defaults: config.defaults,
      credentials: { env: { OPENAI_API_KEY: 'openai-key' } },
    });

    const result = await dispatch({
      config,
      providerIds: ['openai-research'],
      query: 'What changed?',
      mode: 'mixed',
      credentials: { env: { OPENAI_API_KEY: 'openai-key' } },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.reports[0]).toMatchObject({ status: 'error' });
    expect(result.asyncTasks).toEqual([]);
  });

  it('reports an immediately cancelled background submission without queuing it', async () => {
    const progress = vi.fn();
    const cancelledProvider: Provider = {
      id: 'cancelled-submit-test',
      displayName: 'Cancelled submit test',
      tier: 'deep-research',
      execution: 'background',
      envVar: '',
      execute: vi.fn(),
      submit: async (query) => ({
        provider: 'cancelled-submit-test',
        taskId: 'cancelled-1',
        query,
        submittedAt: Date.now(),
        status: 'cancelled',
      }),
      poll: async () => ({ status: 'cancelled' }),
      retrieve: async () => ({
        provider: 'cancelled-submit-test',
        tier: 'deep-research',
        content: '',
        citations: [],
        durationMs: 0,
        error: 'Task was cancelled',
      }),
    };
    registerProvider(cancelledProvider);
    const config: Config = {
      version: 1,
      defaults: {
        outputDir: '',
        maxParallel: 1,
        timeout: 30,
        asyncTimeout: 1800,
        asyncPollInterval: 10,
        mode: 'mixed',
        llmWebSearch: true,
      },
      providers: { 'cancelled-submit-test': { enabled: true } },
      customProviders: {},
      trustedProviderIds: [],
      groups: {},
    };

    const result = await dispatch({
      config,
      providerIds: ['cancelled-submit-test'],
      query: 'cancel this',
      mode: 'mixed',
      onProgress: progress,
    });

    expect(result.asyncTasks).toEqual([]);
    expect(result.reports).toEqual([
      expect.objectContaining({
        status: 'error',
        error: 'Task was cancelled',
        task: expect.objectContaining({
          taskId: 'cancelled-1',
          status: 'cancelled',
        }),
      }),
    ]);
    expect(progress.mock.calls[1]?.[0]).toMatchObject({
      event: 'async-submitted',
      task: { taskId: 'cancelled-1' },
    });
    expect(cancelledProvider.execute).not.toHaveBeenCalled();
  });

  it('fails loudly with the accepted handle when write-ahead persistence fails', async () => {
    const acceptedProvider: Provider = {
      id: 'accepted-persistence-test',
      displayName: 'Accepted persistence test',
      tier: 'deep-research',
      execution: 'background',
      envVar: '',
      requiresApiKey: false,
      execute: vi.fn(),
      submit: async (query) => ({
        provider: 'accepted-persistence-test',
        taskId: 'accepted-1',
        query,
        submittedAt: Date.now(),
        status: 'pending',
      }),
      poll: async () => ({ status: 'pending' }),
      retrieve: vi.fn(),
    };
    registerProvider(acceptedProvider);
    const config: Config = {
      version: 1,
      defaults: {
        outputDir: '',
        maxParallel: 1,
        timeout: 30,
        asyncTimeout: 1800,
        asyncPollInterval: 10,
        mode: 'mixed',
        llmWebSearch: true,
      },
      providers: { [acceptedProvider.id]: { enabled: true } },
      customProviders: {},
      trustedProviderIds: [],
      groups: {},
    };

    const request = dispatch({
      config,
      providerIds: [acceptedProvider.id],
      query: 'persist this',
      mode: 'mixed',
      onProgress: (event) => {
        if (event.event === 'async-submitted') {
          throw new Error('disk unavailable');
        }
      },
    });

    await expect(request).rejects.toMatchObject({
      name: 'AcceptedTaskPersistenceError',
      handle: {
        provider: acceptedProvider.id,
        taskId: 'accepted-1',
      },
    } satisfies Partial<AcceptedTaskPersistenceError>);
    expect(acceptedProvider.retrieve).not.toHaveBeenCalled();
  });

  it('retrieves an immediately failed background submission', async () => {
    const progress = vi.fn();
    const failedProvider: Provider = {
      id: 'failed-submit-test',
      displayName: 'Failed submit test',
      tier: 'deep-research',
      execution: 'background',
      envVar: '',
      execute: vi.fn(),
      submit: async (query) => ({
        provider: 'failed-submit-test',
        taskId: 'failed-1',
        query,
        submittedAt: Date.now(),
        status: 'failed',
        providerStatus: 'REJECTED',
      }),
      poll: async () => ({ status: 'failed' }),
      retrieve: async () => ({
        provider: 'failed-submit-test',
        tier: 'deep-research',
        content: '',
        citations: [],
        durationMs: 0,
        error: 'Task failed (REJECTED)',
      }),
    };
    registerProvider(failedProvider);
    const config: Config = {
      version: 1,
      defaults: {
        outputDir: '',
        maxParallel: 1,
        timeout: 30,
        asyncTimeout: 1800,
        asyncPollInterval: 10,
        mode: 'mixed',
        llmWebSearch: true,
      },
      providers: { 'failed-submit-test': { enabled: true } },
      customProviders: {},
      trustedProviderIds: [],
      groups: {},
    };

    const result = await dispatch({
      config,
      providerIds: ['failed-submit-test'],
      query: 'fail this',
      mode: 'mixed',
      onProgress: progress,
    });

    expect(result.asyncTasks).toEqual([]);
    expect(result.reports).toEqual([
      expect.objectContaining({
        status: 'error',
        error: 'Task failed (REJECTED)',
        task: expect.objectContaining({
          taskId: 'failed-1',
          status: 'failed',
        }),
      }),
    ]);
    expect(progress.mock.calls[1]?.[0]).toMatchObject({
      event: 'async-submitted',
      task: { taskId: 'failed-1' },
    });
    expect(failedProvider.execute).not.toHaveBeenCalled();
  });

  it('retrieves an immediately completed background submission', async () => {
    const progress = vi.fn();
    const completedProvider: Provider = {
      id: 'completed-submit-test',
      displayName: 'Completed submit test',
      tier: 'deep-research',
      execution: 'background',
      envVar: '',
      execute: vi.fn(),
      submit: async (query) => ({
        provider: 'completed-submit-test',
        taskId: 'completed-1',
        query,
        submittedAt: Date.now(),
        status: 'completed',
      }),
      poll: async () => ({ status: 'completed' }),
      retrieve: async () => ({
        provider: 'completed-submit-test',
        tier: 'deep-research',
        content: 'Completed research',
        citations: [],
        durationMs: 1,
      }),
    };
    registerProvider(completedProvider);
    const config: Config = {
      version: 1,
      defaults: {
        outputDir: '',
        maxParallel: 1,
        timeout: 30,
        asyncTimeout: 1800,
        asyncPollInterval: 10,
        mode: 'mixed',
        llmWebSearch: true,
      },
      providers: { 'completed-submit-test': { enabled: true } },
      customProviders: {},
      trustedProviderIds: [],
      groups: {},
    };

    const result = await dispatch({
      config,
      providerIds: ['completed-submit-test'],
      query: 'complete this',
      mode: 'mixed',
      onProgress: progress,
    });

    expect(result.asyncTasks).toEqual([]);
    expect(result.reports).toEqual([
      expect.objectContaining({
        status: 'success',
        task: expect.objectContaining({
          taskId: 'completed-1',
          status: 'completed',
          retrievedAt: expect.any(Number),
        }),
      }),
    ]);
    expect(progress.mock.calls[1]?.[0]).toMatchObject({
      event: 'async-submitted',
      task: { taskId: 'completed-1' },
    });
    expect(completedProvider.execute).not.toHaveBeenCalled();
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
