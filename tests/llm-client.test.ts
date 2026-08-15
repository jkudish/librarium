import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  callWithCascade,
  formatLlmHttpError,
  type LlmClient,
  preferenceFromConfig,
  resolveLlmClients,
} from '../src/commands/llm-client.js';
import type { Config } from '../src/types.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    defaults: {
      outputDir: './agents/librarium',
      maxParallel: 6,
      timeout: 30,
      asyncTimeout: 1800,
      asyncPollInterval: 10,
      mode: 'mixed',
      llmWebSearch: true,
    },
    providers: {},
    customProviders: {},
    trustedProviderIds: [],
    groups: {},
    ...overrides,
  };
}

describe('resolveLlmClients', () => {
  it('prefers openai, then gemini, then perplexity by available key', () => {
    expect(
      resolveLlmClients(undefined, {
        OPENAI_API_KEY: 'a',
        GEMINI_API_KEY: 'b',
      }).map((c) => c.provider),
    ).toEqual(['openai', 'gemini']);
    expect(
      resolveLlmClients(undefined, { PERPLEXITY_API_KEY: 'c' }).map(
        (c) => c.provider,
      ),
    ).toEqual(['perplexity']);
  });

  it('pins to a single provider and applies the model to the first only', () => {
    const clients = resolveLlmClients(
      { provider: 'gemini', model: 'gemini-custom' },
      { OPENAI_API_KEY: 'a', GEMINI_API_KEY: 'b', PERPLEXITY_API_KEY: 'c' },
    );
    expect(clients).toHaveLength(1);
    expect(clients[0]?.provider).toBe('gemini');
    expect(clients[0]?.model).toBe('gemini-custom');
  });

  it('model override only applies to the first client in a cascade', () => {
    const clients = resolveLlmClients(
      { model: 'custom' },
      { OPENAI_API_KEY: 'a', GEMINI_API_KEY: 'b' },
    );
    expect(clients[0]?.model).toBe('custom');
    expect(clients[1]?.model).toBe('gemini-2.5-flash');
  });

  it('resolves configured provider credentials when env vars are absent', () => {
    const config = makeConfig({
      providers: {
        'openai-chat': {
          enabled: true,
          apiKey: 'literal-openai-key',
        },
      },
    });

    const clients = resolveLlmClients(undefined, { env: {}, config });

    expect(clients).toEqual([
      {
        provider: 'openai',
        model: 'gpt-5-mini',
        apiKey: 'literal-openai-key',
      },
    ]);
  });

  it('resolves keychain-backed provider credentials', () => {
    const config = makeConfig({
      providers: {
        'gemini-grounded': {
          enabled: true,
          apiKey: 'keychain:GEMINI_API_KEY',
        },
      },
    });

    const clients = resolveLlmClients(undefined, {
      env: {},
      config,
      credentials: {
        resolveCredential: (ref) =>
          ref === 'keychain:GEMINI_API_KEY' ? 'gemini-keychain-key' : undefined,
      },
    });

    expect(clients).toEqual([
      {
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        apiKey: 'gemini-keychain-key',
      },
    ]);
  });
});

describe('preferenceFromConfig (answer falls back to refine)', () => {
  it('uses the answer key when set', () => {
    const config = makeConfig({
      answer: { provider: 'perplexity' },
      refine: { provider: 'openai' },
    });
    expect(preferenceFromConfig(config, 'answer', 'refine')?.provider).toBe(
      'perplexity',
    );
  });

  it('falls back to the refine key when answer is unset', () => {
    const config = makeConfig({ refine: { provider: 'gemini' } });
    expect(preferenceFromConfig(config, 'answer', 'refine')?.provider).toBe(
      'gemini',
    );
  });

  it('returns undefined when neither key is set', () => {
    expect(
      preferenceFromConfig(makeConfig(), 'answer', 'refine'),
    ).toBeUndefined();
  });

  it('does not fall back when answer is set but only has a model', () => {
    const config = makeConfig({
      answer: { model: 'gpt-5' },
      refine: { provider: 'perplexity' },
    });
    const pref = preferenceFromConfig(config, 'answer', 'refine');
    expect(pref?.model).toBe('gpt-5');
    expect(pref?.provider).toBeUndefined();
  });
});

describe('formatLlmHttpError', () => {
  it('uses the supplied action word', () => {
    const msg = formatLlmHttpError(
      'OpenAI',
      'synthesis',
      429,
      JSON.stringify({
        error: { message: 'quota', code: 'insufficient_quota' },
      }),
    );
    expect(msg).toContain('OpenAI synthesis call failed: HTTP 429');
    expect(msg).toContain('insufficient_quota');
  });
});

describe('callWithCascade', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(
    handler: (url: string) => { status: number; body: unknown },
  ): () => string[] {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        const { status, body } = handler(url);
        return new Response(JSON.stringify(body), { status });
      }),
    );
    return () => calls;
  }

  const clients: LlmClient[] = [
    { provider: 'openai', model: 'gpt-5-mini', apiKey: 'a' },
    { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'b' },
  ];

  it('returns the first client text and cascades on failure', async () => {
    const getCalls = stubFetch((url) =>
      url.includes('openai.com')
        ? { status: 500, body: { error: { message: 'down' } } }
        : {
            status: 200,
            body: {
              candidates: [{ content: { parts: [{ text: 'answer' }] } }],
            },
          },
    );
    const warnings: string[] = [];
    const { client, result } = await callWithCascade<string>({
      clients,
      prompt: 'p',
      action: 'synthesis',
      timeoutMs: 1000,
      json: false,
      onWarning: (w) => warnings.push(w),
    });
    expect(result).toBe('answer');
    expect(client.provider).toBe('gemini');
    expect(getCalls()).toHaveLength(2);
    expect(warnings[0]).toContain('trying gemini');
  });

  it('throws the last error when every client fails', async () => {
    stubFetch(() => ({ status: 500, body: { error: { message: 'down' } } }));
    await expect(
      callWithCascade<string>({
        clients,
        prompt: 'p',
        action: 'synthesis',
        timeoutMs: 1000,
        json: false,
      }),
    ).rejects.toThrow(/Gemini synthesis call failed: HTTP 500/);
  });

  it('treats a parse throw as a failure and cascades', async () => {
    const getCalls = stubFetch(() => ({
      status: 200,
      body: { choices: [{ message: { content: 'bad' } }] },
    }));
    await expect(
      callWithCascade<{ ok: boolean }>({
        clients: [clients[0] as LlmClient],
        prompt: 'p',
        action: 'synthesis',
        timeoutMs: 1000,
        json: true,
        parse: () => {
          throw new Error('unparseable');
        },
      }),
    ).rejects.toThrow(/unparseable/);
    expect(getCalls()).toHaveLength(1);
  });

  it.each([
    ['fast', 'fast'],
    ['fast-search', 'fast'],
    ['sonar', 'fast'],
    ['sonar-pro', 'low'],
    ['pro-search', 'low'],
    ['sonar-reasoning-pro', 'medium'],
    ['deep-research', 'medium'],
    ['sonar-deep-research', 'high'],
    ['advanced-deep-research', 'high'],
    ['ultra', 'xhigh'],
  ] as const)(
    'maps legacy Perplexity target %s to Agent preset %s',
    async (model, preset) => {
      let requestBody: unknown;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          requestBody = JSON.parse(init.body as string);
          return new Response(
            JSON.stringify({
              id: 'agent-llm-test',
              status: 'completed',
              model: 'openai/gpt-5.6-luna',
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: 'ok' }],
                },
              ],
            }),
            { status: url.includes('/v1/agent') ? 200 : 500 },
          );
        }),
      );

      const { result } = await callWithCascade({
        clients: [{ provider: 'perplexity', model, apiKey: 'synthetic' }],
        prompt: 'prompt',
        action: 'synthesis',
        timeoutMs: 1000,
        json: false,
      });

      expect(result).toBe('ok');
      expect(requestBody).toEqual({ input: 'prompt', preset });
    },
  );
});
