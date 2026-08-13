import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ExaProvider } from '../../src/adapters/exa.js';
import { GeminiDeepProvider } from '../../src/adapters/gemini-deep.js';
import { GeminiGroundedProvider } from '../../src/adapters/gemini-grounded.js';
import { OpenAIResearchProvider } from '../../src/adapters/openai-research.js';
import { OpenRouterOnlineProvider } from '../../src/adapters/openrouter-online.js';
import { PerplexityDeepResearchProvider } from '../../src/adapters/perplexity-deep-research.js';
import { PerplexitySonarProProvider } from '../../src/adapters/perplexity-sonar-pro.js';
import { TavilyProvider } from '../../src/adapters/tavily.js';

function jsonResponse(status: number, data: unknown): Response {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers({}),
    text: async () => JSON.stringify(data),
  } as Response;
}

describe('usage extraction', () => {
  const originalFetch = globalThis.fetch;

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts Perplexity sonar token usage and reported cost', async () => {
    const apiUsage = {
      prompt_tokens: 12,
      completion_tokens: 34,
      total_tokens: 46,
      cost: { total_cost: 0.0123 },
    };
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'resp-1',
        model: 'sonar-pro',
        choices: [{ message: { role: 'assistant', content: 'Answer.' } }],
        citations: ['https://example.com'],
        usage: apiUsage,
      }),
    );

    const provider = new PerplexitySonarProProvider({
      credentials: { env: { PERPLEXITY_API_KEY: 'pplx-key' } },
    });
    const result = await provider.execute('question', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.tokenUsage).toEqual({ input: 12, output: 34 });
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      totalTokens: 46,
      costUsd: 0.0123,
      raw: apiUsage,
    });
  });

  it('omits Perplexity sonar cost when the API does not report one', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'resp-2',
        choices: [{ message: { role: 'assistant', content: 'Answer.' } }],
        usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
      }),
    );

    const provider = new PerplexitySonarProProvider({
      credentials: { env: { PERPLEXITY_API_KEY: 'pplx-key' } },
    });
    const result = await provider.execute('question', { timeout: 10 });

    expect(result.usage?.totalTokens).toBe(11);
    expect(result.usage?.costUsd).toBeUndefined();
  });

  it('extracts Perplexity agent API token usage', async () => {
    const apiUsage = { input_tokens: 100, output_tokens: 250 };
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'agent-1',
        status: 'completed',
        model: 'deep-research',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Research findings.' }],
          },
        ],
        usage: apiUsage,
      }),
    );

    const provider = new PerplexityDeepResearchProvider({
      credentials: { env: { PERPLEXITY_API_KEY: 'pplx-key' } },
    });
    const result = await provider.execute('deep question', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.tokenUsage).toEqual({ input: 100, output: 250 });
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 250,
      totalTokens: undefined,
      raw: apiUsage,
    });
    expect(result.usage?.costUsd).toBeUndefined();
  });

  it('extracts OpenAI research token usage on retrieve', async () => {
    const apiUsage = {
      input_tokens: 42,
      output_tokens: 314,
      total_tokens: 356,
    };
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'task-1',
        status: 'completed',
        model: 'gpt-5.6-sol',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Deep answer.' }],
          },
        ],
        usage: apiUsage,
      }),
    );

    const provider = new OpenAIResearchProvider({
      credentials: { env: { OPENAI_API_KEY: 'openai-key' } },
    });
    const result = await provider.retrieve({
      provider: 'openai-research',
      taskId: 'task-1',
      query: 'deep question',
      submittedAt: Date.now(),
      status: 'completed',
    });

    expect(result.error).toBeUndefined();
    expect(result.tokenUsage).toEqual({ input: 42, output: 314 });
    expect(result.usage).toEqual({
      inputTokens: 42,
      outputTokens: 314,
      totalTokens: 356,
      raw: apiUsage,
    });
    expect(result.usage?.costUsd).toBeUndefined();
  });

  it('extracts Gemini deep Interactions usage', async () => {
    const usage = {
      total_input_tokens: 9,
      total_output_tokens: 21,
      total_tokens: 30,
    };
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'int-1',
        status: 'completed',
        output_text: 'Gemini deep findings.',
        usage,
      }),
    );

    const provider = new GeminiDeepProvider();
    provider.configure({
      credentials: { env: { GEMINI_API_KEY: 'gemini-key' } },
    });
    const result = await provider.retrieve({
      provider: 'gemini-deep',
      taskId: 'int-1',
      query: 'question',
      submittedAt: Date.now(),
      status: 'running',
    });

    expect(result.error).toBeUndefined();
    expect(result.tokenUsage).toEqual({ input: 9, output: 21 });
    expect(result.usage).toEqual({
      inputTokens: 9,
      outputTokens: 21,
      totalTokens: 30,
      raw: usage,
    });
    expect(result.usage?.costUsd).toBeUndefined();
  });

  it('extracts Gemini grounded usage metadata', async () => {
    const usageMetadata = {
      promptTokenCount: 4,
      candidatesTokenCount: 16,
      totalTokenCount: 20,
    };
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'Grounded answer.' }] } }],
        usageMetadata,
      }),
    );

    const provider = new GeminiGroundedProvider({
      credentials: { env: { GEMINI_API_KEY: 'gemini-key' } },
    });
    const result = await provider.execute('question', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.usage).toEqual({
      inputTokens: 4,
      outputTokens: 16,
      totalTokens: 20,
      raw: usageMetadata,
    });
  });

  it('extracts OpenRouter token usage and reported cost', async () => {
    const apiUsage = {
      prompt_tokens: 7,
      completion_tokens: 13,
      total_tokens: 20,
      cost: 0.00045,
    };
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'openai/gpt-4o-mini',
        choices: [
          {
            message: {
              content: 'Online answer.',
              annotations: [
                {
                  type: 'url_citation',
                  url_citation: { url: 'https://source.example/one' },
                },
              ],
            },
          },
        ],
        usage: apiUsage,
      }),
    );

    const provider = new OpenRouterOnlineProvider({
      credentials: { env: { OPENROUTER_API_KEY: 'openrouter-key' } },
    });
    const result = await provider.execute('question', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.tokenUsage).toEqual({ input: 7, output: 13 });
    expect(result.usage).toEqual({
      inputTokens: 7,
      outputTokens: 13,
      totalTokens: 20,
      costUsd: 0.00045,
    });
  });

  it('extracts Exa reported dollar cost', async () => {
    const costDollars = { total: 0.01 };
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        requestId: 'exa-1',
        results: [
          { url: 'https://example.com', title: 'Example', text: 'Body text' },
        ],
        costDollars,
      }),
    );

    const provider = new ExaProvider({
      credentials: { env: { EXA_API_KEY: 'exa-key' } },
    });
    const result = await provider.execute('question', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.usage).toEqual({
      costUsd: 0.01,
      raw: costDollars,
    });
    expect(result.usage?.inputTokens).toBeUndefined();
  });

  it('omits Exa usage when the response carries no cost', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        requestId: 'exa-2',
        results: [{ url: 'https://example.com', title: 'Example' }],
      }),
    );

    const provider = new ExaProvider({
      credentials: { env: { EXA_API_KEY: 'exa-key' } },
    });
    const result = await provider.execute('question', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.usage).toBeUndefined();
  });

  it('leaves usage unset for raw-search providers without usage data', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        query: 'question',
        results: [
          {
            url: 'https://example.com',
            title: 'Example',
            content: 'Snippet',
          },
        ],
      }),
    );

    const provider = new TavilyProvider({
      credentials: { env: { TAVILY_API_KEY: 'tavily-key' } },
    });
    const result = await provider.execute('question', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.usage).toBeUndefined();
    expect(result.tokenUsage).toBeUndefined();
  });
});
