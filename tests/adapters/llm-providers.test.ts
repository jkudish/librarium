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

describe('llm providers (ungrounded)', () => {
  const originalFetch = globalThis.fetch;

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Claude (Anthropic Messages API) ---

  it('calls the Anthropic Messages API and returns no citations', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'claude-haiku-4-5',
        content: [
          { type: 'text', text: 'Direct answer.' },
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
    expect(result.citations).toEqual([]);
    expect(result.model).toBe('claude-haiku-4-5');
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
      model: 'claude-haiku-4-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'what is rust?' }],
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
    expect(JSON.parse(options.body as string).model).toBe('claude-opus-4-8');
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

  // --- OpenAI chat completions ---

  it('calls OpenAI chat completions and returns no citations', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'gpt-5-mini',
        choices: [{ message: { content: 'OpenAI answer.' } }],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 6,
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
    expect(result.citations).toEqual([]);
    expect(result.usage).toMatchObject({
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
    });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((options.headers as Record<string, string>).Authorization).toBe(
      'Bearer openai-key',
    );
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
      credentials: { env: { OPENAI_API_KEY: 'openai-key' } },
    });
    const result = await provider.execute('hi', { timeout: 10 });

    expect(result.content).toBe('');
    expect(result.error).toBe('unknown model');
  });

  // --- Gemini chat (ungrounded generateContent, no googleSearch tool) ---

  it('calls Gemini generateContent without grounding and returns no citations', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'Gemini answer.' }] } }],
        usageMetadata: {
          promptTokenCount: 3,
          candidatesTokenCount: 7,
          totalTokenCount: 10,
        },
        modelVersion: 'gemini-2.5-flash',
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
    expect(result.citations).toEqual([]);
    expect(result.usage).toMatchObject({
      inputTokens: 3,
      outputTokens: 7,
      totalTokens: 10,
    });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('models/gemini-2.5-flash:generateContent');
    // The API key travels in the x-goog-api-key header, never the URL.
    expect(url).not.toContain('key=');
    expect(url).not.toContain('gemini-key');
    expect((options.headers as Record<string, string>)['x-goog-api-key']).toBe(
      'gemini-key',
    );
    // No googleSearch tool -- this is the ungrounded path.
    expect(JSON.parse(options.body as string)).toEqual({
      contents: [{ parts: [{ text: 'explain x' }] }],
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

  // --- OpenRouter chat (ungrounded, with cost accounting) ---

  it('calls OpenRouter chat with usage accounting and extracts cost', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        model: 'openai/gpt-4o-mini',
        choices: [{ message: { content: 'OpenRouter answer.' } }],
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
    expect(result.citations).toEqual([]);
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
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
      usage: { include: true },
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
