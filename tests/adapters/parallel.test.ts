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
import { normalizeProviderAttemptOutput } from '../../src/core/research-response-projector.js';

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

  it.each([
    {},
    { results: {} },
    { results: [null] },
    { results: [{}] },
    { results: [{ url: '   ' }] },
    { results: [{ url: 'not a URL' }] },
    {
      results: [{ url: 'https://example.test/valid' }, { url: 'not a URL' }],
    },
  ])('rejects malformed successful Search payloads (%o)', async (data) => {
    const result = await new ParallelSearchProvider(
      {},
      {
        apiKey: key,
        httpClient: client(data),
      },
    ).execute('query', { timeout: 9 });

    expect(result).toMatchObject({
      content: '',
      citations: [],
      error: 'Parallel returned an invalid Search response',
    });
  });

  it('maps chat basis only when the response reports it and supports JSON schema output', async () => {
    const http = client({
      id: 'chat_record_1',
      interaction_id: 'interaction_1',
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
      'parallel:interaction_id': 'interaction_1',
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

  it('uses a configured model when the documented compatibility field is empty and persists the canonical result', async () => {
    const provider = new ParallelChatProvider({
      apiKey: key,
      httpClient: client({
        id: 'chat_record_2',
        interaction_id: 'interaction_2',
        model: '',
        choices: [{ message: { content: 'Compatible response.' } }],
      }),
      model: 'base',
    });

    const result = await provider.execute('question', { timeout: 9 });
    expect(result).toMatchObject({
      content: 'Compatible response.',
      model: 'base',
      providerMeta: { 'parallel:interaction_id': 'interaction_2' },
    });
    expect(result.providerMeta).not.toHaveProperty('parallel:id');
    expect(
      normalizeProviderAttemptOutput(
        { binding: { adapter_id: 'parallel-chat' } } as never,
        'result-1',
        result,
        '2026-08-12T00:00:00.000Z',
      ),
    ).toMatchObject({ content: 'Compatible response.', model: 'base' });
  });

  it('does not conflate a chat record id with an interaction id', async () => {
    const result = await new ParallelChatProvider({
      apiKey: key,
      httpClient: client({
        id: 'chat_record_only',
        model: 'base',
        choices: [{ message: { content: 'Response.' } }],
      }),
      model: 'base',
    }).execute('question', { timeout: 9 });

    expect(result.error).toBeUndefined();
    expect(result.providerMeta).not.toHaveProperty('parallel:interaction_id');
  });

  it.each([
    [{ choices: [] }, 'invalid Chat response'],
    [{ choices: [{ message: {} }] }, 'invalid Chat response'],
  ])(
    'rejects malformed successful Chat payloads (%o)',
    async (data, message) => {
      const result = await new ParallelChatProvider({
        apiKey: key,
        httpClient: client(data),
        model: 'base',
      }).execute('question', { timeout: 9 });

      expect(result).toMatchObject({
        content: '',
        citations: [],
        error: expect.stringContaining(message),
      });
    },
  );

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

  it('rejects malformed Task create and status bodies without accepting a remote state', async () => {
    const createProvider = new ParallelResearchProvider({
      apiKey: key,
      httpClient: client({ run_id: 'trun_1', status: 42 }),
      model: 'pro',
    });
    await expect(
      createProvider.submit('research', { timeout: 90 }),
    ).rejects.toThrow('invalid task response');

    const pollProvider = new ParallelResearchProvider({
      apiKey: key,
      httpClient: client({ run_id: 'trun_1' }),
      model: 'pro',
    });
    await expect(
      pollProvider.poll({ taskId: 'trun_1' } as never),
    ).resolves.toEqual({
      status: 'failed',
      rawStatus: 'invalid_response',
      message: 'Parallel returned an invalid task status response',
    });
  });

  it.each([
    { status: 'queued' },
    { run_id: '', status: 'queued' },
    { run_id: '   ', status: 'queued' },
  ])(
    'rejects Task creation without a usable remote identity (%o)',
    async (data) => {
      const provider = new ParallelResearchProvider({
        apiKey: key,
        httpClient: client(data),
        model: 'pro',
      });

      await expect(
        provider.submit('research', { timeout: 90 }),
      ).rejects.toThrow('invalid task response');
    },
  );

  it.each([
    [{ status: 'running' }, 'invalid_response'],
    [{ run_id: 'trun_other', status: 'running' }, 'identity_mismatch'],
  ])(
    'rejects Task status with missing or mismatched run identity (%o)',
    async (data, rawStatus) => {
      const provider = new ParallelResearchProvider({
        apiKey: key,
        httpClient: client(data),
        model: 'pro',
      });

      const result = await provider.poll({ taskId: 'trun_1' } as never);
      expect(result).toMatchObject({ status: 'failed', rawStatus });
      expect(result.status).not.toBe('running');
      expect(result.status).not.toBe('completed');
    },
  );

  it.each([
    [
      {
        run: { status: 'completed' },
        output: { type: 'text', content: 'Wrong.' },
      },
      'invalid Task result response',
    ],
    [
      {
        run: { run_id: 'trun_other', status: 'completed' },
        output: { type: 'text', content: 'Wrong.' },
      },
      'different run_id',
    ],
  ])(
    'rejects Task result with missing or mismatched run identity (%o)',
    async (data, message) => {
      const provider = new ParallelResearchProvider({
        apiKey: key,
        httpClient: client(data),
        model: 'pro',
      });

      const result = await provider.retrieve({ taskId: 'trun_1' } as never);
      expect(result).toMatchObject({
        content: '',
        citations: [],
        error: expect.stringContaining(message),
      });
      expect(result.providerMeta).toBeUndefined();
      expect(result.content).not.toContain('Wrong.');
    },
  );

  it.each([
    [
      { run: { run_id: 'trun_1', status: 'completed' }, output: {} },
      'without text output',
    ],
    [
      {
        run: { run_id: 'trun_1', status: 'completed' },
        output: { type: 'json', content: {} },
      },
      'without text output',
    ],
    [
      {
        run: { run_id: 'trun_1', status: 'completed' },
        output: { type: 'text', content: {} },
      },
      'without text output',
    ],
    [{}, 'invalid Task result response'],
  ])(
    'rejects malformed completed Task payloads (%o)',
    async (data, message) => {
      const result = await new ParallelResearchProvider({
        apiKey: key,
        httpClient: client(data),
        model: 'pro',
      }).retrieve({ taskId: 'trun_1' } as never);

      expect(result).toMatchObject({
        content: '',
        citations: [],
        error: expect.stringContaining(message),
      });
      expect(result.content).not.toBe('{}');
    },
  );

  it.each([
    ['https://example.test', 'URL scheme'],
    ['example.test/path', 'path'],
    ['user@example.test', 'credentials'],
    ['example.test:443', 'port'],
  ])(
    'rejects non-domain source policy values before dispatch (%s)',
    async (domain) => {
      const http = vi.fn();
      const result = await new ParallelSearchProvider(
        { sourcePolicy: { includeDomains: [domain] } },
        { apiKey: key, httpClient: http as unknown as HttpClient },
      ).execute('query', { timeout: 9 });

      expect(result.error).toContain('plain domain');
      expect(http).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ sourcePolicy: { afterDate: '2026-02-30' } }],
    [{ location: 'ZZ' }],
    [{ location: 'Canada' }],
  ])(
    'rejects invalid calendar and country controls before dispatch (%o)',
    async (configuredOptions) => {
      const http = vi.fn();
      const result = await new ParallelSearchProvider(configuredOptions, {
        apiKey: key,
        httpClient: http as unknown as HttpClient,
      }).execute('query', { timeout: 9 });

      expect(result.error).toContain('parallel-search options');
      expect(http).not.toHaveBeenCalled();
    },
  );

  it('accepts documented bare extensions in source policy', async () => {
    const http = client({ results: [] });
    await new ParallelSearchProvider(
      { sourcePolicy: { includeDomains: ['.edu', 'subdomain.example.gov'] } },
      { apiKey: key, httpClient: http },
    ).execute('query', { timeout: 9 });

    expect(
      (http as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body,
    ).toMatchObject({
      advanced_settings: {
        source_policy: { include_domains: ['.edu', 'subdomain.example.gov'] },
      },
    });
  });
});
