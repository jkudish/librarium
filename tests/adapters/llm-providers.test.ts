import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeProvider } from '../../src/adapters/claude.js';
import { GeminiChatProvider } from '../../src/adapters/gemini-chat.js';
import { OpenAIChatProvider } from '../../src/adapters/openai-chat.js';
import { OpenRouterChatProvider } from '../../src/adapters/openrouter-chat.js';

function jsonResponse(status: number, data: unknown): Response {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers({}),
    text: async () => JSON.stringify(data),
  } as Response;
}

describe('llm providers', () => {
  const originalFetch = globalThis.fetch;

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Claude (Anthropic Messages API) ---

  it('calls the Anthropic Messages API with web search and extracts citations', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'claude-sonnet-5',
        content: [
          {
            type: 'text',
            text: 'Direct answer.',
            citations: [
              {
                type: 'web_search_result_location',
                url: 'https://example.com/claude',
                title: 'Claude Source',
                cited_text: 'Quoted context.',
              },
            ],
          },
          { type: 'text', text: 'Second block.' },
        ],
        usage: { input_tokens: 5, output_tokens: 9 },
      }),
    );
    globalThis.fetch = fetchMock;

    const provider = new ClaudeProvider({
      credentials: { env: { ANTHROPIC_API_KEY: 'anthropic-key' } },
    });
    const result = await provider.execute('what is rust?', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.provider).toBe('claude');
    expect(result.tier).toBe('llm');
    expect(result.content).toBe('Direct answer.\nSecond block.');
    expect(result.citations).toEqual([
      {
        url: 'https://example.com/claude',
        title: 'Claude Source',
        snippet: 'Quoted context.',
        provider: 'claude',
      },
    ]);
    expect(result.model).toBe('claude-sonnet-5');
    expect(result.usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 9,
      totalTokens: 14,
    });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = options.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('anthropic-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(options.body as string)).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 16000,
      messages: [{ role: 'user', content: 'what is rust?' }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    });
  });

  it('honors the Claude model config override', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    globalThis.fetch = fetchMock;

    const provider = new ClaudeProvider({
      model: 'claude-opus-4-8',
      credentials: { env: { ANTHROPIC_API_KEY: 'anthropic-key' } },
    });
    await provider.execute('hi', { timeout: 10 });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toEqual({
      model: 'claude-opus-4-8',
      max_tokens: 16000,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    });
  });

  it('applies explicit Claude thinking, effort, and output options', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'ok' }],
      }),
    );
    globalThis.fetch = fetchMock;

    const provider = new ClaudeProvider({
      maxTokens: 32000,
      thinking: 'disabled',
      effort: 'low',
      webSearch: false,
      credentials: { env: { ANTHROPIC_API_KEY: 'anthropic-key' } },
    });
    await provider.execute('hi', { timeout: 10 });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 32000,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
    });
  });

  it('rejects invalid Claude options before making a paid request', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    for (const options of [
      { maxTokens: 0 },
      { thinking: 'enabled' },
      { effort: 'adaptive' },
    ]) {
      const provider = new ClaudeProvider({
        ...options,
        credentials: { env: { ANTHROPIC_API_KEY: 'anthropic-key' } },
      });
      await expect(
        provider.execute('hi', { timeout: 10 }),
      ).resolves.toMatchObject({ error: expect.any(String) });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces Claude API errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, {
        error: { type: 'invalid_request_error', message: 'bad model' },
      }),
    );

    const provider = new ClaudeProvider({
      credentials: { env: { ANTHROPIC_API_KEY: 'anthropic-key' } },
    });
    const result = await provider.execute('hi', { timeout: 10 });

    expect(result.content).toBe('');
    expect(result.citations).toEqual([]);
    expect(result.error).toBe('bad model');
  });

  // --- OpenAI Responses API / chat completions ---

  it('calls OpenAI Responses API with web search and extracts citations', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'gpt-5-mini',
        output: [
          {
            type: 'web_search_call',
            status: 'completed',
          },
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'OpenAI answer.',
                annotations: [
                  {
                    type: 'url_citation',
                    url: 'https://example.com/openai',
                    title: 'OpenAI Source',
                  },
                ],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 4,
          output_tokens: 6,
          total_tokens: 10,
        },
      }),
    );
    globalThis.fetch = fetchMock;

    const provider = new OpenAIChatProvider({
      credentials: { env: { OPENAI_API_KEY: 'openai-key' } },
    });
    const result = await provider.execute('hello', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.provider).toBe('openai-chat');
    expect(result.tier).toBe('llm');
    expect(result.content).toBe('OpenAI answer.');
    expect(result.citations).toEqual([
      {
        url: 'https://example.com/openai',
        title: 'OpenAI Source',
        provider: 'openai-chat',
      },
    ]);
    expect(result.usage).toMatchObject({
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
    });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect((options.headers as Record<string, string>).Authorization).toBe(
      'Bearer openai-key',
    );
    expect(JSON.parse(options.body as string)).toEqual({
      model: 'gpt-5-mini',
      input: 'hello',
      tools: [{ type: 'web_search' }],
      tool_choice: 'auto',
    });
  });

  it('can disable OpenAI web search and use chat completions', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'gpt-5-mini',
        choices: [{ message: { content: 'OpenAI answer.' } }],
      }),
    );
    globalThis.fetch = fetchMock;

    const provider = new OpenAIChatProvider({
      webSearch: false,
      credentials: { env: { OPENAI_API_KEY: 'openai-key' } },
    });
    const result = await provider.execute('hello', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.content).toBe('OpenAI answer.');

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(JSON.parse(options.body as string)).toEqual({
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('surfaces OpenAI API errors (non-retryable status)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, {
        error: { type: 'invalid_request_error', message: 'unknown model' },
      }),
    );

    const provider = new OpenAIChatProvider({
      webSearch: false,
      credentials: { env: { OPENAI_API_KEY: 'openai-key' } },
    });
    const result = await provider.execute('hi', { timeout: 10 });

    expect(result.content).toBe('');
    expect(result.error).toBe('unknown model');
  });

  // --- Gemini chat ---

  it('calls Gemini generateContent with Google Search and extracts citations', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        candidates: [
          {
            content: { parts: [{ text: 'Gemini answer.' }] },
            groundingMetadata: {
              groundingChunks: [
                {
                  web: {
                    uri: 'https://example.com/gemini',
                    title: 'Gemini Source',
                  },
                },
              ],
              groundingSupports: [
                {
                  segment: { text: 'Gemini answer.' },
                  groundingChunkIndices: [0],
                },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 3,
          candidatesTokenCount: 7,
          totalTokenCount: 10,
        },
        modelVersion: 'gemini-3.6-flash',
      }),
    );
    globalThis.fetch = fetchMock;

    const provider = new GeminiChatProvider({
      credentials: { env: { GEMINI_API_KEY: 'gemini-key' } },
    });
    const result = await provider.execute('explain x', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.provider).toBe('gemini-chat');
    expect(result.tier).toBe('llm');
    expect(result.content).toBe('Gemini answer.');
    expect(result.citations).toEqual([
      {
        url: 'https://example.com/gemini',
        title: 'Gemini Source',
        snippet: 'Gemini answer.',
        provider: 'gemini-chat',
      },
    ]);
    expect(result.usage).toMatchObject({
      inputTokens: 3,
      outputTokens: 7,
      totalTokens: 10,
    });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('models/gemini-3.6-flash:generateContent');
    // The API key travels in the x-goog-api-key header, never the URL.
    expect(url).not.toContain('key=');
    expect(url).not.toContain('gemini-key');
    expect((options.headers as Record<string, string>)['x-goog-api-key']).toBe(
      'gemini-key',
    );
    expect(JSON.parse(options.body as string)).toEqual({
      contents: [{ parts: [{ text: 'explain x' }] }],
      tools: [{ googleSearch: {} }],
    });
  });

  it('surfaces Gemini errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        error: { code: 400, message: 'API key not valid' },
      }),
    );

    const provider = new GeminiChatProvider({
      credentials: { env: { GEMINI_API_KEY: 'gemini-key' } },
    });
    const result = await provider.execute('hi', { timeout: 10 });

    expect(result.content).toBe('');
    expect(result.error).toContain('API key not valid');
  });

  // --- OpenRouter chat (with cost accounting) ---

  it('calls OpenRouter chat with documented web search and citations', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'openai/gpt-5.6-terra',
        choices: [
          {
            message: {
              content: 'OpenRouter answer.',
              annotations: [
                {
                  type: 'url_citation',
                  url_citation: {
                    url: 'https://example.com/openrouter',
                    title: 'OpenRouter Source',
                    content: 'Source excerpt.',
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 8,
          total_tokens: 12,
          cost: 0.000123,
        },
      }),
    );
    globalThis.fetch = fetchMock;

    const provider = new OpenRouterChatProvider({
      credentials: { env: { OPENROUTER_API_KEY: 'openrouter-key' } },
    });
    const result = await provider.execute('hello', { timeout: 10 });

    expect(result.error).toBeUndefined();
    expect(result.provider).toBe('openrouter-chat');
    expect(result.tier).toBe('llm');
    expect(result.content).toBe('OpenRouter answer.');
    expect(result.citations).toEqual([
      {
        url: 'https://example.com/openrouter',
        title: 'OpenRouter Source',
        snippet: 'Source excerpt.',
        provider: 'openrouter-chat',
      },
    ]);
    expect(result.usage).toMatchObject({
      inputTokens: 4,
      outputTokens: 8,
      totalTokens: 12,
      costUsd: 0.000123,
    });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((options.headers as Record<string, string>).Authorization).toBe(
      'Bearer openrouter-key',
    );
    expect(JSON.parse(options.body as string)).toEqual({
      model: 'openai/gpt-5.6-terra',
      messages: [{ role: 'user', content: 'hello' }],
      plugins: [{ id: 'web' }],
    });
  });

  it('can disable OpenRouter web search without mutating the selected model', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'anthropic/claude-sonnet-5',
        choices: [{ message: { content: 'Direct answer.' } }],
      }),
    );
    globalThis.fetch = fetchMock;

    const provider = new OpenRouterChatProvider({
      model: 'anthropic/claude-sonnet-5',
      webSearch: false,
      credentials: { env: { OPENROUTER_API_KEY: 'openrouter-key' } },
    });
    const result = await provider.execute('hello', { timeout: 10 });

    expect(result.error).toBeUndefined();
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toEqual({
      model: 'anthropic/claude-sonnet-5',
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('sends only documented OpenRouter routing, privacy, and reasoning fields', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'openai/gpt-5.6-terra',
        choices: [{ message: { content: 'Configured answer.' } }],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 8,
          total_tokens: 12,
          prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
          completion_tokens_details: { reasoning_tokens: 3 },
          server_tool_use: { web_search_requests: 1 },
          cost: 0.000123,
        },
      }),
    );
    globalThis.fetch = fetchMock;

    const provider = new OpenRouterChatProvider({
      credentials: { env: { OPENROUTER_API_KEY: 'openrouter-key' } },
      providerOrder: ['openai', 'azure'],
      allowFallbacks: false,
      requireParameters: true,
      dataCollection: 'deny',
      reasoningEffort: 'high',
      reasoningExclude: true,
    });
    const result = await provider.execute('hello', { timeout: 10 });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body as string)).toEqual({
      model: 'openai/gpt-5.6-terra',
      messages: [{ role: 'user', content: 'hello' }],
      plugins: [{ id: 'web' }],
      provider: {
        order: ['openai', 'azure'],
        allow_fallbacks: false,
        require_parameters: true,
        data_collection: 'deny',
      },
      reasoning: { effort: 'high', exclude: true },
    });
    expect(result.usage).toMatchObject({
      cacheReadInputTokens: 2,
      cacheWriteInputTokens: 1,
      reasoningTokens: 3,
    });
    expect(result.providerMeta).toEqual({
      'openrouter:profile': 'chat',
      'openrouter:search': { enabled: true, requests: 1 },
      'openrouter:routing': {
        order: ['openai', 'azure'],
        allow_fallbacks: false,
        require_parameters: true,
        data_collection: 'deny',
      },
      'openrouter:reasoning': { effort: 'high', exclude: true, tokens: 3 },
    });
  });

  it('rejects contradictory reasoning choices before OpenRouter dispatch', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    expect(
      () =>
        new OpenRouterChatProvider({
          reasoningEffort: 'high',
          reasoningMaxTokens: 100,
          credentials: { env: { OPENROUTER_API_KEY: 'openrouter-key' } },
        }),
    ).toThrow('mutually exclusive');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows OpenRouter ZDR only when optional web search is disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        choices: [{ message: { content: 'Private answer.' } }],
      }),
    );
    globalThis.fetch = fetchMock;

    const provider = new OpenRouterChatProvider({
      webSearch: false,
      zdr: true,
      credentials: { env: { OPENROUTER_API_KEY: 'openrouter-key' } },
    });
    await provider.execute('hello', { timeout: 10 });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body as string)).toEqual({
      model: 'openai/gpt-5.6-terra',
      messages: [{ role: 'user', content: 'hello' }],
      provider: { zdr: true },
    });
  });

  it('surfaces OpenRouter errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        error: { message: 'No endpoints found' },
      }),
    );

    const provider = new OpenRouterChatProvider({
      credentials: { env: { OPENROUTER_API_KEY: 'openrouter-key' } },
    });
    const result = await provider.execute('hi', { timeout: 10 });

    expect(result.content).toBe('');
    expect(result.error).toBe('No endpoints found');
  });

  it('shapes network errors through the shared catch helper', async () => {
    // TypeError (fetch failed) is not retried by the http client, so a single
    // rejection is enough and the call returns immediately.
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    const provider = new ClaudeProvider({
      credentials: { env: { ANTHROPIC_API_KEY: 'anthropic-key' } },
    });
    const result = await provider.execute('hi', { timeout: 10 });

    expect(result.error).toContain('Network error');
  });

  // --- Empty / blocked 200 responses are errors, not successes ---

  it('treats an empty Claude response as an error with the stop_reason', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'claude-haiku-4-5',
        content: [],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 5, output_tokens: 0 },
      }),
    );

    const provider = new ClaudeProvider({
      credentials: { env: { ANTHROPIC_API_KEY: 'anthropic-key' } },
    });
    const result = await provider.execute('hi', { timeout: 10 });

    expect(result.content).toBe('');
    expect(result.error).toContain('empty response');
    expect(result.error).toContain('stop_reason: max_tokens');
  });

  it('treats a Claude response with no content field as an error', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { model: 'claude-haiku-4-5' }));

    const provider = new ClaudeProvider({
      credentials: { env: { ANTHROPIC_API_KEY: 'anthropic-key' } },
    });
    const result = await provider.execute('hi', { timeout: 10 });

    expect(result.error).toContain('empty response');
    expect(result.error).toContain('no content blocks returned');
  });

  it('treats an empty OpenAI response as an error with the finish_reason', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'gpt-5-mini',
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
      }),
    );

    const provider = new OpenAIChatProvider({
      webSearch: false,
      credentials: { env: { OPENAI_API_KEY: 'openai-key' } },
    });
    const result = await provider.execute('hi', { timeout: 10 });

    expect(result.content).toBe('');
    expect(result.error).toContain('empty response');
    expect(result.error).toContain('finish_reason: length');
  });

  it('surfaces an OpenAI refusal instead of an empty success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'gpt-5-mini',
        choices: [
          {
            message: { content: '', refusal: 'I cannot help with that.' },
            finish_reason: 'stop',
          },
        ],
      }),
    );

    const provider = new OpenAIChatProvider({
      webSearch: false,
      credentials: { env: { OPENAI_API_KEY: 'openai-key' } },
    });
    const result = await provider.execute('hi', { timeout: 10 });

    expect(result.error).toContain('refusal: I cannot help with that.');
  });

  it('treats an OpenAI response with no choices as an error', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { model: 'gpt-5-mini' }));

    const provider = new OpenAIChatProvider({
      webSearch: false,
      credentials: { env: { OPENAI_API_KEY: 'openai-key' } },
    });
    const result = await provider.execute('hi', { timeout: 10 });

    expect(result.error).toContain('no choices returned');
  });

  it('treats a Gemini safety block as an error with the block reason', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        promptFeedback: {
          blockReason: 'SAFETY',
          blockReasonMessage: 'Blocked by safety settings.',
        },
      }),
    );

    const provider = new GeminiChatProvider({
      credentials: { env: { GEMINI_API_KEY: 'gemini-key' } },
    });
    const result = await provider.execute('hi', { timeout: 10 });

    expect(result.content).toBe('');
    expect(result.error).toContain('empty response');
    expect(result.error).toContain('blocked: SAFETY');
    expect(result.error).toContain('Blocked by safety settings.');
  });

  it('treats an empty Gemini candidate as an error with the finishReason', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        candidates: [
          {
            content: { parts: [] },
            finishReason: 'RECITATION',
            finishMessage: 'Response stopped for recitation.',
          },
        ],
      }),
    );

    const provider = new GeminiChatProvider({
      credentials: { env: { GEMINI_API_KEY: 'gemini-key' } },
    });
    const result = await provider.execute('hi', { timeout: 10 });

    expect(result.error).toContain('finishReason: RECITATION');
    expect(result.error).toContain('Response stopped for recitation.');
  });

  it('treats a Gemini response with no candidates as an error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));

    const provider = new GeminiChatProvider({
      credentials: { env: { GEMINI_API_KEY: 'gemini-key' } },
    });
    const result = await provider.execute('hi', { timeout: 10 });

    expect(result.error).toContain('no candidates returned');
  });

  it('treats an empty OpenRouter response as an error with the finish_reason', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'openai/gpt-4o-mini',
        choices: [
          { message: { content: '' }, finish_reason: 'content_filter' },
        ],
      }),
    );

    const provider = new OpenRouterChatProvider({
      credentials: { env: { OPENROUTER_API_KEY: 'openrouter-key' } },
    });
    const result = await provider.execute('hi', { timeout: 10 });

    expect(result.content).toBe('');
    expect(result.error).toContain('empty response');
    expect(result.error).toContain('finish_reason: content_filter');
  });

  it('surfaces an OpenRouter refusal instead of an empty success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'openai/gpt-4o-mini',
        choices: [
          {
            message: { content: '', refusal: 'Refused by policy.' },
            finish_reason: 'stop',
          },
        ],
      }),
    );

    const provider = new OpenRouterChatProvider({
      credentials: { env: { OPENROUTER_API_KEY: 'openrouter-key' } },
    });
    const result = await provider.execute('hi', { timeout: 10 });

    expect(result.error).toContain('refusal: Refused by policy.');
  });
});
