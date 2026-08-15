import { describe, expect, it, vi } from 'vitest';
import { parseAgentResponse } from '../../src/adapters/perplexity-agent-base.js';
import { PerplexityDeepResearchProvider } from '../../src/adapters/perplexity-deep-research.js';
import { PerplexitySonarDeepProvider } from '../../src/adapters/perplexity-sonar-deep.js';
import { PerplexitySonarProProvider } from '../../src/adapters/perplexity-sonar-pro.js';
import { UnsafeToRetrySubmissionError } from '../../src/core/errors.js';
import type { HttpClient, HttpResponse } from '../../src/core/http-client.js';
import type { AsyncTaskHandle } from '../../src/types.js';

function response<T>(data: unknown, status = 200): HttpResponse<T> {
  return {
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    headers: {},
    data: data as T,
    durationMs: 1,
  };
}

function queuedClient(values: Array<{ data: unknown; status?: number }>): {
  client: HttpClient;
  calls: Array<{ url: string; options: Record<string, unknown> }>;
} {
  const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
  const client: HttpClient = async (url, options = {}) => {
    calls.push({ url, options: options as Record<string, unknown> });
    const next = values.shift();
    if (!next) throw new Error('unexpected mocked request');
    return response(next.data, next.status) as HttpResponse<unknown>;
  };
  return { client, calls };
}

function completed(id: string, text = 'Agent answer [web:1]') {
  return {
    id,
    status: 'completed',
    model: 'agent-model',
    output: [
      {
        type: 'search_results',
        results: [
          {
            id: 1,
            url: 'https://example.test/source',
            title: 'Source title',
            snippet: 'Source snippet',
            source: 'web',
          },
          {
            id: 2,
            url: 'https://example.test/considered-only',
            title: 'Uncited result',
            source: 'web',
          },
        ],
      },
      {
        type: 'fetch_url_results',
        contents: [
          {
            url: 'https://example.test/fetched',
            title: 'Fetched page',
            snippet: 'Fetched content',
          },
        ],
      },
      {
        type: 'function_call',
        name: 'documented_but_not_persisted',
        arguments: '{}',
      },
      {
        type: 'message',
        content: [
          { type: 'output_text', text: text.slice(0, -6) },
          { type: 'output_text', text: text.slice(-6) },
        ],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 4 },
      tool_calls: { web_search_calls: 1 },
      cost: { total_cost: 0.125 },
      ignored_additive_field: { never: 'persisted' },
    },
    ignored_additive_field: true,
  };
}

function handle(taskId: string): AsyncTaskHandle {
  return {
    provider: 'perplexity-deep-research',
    taskId,
    query: 'question',
    submittedAt: 1,
    status: 'pending',
  };
}

describe('Perplexity Agent API adapters', () => {
  it('uses the strict low preset request and preserves typed evidence and reported usage', async () => {
    const { client, calls } = queuedClient([{ data: completed('inline-1') }]);
    const provider = new PerplexitySonarProProvider({
      apiKey: 'synthetic-perplexity-key',
      httpClient: client,
    });

    const result = await provider.execute('question', { timeout: 10 });

    expect(result).toMatchObject({
      provider: 'perplexity-sonar-pro',
      tier: 'ai-grounded',
      content: 'Agent answer [web:1]',
      model: 'agent-model',
      tokenUsage: { input: 10, output: 20 },
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        cacheReadInputTokens: 2,
        reasoningTokens: 4,
        costUsd: 0.125,
      },
    });
    expect(result.citations).toEqual([
      {
        url: 'https://example.test/source',
        title: 'Source title',
        snippet: 'Source snippet',
        provider: 'perplexity-sonar-pro',
        providerReference: '1',
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://api.perplexity.ai/v1/agent',
      options: {
        method: 'POST',
        headers: { Authorization: 'Bearer synthetic-perplexity-key' },
        body: { preset: 'low', input: 'question' },
        retry: { mode: 'never' },
      },
    });
    expect(calls[0]?.options.body).not.toHaveProperty('background');
    expect(calls[0]?.options.body).not.toHaveProperty('model');
    expect(result.usage?.raw).toEqual({
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 4 },
      tool_calls: { web_search_calls: 1 },
      cost: { total_cost: 0.125 },
    });
  });

  it('submits medium background work, polls, retrieves, and never resubmits on retrieval', async () => {
    const { client, calls } = queuedClient([
      { data: { id: 'task-123', status: 'queued' } },
      { data: { id: 'task-123', status: 'in_progress' } },
      { data: completed('task-123', 'Research result [1]') },
    ]);
    const provider = new PerplexityDeepResearchProvider({
      apiKey: 'synthetic-perplexity-key',
      httpClient: client,
      model: 'openai/gpt-5.6-sol',
    });

    const submitted = await provider.submit('question', { timeout: 10 });
    expect(submitted).toMatchObject({
      taskId: 'task-123',
      status: 'pending',
      providerStatus: 'queued',
    });
    expect(calls[0]).toMatchObject({
      url: 'https://api.perplexity.ai/v1/agent',
      options: {
        method: 'POST',
        body: {
          preset: 'medium',
          model: 'openai/gpt-5.6-sol',
          input: 'question',
          background: true,
        },
      },
    });
    expect(await provider.poll(submitted)).toEqual({
      status: 'running',
      rawStatus: 'in_progress',
    });
    const retrieved = await provider.retrieve(submitted);
    expect(retrieved.content).toBe('Research result [1]');
    expect(calls.map(({ url, options }) => [url, options.method])).toEqual([
      ['https://api.perplexity.ai/v1/agent', 'POST'],
      ['https://api.perplexity.ai/v1/agent/task-123', 'GET'],
      ['https://api.perplexity.ai/v1/agent/task-123', 'GET'],
    ]);
  });

  it('returns cancellation custody without a tight polling loop', async () => {
    const { client, calls } = queuedClient([
      { data: { id: 'task-cancel', status: 'cancelling' } },
    ]);
    const provider = new PerplexitySonarDeepProvider({
      apiKey: 'synthetic-perplexity-key',
      httpClient: client,
    });

    await expect(provider.cancel(handle('task-cancel'))).resolves.toEqual({
      status: 'running',
      rawStatus: 'cancelling',
    });
    expect(calls.map(({ url, options }) => [url, options.method])).toEqual([
      ['https://api.perplexity.ai/v1/agent/task-cancel/cancel', 'POST'],
    ]);
  });

  it('preserves completion when cancellation races the terminal response', async () => {
    const provider = new PerplexitySonarDeepProvider({
      apiKey: 'synthetic-perplexity-key',
      httpClient: queuedClient([
        { data: completed('task-completed', 'Completed report [1]') },
      ]).client,
    });

    await expect(provider.cancel(handle('task-completed'))).resolves.toEqual({
      status: 'completed',
      rawStatus: 'completed',
      progress: 100,
    });
  });

  it('preserves an accepted task id before parsing terminal output', async () => {
    const { client } = queuedClient([
      {
        data: {
          id: 'accepted-task',
          status: 'completed',
          output: [{ type: 'unknown_future_item' }],
        },
      },
    ]);
    const submitted = await new PerplexityDeepResearchProvider({
      apiKey: 'synthetic-perplexity-key',
      httpClient: client,
    }).submit('question', { timeout: 10 });

    expect(submitted).toMatchObject({
      taskId: 'accepted-task',
      status: 'completed',
      providerStatus: 'completed',
    });
  });

  it('fails closed for unknown statuses, malformed usage, invalid URLs, and unmatched citation markers', async () => {
    expect(() =>
      parseAgentResponse({ id: 'task-1', status: 'mystery' }),
    ).toThrow('status was unknown');
    expect(() =>
      parseAgentResponse({
        id: 'task-1',
        status: 'completed',
        output: [
          { type: 'unknown_future_item' },
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'answer' }],
          },
        ],
      }),
    ).toThrow('output type was unsupported');
    expect(() =>
      parseAgentResponse({
        id: 'task-1',
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: '[web:2]' }],
          },
          {
            type: 'search_results',
            results: [{ id: '1', url: 'https://example.test/source' }],
          },
        ],
      }),
    ).toThrow('unknown result id');

    const malformed = completed('inline-2');
    malformed.usage.cost.total_cost = 'not-a-number';
    const malformedClient = queuedClient([{ data: malformed }]);
    const malformedResult = await new PerplexitySonarProProvider({
      apiKey: 'synthetic-perplexity-key',
      httpClient: malformedClient.client,
    }).execute('question', { timeout: 10 });
    expect(malformedResult.content).toBe('');
    expect(malformedResult.error).toContain('response was malformed');

    const invalidUrl = completed('inline-3');
    invalidUrl.output[0]!.results[0]!.url = 'file:///etc/passwd';
    const invalidUrlResult = await new PerplexitySonarProProvider({
      apiKey: 'synthetic-perplexity-key',
      httpClient: queuedClient([{ data: invalidUrl }]).client,
    }).execute('question', { timeout: 10 });
    expect(invalidUrlResult.error).toContain('not HTTP(S)');
  });

  it('does not expose secrets or raw response bodies and does not retry ambiguous submit', async () => {
    const secret = 'synthetic-perplexity-key';
    const unauthorized: HttpClient = vi.fn(async () =>
      response(
        { error: { message: `Bearer ${secret}`, api_key: secret } },
        401,
      ),
    );
    const result = await new PerplexitySonarProProvider({
      apiKey: secret,
      httpClient: unauthorized,
    }).execute('question', { timeout: 10 });
    expect(result.error).not.toContain(secret);
    expect(result.error).not.toContain('api_key');
    expect(result.error).not.toContain('Bearer');

    const ambiguous = vi.fn<HttpClient>(async () => {
      throw new Error(`socket failed with Bearer ${secret}`);
    });
    await expect(
      new PerplexityDeepResearchProvider({
        apiKey: secret,
        httpClient: ambiguous,
      }).submit('question', { timeout: 10 }),
    ).rejects.toBeInstanceOf(UnsafeToRetrySubmissionError);
    expect(ambiguous).toHaveBeenCalledTimes(1);
  });

  it('validates input and timeout before resolving credentials or using the transport', async () => {
    const client = vi.fn<HttpClient>();
    const provider = new PerplexitySonarProProvider({
      httpClient: client,
    });
    const result = await provider.execute('', { timeout: 0 });
    expect(result.error).toContain('input must be a non-empty string');
    expect(client).not.toHaveBeenCalled();
  });
});
