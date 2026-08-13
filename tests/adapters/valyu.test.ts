import { describe, expect, it, vi } from 'vitest';
import { ValyuResearchProvider } from '../../src/adapters/valyu-research.js';
import { ValyuSearchProvider } from '../../src/adapters/valyu-search.js';
import { UnsafeToRetrySubmissionError } from '../../src/core/errors.js';
import type { HttpClient } from '../../src/core/http-client.js';

const response = <T>(status: number, data: T) => ({
  status,
  statusText: status < 300 ? 'OK' : 'Error',
  headers: {},
  durationMs: 1,
  data,
});

function client(implementation: HttpClient): {
  httpClient: HttpClient;
  calls: ReturnType<typeof vi.fn>;
} {
  const calls = vi.fn(implementation);
  return { httpClient: calls, calls };
}

describe('Valyu Search', () => {
  it('serializes supported controls and preserves source/cost provenance', async () => {
    const transport = client(async () =>
      response(200, {
        success: true,
        tx_id: 'tx-123',
        results: [
          {
            id: 'valyu/valyu-arxiv/2401.1',
            title: 'Paper',
            url: 'https://arxiv.org/abs/2401.1',
            content: 'Evidence',
            source: 'valyu/valyu-arxiv',
            source_type: 'paper',
            relevance_score: 0.91,
            price: 0.001,
            length: 8,
            publication_date: '2026-08-01',
            doi: '10.1/example',
          },
        ],
        results_by_source: { proprietary: 1 },
        total_deduction_dollars: 0.004,
        total_characters: 8,
      }),
    );
    const provider = new ValyuSearchProvider({
      searchType: 'proprietary',
      maxResults: 7,
      maxPrice: 20,
      relevanceThreshold: 0.7,
      includedSources: ['valyu/valyu-arxiv'],
      sourceBiases: { 'arxiv.org': 5 },
      instructions: 'Prioritize methods.',
      isToolCall: false,
      responseLength: 'medium',
      startDate: '2026-01-01',
      endDate: '2026-08-01',
      countryCode: 'CA',
    });
    provider.configure({
      credentials: { env: { VALYU_API_KEY: 'synthetic-key' } },
      httpClient: transport.httpClient,
    });

    const result = await provider.execute('quantum methods', { timeout: 10 });
    expect(transport.calls).toHaveBeenCalledWith(
      'https://api.valyu.ai/v1/search',
      expect.objectContaining({
        headers: { 'X-API-Key': 'synthetic-key' },
        body: {
          query: 'quantum methods',
          max_num_results: 7,
          search_type: 'proprietary',
          max_price: 20,
          relevance_threshold: 0.7,
          included_sources: ['valyu/valyu-arxiv'],
          source_biases: { 'arxiv.org': 5 },
          instructions: 'Prioritize methods.',
          is_tool_call: false,
          response_length: 'medium',
          start_date: '2026-01-01',
          end_date: '2026-08-01',
          country_code: 'CA',
        },
      }),
    );
    expect(result.usage).toEqual({ costUsd: 0.004 });
    expect(result.citations[0]).toMatchObject({
      providerReference: 'valyu/valyu-arxiv/2401.1',
      publisher: 'valyu/valyu-arxiv',
      publishedAt: '2026-08-01T00:00:00.000Z',
    });
    expect(result.providerMeta).toMatchObject({
      'valyu:transaction_id': 'tx-123',
      'valyu:search_type': 'proprietary',
      'valyu:results': [
        {
          source: 'valyu/valyu-arxiv',
          relevance_score: 0.91,
          doi: '10.1/example',
        },
      ],
    });
  });

  it.each([
    [401, { success: false }, 'API returned 401'],
    [
      200,
      { success: false, error: 'Provider rejected query' },
      'Provider rejected query',
    ],
  ])(
    'fails closed for HTTP %s search failures',
    async (status, data, error) => {
      const transport = client(async () => response(status, data));
      const provider = new ValyuSearchProvider();
      provider.configure({
        credentials: { env: { VALYU_API_KEY: 'synthetic-key' } },
        httpClient: transport.httpClient,
      });
      await expect(
        provider.execute('failure', { timeout: 10 }),
      ).resolves.toMatchObject({
        content: '',
        citations: [],
        error: expect.stringContaining(error),
      });
    },
  );

  it('normalizes empty search results', async () => {
    const transport = client(async () =>
      response(200, { success: true, results: [] }),
    );
    const provider = new ValyuSearchProvider();
    provider.configure({
      credentials: { env: { VALYU_API_KEY: 'synthetic-key' } },
      httpClient: transport.httpClient,
    });
    await expect(
      provider.execute('empty', { timeout: 10 }),
    ).resolves.toMatchObject({
      content: 'No results found.',
      citations: [],
    });
  });
});

describe('Valyu DeepResearch', () => {
  it('submits, polls progress, retrieves, and cancels the durable task', async () => {
    const transport = client(async (url, options) => {
      if (url.endsWith('/cancel')) {
        return response(200, {
          success: true,
          message: 'Task cancelled',
          deepresearch_id: 'dr-1',
        });
      }
      if (options?.method === 'POST') {
        return response(202, {
          deepresearch_id: 'dr-1',
          status: 'queued',
          mode: 'heavy',
          created_at: '2026-08-12T00:00:00.000Z',
        });
      }
      return response(200, {
        deepresearch_id: 'dr-1',
        status: 'completed',
        mode: 'heavy',
        created_at: '2026-08-12T00:00:00.000Z',
        completed_at: '2026-08-12T00:10:00.000Z',
        output_type: 'markdown',
        output: '# Report',
        cost: 2.5,
        cost_breakdown: { task: 2.5 },
        progress: { current_step: 3, total_steps: 15 },
        pdf_url: 'https://storage.valyu.ai/report.pdf?token=ephemeral',
        sources: [
          {
            title: 'Study',
            url: 'https://example.com/study',
            snippet: 'Finding',
            source: 'valyu/valyu-pubmed',
            fragment: '#:~:text=Finding',
          },
        ],
        deliverables: [
          {
            id: 'del-1',
            type: 'csv',
            status: 'completed',
            title: 'Data export',
            url: 'https://storage.valyu.ai/data.csv?token=ephemeral',
            s3_key: 'secret/internal/path.csv',
          },
        ],
      });
    });
    const provider = new ValyuResearchProvider({
      mode: 'heavy',
      researchStrategy: 'Use peer-reviewed evidence.',
      reportFormat: 'Write Markdown.',
      search: {
        searchType: 'proprietary',
        includedSources: ['medical'],
      },
      urls: ['https://example.com/context'],
      outputFormats: ['markdown', 'pdf'],
    });
    provider.configure({
      credentials: { env: { VALYU_API_KEY: 'synthetic-key' } },
      httpClient: transport.httpClient,
    });
    const handle = await provider.submit('clinical question', { timeout: 10 });
    expect(handle).toMatchObject({ taskId: 'dr-1', status: 'pending' });
    expect(transport.calls.mock.calls[0]?.[1]?.body).toEqual({
      query: 'clinical question',
      mode: 'heavy',
      research_strategy: 'Use peer-reviewed evidence.',
      report_format: 'Write Markdown.',
      search: {
        search_type: 'proprietary',
        included_sources: ['medical'],
      },
      urls: ['https://example.com/context'],
      output_formats: ['markdown', 'pdf'],
    });
    await expect(provider.poll(handle)).resolves.toMatchObject({
      status: 'completed',
      progress: 20,
      rawStatus: 'completed',
    });
    const result = await provider.retrieve(handle);
    expect(result).toMatchObject({
      content: '# Report',
      durationMs: 600_000,
      usage: { costUsd: 2.5 },
      citations: [
        {
          providerReference: 'valyu/valyu-pubmed',
          locator: '#:~:text=Finding',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('s3_key');
    expect(JSON.stringify(result)).not.toContain('secret/internal');
    expect(JSON.stringify(result)).not.toContain('token=ephemeral');
    expect(result.providerMeta?.['valyu:artifacts']).toEqual([
      { kind: 'pdf' },
      {
        kind: 'csv',
        provider_asset_id: 'del-1',
        status: 'completed',
        title: 'Data export',
      },
    ]);
    await expect(provider.cancel(handle)).resolves.toMatchObject({
      status: 'cancelled',
      rawStatus: 'cancelled',
    });
  });

  it('never performs a paid health-check submission', async () => {
    const transport = client(async () => response(500, {}));
    const provider = new ValyuResearchProvider();
    provider.configure({
      credentials: { env: { VALYU_API_KEY: 'synthetic-key' } },
      httpClient: transport.httpClient,
    });
    await expect(provider.test()).resolves.toEqual({ ok: true });
    expect(transport.calls).not.toHaveBeenCalled();
  });

  it('never performs a paid search health-check request', async () => {
    const transport = client(async () => response(500, {}));
    const provider = new ValyuSearchProvider();
    provider.configure({
      credentials: { env: { VALYU_API_KEY: 'synthetic-key' } },
      httpClient: transport.httpClient,
    });
    await expect(provider.test()).resolves.toEqual({ ok: true });
    expect(transport.calls).not.toHaveBeenCalled();
  });

  it('rejects overlong research queries before submission', async () => {
    const transport = client(async () => response(202, {}));
    const provider = new ValyuResearchProvider();
    provider.configure({
      credentials: { env: { VALYU_API_KEY: 'synthetic-key' } },
      httpClient: transport.httpClient,
    });
    await expect(
      provider.submit('x'.repeat(25_001), { timeout: 10 }),
    ).rejects.toThrow('cannot exceed 25000 characters');
    expect(transport.calls).not.toHaveBeenCalled();
  });

  it.each([
    ['non-202', async () => response(400, { error: 'bad request' })],
    [
      'transport error',
      async () => {
        throw new Error('connection ended after submit');
      },
    ],
  ])('keeps %s submissions unsafe to retry', async (_case, implementation) => {
    const transport = client(implementation);
    const provider = new ValyuResearchProvider();
    provider.configure({
      credentials: { env: { VALYU_API_KEY: 'synthetic-key' } },
      httpClient: transport.httpClient,
    });
    await expect(
      provider.submit('unsafe retry', { timeout: 10 }),
    ).rejects.toBeInstanceOf(UnsafeToRetrySubmissionError);
    expect(transport.calls).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'not completed',
      { deepresearch_id: 'dr-retrieve', status: 'running' },
      'is not completed',
    ],
    [
      'unsupported output',
      {
        deepresearch_id: 'dr-retrieve',
        status: 'completed',
        output_type: 'json',
        output: { answer: true },
      },
      'unsupported research output type',
    ],
  ])('fails closed for %s retrieval', async (_case, data, error) => {
    const transport = client(async () => response(200, data));
    const provider = new ValyuResearchProvider();
    provider.configure({
      credentials: { env: { VALYU_API_KEY: 'synthetic-key' } },
      httpClient: transport.httpClient,
    });
    await expect(
      provider.retrieve({
        provider: 'valyu-research',
        taskId: 'dr-retrieve',
        query: 'retrieve guard',
        submittedAt: Date.now(),
        status: 'running',
      }),
    ).resolves.toMatchObject({
      content: '',
      citations: [],
      error: expect.stringContaining(error),
    });
  });

  it('times out direct synchronous execution without claiming remote cancellation', async () => {
    vi.useFakeTimers();
    try {
      const transport = client(async (_url, options) =>
        options?.method === 'POST'
          ? response(202, {
              deepresearch_id: 'dr-timeout',
              status: 'queued',
              created_at: '2026-08-12T00:00:00.000Z',
            })
          : response(200, {
              deepresearch_id: 'dr-timeout',
              status: 'running',
            }),
      );
      const provider = new ValyuResearchProvider();
      provider.configure({
        credentials: { env: { VALYU_API_KEY: 'synthetic-key' } },
        httpClient: transport.httpClient,
      });
      const executing = provider.execute('direct timeout', { timeout: 1 });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(executing).resolves.toMatchObject({
        content: '',
        error: expect.stringContaining(
          'exceeded the local timeout and may still be running remotely',
        ),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['failed', 'Valyu research task failed.'],
    ['cancelled', 'Valyu research task was cancelled.'],
  ] as const)(
    'preserves direct synchronous %s terminal state',
    async (status, error) => {
      const transport = client(async () =>
        response(202, {
          deepresearch_id: `dr-${status}`,
          status,
          created_at: '2026-08-12T00:00:00.000Z',
        }),
      );
      const provider = new ValyuResearchProvider();
      provider.configure({
        credentials: { env: { VALYU_API_KEY: 'synthetic-key' } },
        httpClient: transport.httpClient,
      });
      await expect(
        provider.execute(`direct ${status}`, { timeout: 1 }),
      ).resolves.toMatchObject({ content: '', error });
      expect(transport.calls).toHaveBeenCalledOnce();
    },
  );

  it('fails closed on an unknown provider task status', async () => {
    const transport = client(async () =>
      response(200, {
        deepresearch_id: 'dr-unknown',
        status: 'future_state',
      }),
    );
    const provider = new ValyuResearchProvider();
    provider.configure({
      credentials: { env: { VALYU_API_KEY: 'synthetic-key' } },
      httpClient: transport.httpClient,
    });
    await expect(
      provider.poll({
        provider: 'valyu-research',
        taskId: 'dr-unknown',
        query: 'unknown state',
        submittedAt: Date.now(),
        status: 'running',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      rawStatus: 'future_state',
      message: 'Valyu returned an unknown task status.',
    });
  });

  it('fails closed when polling or cancellation changes the task identity', async () => {
    const transport = client(async (url) =>
      url.endsWith('/cancel')
        ? response(200, {
            success: true,
            deepresearch_id: 'different-task',
          })
        : response(200, {
            deepresearch_id: 'different-task',
            status: 'running',
          }),
    );
    const provider = new ValyuResearchProvider();
    provider.configure({
      credentials: { env: { VALYU_API_KEY: 'synthetic-key' } },
      httpClient: transport.httpClient,
    });
    const handle = {
      provider: 'valyu-research',
      taskId: 'expected-task',
      query: 'identity check',
      submittedAt: Date.now(),
      status: 'pending' as const,
    };
    await expect(provider.poll(handle)).rejects.toThrow(
      'task identity changed',
    );
    await expect(provider.cancel(handle)).rejects.toThrow(
      'Cancel returned HTTP 200',
    );
  });

  it.each(['awaiting_input', 'paused'])(
    'does not claim held-back HITL status %s as supported',
    async (status) => {
      const transport = client(async () =>
        response(200, { deepresearch_id: 'dr-hitl', status }),
      );
      const provider = new ValyuResearchProvider();
      provider.configure({
        credentials: { env: { VALYU_API_KEY: 'synthetic-key' } },
        httpClient: transport.httpClient,
      });
      await expect(
        provider.poll({
          provider: 'valyu-research',
          taskId: 'dr-hitl',
          query: 'held-back HITL',
          submittedAt: Date.now(),
          status: 'running',
        }),
      ).resolves.toMatchObject({
        status: 'failed',
        rawStatus: status,
        message: 'Valyu requested unsupported human-in-the-loop interaction.',
      });
    },
  );
});
