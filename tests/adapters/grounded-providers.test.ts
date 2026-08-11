import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiGroundedProvider } from '../../src/adapters/gemini-grounded.js';
import { OpenRouterOnlineProvider } from '../../src/adapters/openrouter-online.js';
import { PerplexityAdvancedDeepProvider } from '../../src/adapters/perplexity-advanced-deep.js';
import { PerplexityDeepResearchProvider } from '../../src/adapters/perplexity-deep-research.js';

function jsonResponse(status: number, data: unknown): Response {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers({}),
    text: async () => JSON.stringify(data),
  } as Response;
}

describe('grounded providers', () => {
  const originalFetch = globalThis.fetch;

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls Gemini grounded search and extracts grounding citations', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        candidates: [
          {
            content: {
              parts: [{ text: 'Grounded answer.' }],
            },
            groundingMetadata: {
              groundingChunks: [
                {
                  web: {
                    uri: 'https://example.com/a',
                    title: 'Example A',
                  },
                },
                {
                  web: {
                    uri: 'https://example.com/a',
                    title: 'Duplicate',
                  },
                },
                {
                  web: {
                    uri: 'https://example.com/b',
                    title: 'Example B',
                  },
                },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 3,
          candidatesTokenCount: 7,
        },
      }),
    );
    globalThis.fetch = fetchMock;

    const provider = new GeminiGroundedProvider({
      credentials: { env: { GEMINI_API_KEY: 'gemini-key' } },
    });
    const result = await provider.execute('who is cited?', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.provider).toBe('gemini-grounded');
    expect(result.model).toBe('gemini-2.5-flash');
    expect(result.content).toBe('Grounded answer.');
    expect(result.citations).toEqual([
      {
        url: 'https://example.com/a',
        title: 'Example A',
        provider: 'gemini-grounded',
      },
      {
        url: 'https://example.com/b',
        title: 'Example B',
        provider: 'gemini-grounded',
      },
    ]);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(
      'models/gemini-2.5-flash:generateContent?key=gemini-key',
    );
    expect(JSON.parse(options.body as string)).toEqual({
      contents: [{ parts: [{ text: 'who is cited?' }] }],
      tools: [{ googleSearch: {} }],
    });
  });

  it('calls OpenRouter online search and extracts URL annotations', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'openai/gpt-4o-mini',
        choices: [
          {
            message: {
              content: 'Online answer.',
              annotations: [
                {
                  type: 'url_citation',
                  url_citation: {
                    url: 'https://source.example/one',
                    title: 'Source One',
                    content: 'Excerpt one',
                  },
                },
                {
                  type: 'other',
                },
                {
                  type: 'url_citation',
                  url_citation: {
                    url: 'https://source.example/two',
                    title: 'Source Two',
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 8,
        },
      }),
    );
    globalThis.fetch = fetchMock;

    const provider = new OpenRouterOnlineProvider({
      credentials: { env: { OPENROUTER_API_KEY: 'openrouter-key' } },
    });
    const result = await provider.execute('search online', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.provider).toBe('openrouter-online');
    expect(result.content).toBe('Online answer.');
    expect(result.citations).toEqual([
      {
        url: 'https://source.example/one',
        title: 'Source One',
        snippet: 'Excerpt one',
        provider: 'openrouter-online',
      },
      {
        url: 'https://source.example/two',
        title: 'Source Two',
        provider: 'openrouter-online',
      },
    ]);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((options.headers as Record<string, string>).Authorization).toBe(
      'Bearer openrouter-key',
    );
    expect(JSON.parse(options.body as string)).toEqual({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'search online' }],
      tools: [{ type: 'openrouter:web_search' }],
    });
  });

  it('fails OpenRouter online responses without annotations', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        choices: [{ message: { content: 'Ungrounded answer.' } }],
      }),
    );

    const provider = new OpenRouterOnlineProvider({
      credentials: { env: { OPENROUTER_API_KEY: 'openrouter-key' } },
    });
    const result = await provider.execute('search online', { timeout: 10 });

    expect(result.content).toBe('');
    expect(result.citations).toEqual([]);
    expect(result.error).toContain('annotations');
  });

  it.each([
    [
      'Gemini grounded',
      new GeminiGroundedProvider({
        credentials: { env: { GEMINI_API_KEY: 'gemini-key' } },
        model: 'gemini-2.5-pro',
      }),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=gemini-key',
    ],
    [
      'OpenRouter online',
      new OpenRouterOnlineProvider({
        credentials: { env: { OPENROUTER_API_KEY: 'openrouter-key' } },
        model: 'openai/gpt-4o',
      }),
      'https://openrouter.ai/api/v1/chat/completions',
    ],
  ] as const)(
    'threads a configured compatible model through %s',
    async (_name, provider, expectedUrl) => {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        jsonResponse(200, {
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
          choices: [
            {
              message: {
                content: 'ok',
                annotations: [],
              },
            },
          ],
        }),
      );
      globalThis.fetch = fetchMock;

      await provider.execute('configured target', { timeout: 10 });
      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(expectedUrl);
      const body = JSON.parse(options.body as string) as { model?: string };
      expect(body.model).toBe(
        provider.id === 'gemini-grounded' ? undefined : 'openai/gpt-4o',
      );
    },
  );

  it.each([
    [PerplexityDeepResearchProvider, 'deep-research'],
    [PerplexityAdvancedDeepProvider, 'advanced-deep-research'],
  ] as const)(
    'keeps the %s preset separate from an optional model and omits an unreported model',
    async (Provider, preset) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(200, { id: 'agent-1', status: 'completed', output: [] }),
        );
      globalThis.fetch = fetchMock;
      const provider = new Provider({
        credentials: { env: { PERPLEXITY_API_KEY: 'perplexity-key' } },
        model: 'sonar-pro',
      });

      const result = await provider.execute('deep query', { timeout: 10 });
      expect(result).not.toHaveProperty('model');
      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(options.body as string)).toEqual({
        preset,
        model: 'sonar-pro',
        input: 'deep query',
      });
    },
  );

  it('threads the configured Perplexity model through its credential check request', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
    globalThis.fetch = fetchMock;
    const provider = new PerplexityDeepResearchProvider({
      credentials: { env: { PERPLEXITY_API_KEY: 'perplexity-key' } },
      model: 'sonar-pro',
    });

    await expect(provider.test()).resolves.toEqual({ ok: true });
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toEqual({
      preset: 'deep-research',
      model: 'sonar-pro',
      input: 'ping',
    });
  });
});
