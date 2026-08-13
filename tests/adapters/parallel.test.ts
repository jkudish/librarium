import { describe, expect, it, vi } from 'vitest';
import {
  ParallelChatProvider,
  ParallelResearchProvider,
  ParallelSearchProvider,
} from '../../src/adapters/parallel.js';
import type {
  HttpClient,
  HttpRequestOptions,
} from '../../src/core/http-client.js';

const key = 'parallel-fixture-key';

function client(data: unknown, status = 200): HttpClient {
  return vi.fn(async () => ({
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {},
    data,
    durationMs: 1,
  })) as unknown as HttpClient;
}

describe('Parallel first-party providers', () => {
  it('serializes search controls and returns ranked evidence without a synthesis', async () => {
    const http = client({
      search_id: 'search_1',
      session_id: 'session_1',
      warnings: [{ message: 'adjusted' }],
      usage: [{ name: 'sku_search', count: 1 }],
      results: [
        {
          url: 'https://example.test/a',
          title: 'First result',
          excerpts: ['First evidence.'],
        },
        { url: 'https://example.test/b', excerpts: ['Second evidence.'] },
      ],
    });
    const provider = new ParallelSearchProvider(
      {
        mode: 'advanced',
        maxResults: 2,
        maxCharsTotal: 500,
        maxCharsPerResult: 120,
        location: 'ca',
        sourcePolicy: {
          includeDomains: ['example.test'],
          afterDate: '2026-01-01',
        },
        fetchPolicy: { maxAgeSeconds: 600, disableCacheFallback: true },
      },
      { apiKey: key, httpClient: http },
    );

    const result = await provider.execute('parallel research', { timeout: 9 });
    expect(result.content).toContain('### 1. First result');
    expect(result.content).not.toContain('answer');
    expect(result.citations).toEqual([
      expect.objectContaining({ url: 'https://example.test/a' }),
      expect.objectContaining({ url: 'https://example.test/b' }),
    ]);
    expect(result.providerMeta).toMatchObject({
      'parallel:search_id': 'search_1',
      'parallel:session_id': 'session_1',
    });
    const [, request] = (http as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, HttpRequestOptions];
    expect(request.headers).toEqual({ 'x-api-key': key });
    expect(request.body).toEqual({
      objective: 'parallel research',
      search_queries: ['parallel research'],
      mode: 'advanced',
      max_chars_total: 500,
      advanced_settings: {
        source_policy: {
          include_domains: ['example.test'],
          after_date: '2026-01-01',
        },
        fetch_policy: { max_age_seconds: 600, disable_cache_fallback: true },
        excerpt_settings: { max_chars_per_result: 120 },
        location: 'CA',
        max_results: 2,
      },
    });
  });

  it('rejects invalid search controls before dispatch', async () => {
    const http = vi.fn();
    const provider = new ParallelSearchProvider(
      {
        sourcePolicy: {
          includeDomains: Array.from(
            { length: 200 },
            (_, index) => `a${index}.test`,
          ),
          excludeDomains: ['blocked.test'],
        },
      },
      { apiKey: key, httpClient: http as unknown as HttpClient },
    );
    const result = await provider.execute('query', { timeout: 9 });
    expect(result.error).toContain('200 domains');
    expect(http).not.toHaveBeenCalled();
  });

  it('maps chat basis only when the response reports it and supports JSON schema output', async () => {
    const http = client({
      id: 'chat_1',
      model: 'base',
      choices: [{ message: { content: '{"answer":"yes"}' } }],
      basis: [
        {
          field: 'output',
          reasoning: 'Confirmed by the source.',
          confidence: 'high',
          citations: [
            { url: 'https://example.test/source', excerpts: ['Evidence.'] },
          ],
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
    const provider = new ParallelChatProvider({
      apiKey: key,
      httpClient: http,
      model: 'base',
      configuredOptions: {
        responseFormat: {
          name: 'answer',
          schema: { type: 'object' },
          strict: true,
        },
      },
    });
    const result = await provider.execute('question', { timeout: 9 });
    expect(result.citations).toEqual([
      expect.objectContaining({
        url: 'https://example.test/source',
        snippet: 'Evidence.',
      }),
    ]);
    expect(result.providerMeta).toMatchObject({
      'parallel:interaction_id': 'chat_1',
      'parallel:basis_available': true,
    });
    const [, request] = (http as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, HttpRequestOptions];
    expect(request.body).toMatchObject({
      model: 'base',
      stream: false,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', strict: true },
      },
    });
  });

  it('has durable Task create, poll, retrieve and terminal mapping', async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce({
        status: 202,
        statusText: 'Accepted',
        headers: {},
        durationMs: 1,
        data: { run_id: 'trun_1', status: 'queued', processor: 'pro' },
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: {},
        durationMs: 1,
        data: { run_id: 'trun_1', status: 'running' },
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: {},
        durationMs: 1,
        data: {
          run: { run_id: 'trun_1', status: 'completed', processor: 'pro' },
          output: {
            type: 'text',
            content: 'Research report.',
            basis: [
              {
                field: 'output',
                reasoning: 'Compared sources.',
                confidence: 'medium',
                citations: [
                  {
                    url: 'https://example.test/evidence',
                    excerpts: ['Source excerpt.'],
                  },
                ],
              },
            ],
          },
        },
      });
    const provider = new ParallelResearchProvider({
      apiKey: key,
      httpClient: http as unknown as HttpClient,
      model: 'pro',
      configuredOptions: { includeDomains: ['example.test'], location: 'us' },
    });
    const handle = await provider.submit('research', { timeout: 90 });
    expect(handle).toMatchObject({
      taskId: 'trun_1',
      status: 'pending',
      providerStatus: 'queued',
    });
    expect(await provider.poll(handle)).toEqual({
      status: 'running',
      rawStatus: 'running',
      message: undefined,
    });
    const result = await provider.retrieve(handle);
    expect(result).toMatchObject({
      content: 'Research report.',
      model: 'pro',
      providerMeta: { 'parallel:run_id': 'trun_1' },
    });
    expect(result.citations).toEqual([
      expect.objectContaining({ url: 'https://example.test/evidence' }),
    ]);
    const [, create] = http.mock.calls[0] as [string, HttpRequestOptions];
    expect(create.body).toMatchObject({
      processor: 'pro',
      source_policy: { include_domains: ['example.test'] },
      advanced_settings: { location: 'US' },
    });
  });

  it('fails a bad processor before a billable submission', async () => {
    const http = vi.fn();
    const provider = new ParallelResearchProvider({
      apiKey: key,
      httpClient: http as unknown as HttpClient,
      model: 'core',
    });
    await expect(provider.submit('research', { timeout: 90 })).rejects.toThrow(
      'processor must be one of',
    );
    expect(http).not.toHaveBeenCalled();
  });
});
