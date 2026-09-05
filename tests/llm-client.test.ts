import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  callWithCascade,
  formatLlmHttpError,
  type LlmClient,
  preferenceFromConfig,
  resolveLlmClients,
} from '../src/commands/llm-client.js';
import { paidLlmAttemptHooks } from '../src/commands/paid-llm-attempt.js';
import { fingerprint, RunPaidWallet } from '../src/run-paid-wallet.js';
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
    {
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'fake-openai-credential',
    },
    {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: 'fake-gemini-credential',
    },
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

  it('redacts returned HTTP errors and sends Gemini credentials in a header', async () => {
    const openAiKey = 'sentinel-openai-http-credential';
    const geminiKey = 'sentinel-gemini-http-credential';
    const warnings: string[] = [];
    const attempts: string[] = [];
    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        const isOpenAi = url.includes('openai.com');
        const key = isOpenAi ? openAiKey : geminiKey;
        return new Response(
          JSON.stringify({
            error: {
              code: isOpenAi ? 'invalid_api_key' : 'PERMISSION_DENIED',
              message: `credential ${key} rejected at https://provider.example/request?key=other-secret&attempt=6`,
            },
          }),
          { status: isOpenAi ? 401 : 403 },
        );
      }),
    );

    const call = callWithCascade({
      clients: [
        { provider: 'openai', model: 'gpt-5-mini', apiKey: openAiKey },
        { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: geminiKey },
      ],
      prompt: 'p',
      action: 'synthesis',
      timeoutMs: 1000,
      json: false,
      onWarning: (message) => warnings.push(message),
      onAttempt: (attempt) => attempts.push(attempt.error ?? ''),
    });

    await expect(call).rejects.toThrow(
      /Gemini synthesis call failed: HTTP 403/,
    );
    const diagnostics = JSON.stringify({ warnings, attempts });
    expect(diagnostics).toContain('OpenAI synthesis call failed: HTTP 401');
    expect(diagnostics).toContain('[REDACTED_URL]');
    expect(diagnostics).not.toContain(openAiKey);
    expect(diagnostics).not.toContain(geminiKey);
    expect(diagnostics).not.toContain('other-secret');

    const geminiRequest = requests.find(({ url }) =>
      url.includes('generativelanguage.googleapis.com'),
    );
    expect(geminiRequest?.url).not.toContain(geminiKey);
    expect(new URL(geminiRequest?.url ?? '').searchParams.has('key')).toBe(
      false,
    );
    expect(geminiRequest?.init.headers).toMatchObject({
      'x-goog-api-key': geminiKey,
    });
  });

  it('redacts thrown transport URLs from warnings, attempts, and the final error', async () => {
    const openAiKey = 'sentinel-openai-transport-credential';
    const geminiKey = 'sentinel-gemini-transport-credential';
    const warnings: string[] = [];
    const attempts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        const key =
          headers.Authorization?.replace(/^Bearer /, '') ??
          headers['x-goog-api-key'];
        throw new Error(
          `transport rejected ${url}?access_token=${key}&attempt=7`,
        );
      }),
    );

    const call = callWithCascade({
      clients: [
        { provider: 'openai', model: 'gpt-5-mini', apiKey: openAiKey },
        { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: geminiKey },
      ],
      prompt: 'p',
      action: 'refine',
      timeoutMs: 1000,
      json: true,
      onWarning: (message) => warnings.push(message),
      onAttempt: (attempt) => attempts.push(attempt.error ?? ''),
    });

    await expect(call).rejects.toThrow('access_token=[REDACTED]&attempt=7');
    const diagnostics = JSON.stringify({ warnings, attempts });
    expect(diagnostics).toContain('trying gemini');
    expect(diagnostics).toContain('access_token=[REDACTED]&attempt=7');
    expect(diagnostics).not.toContain(openAiKey);
    expect(diagnostics).not.toContain(geminiKey);
  });

  it('redacts a short configured credential from the final error', async () => {
    const shortKey = 'abc123';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`credential ${shortKey} rejected`);
      }),
    );

    await expect(
      callWithCascade({
        clients: [
          { provider: 'openai', model: 'gpt-5-mini', apiKey: shortKey },
        ],
        prompt: 'p',
        action: 'refine',
        timeoutMs: 1000,
        json: true,
      }),
    ).rejects.toThrow('credential [REDACTED] rejected');
  });

  it('aborts a late fallback at the original run deadline', async () => {
    const deadlineAt = Date.now() + 150;
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        calls += 1;
        if (calls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return new Response(JSON.stringify({ error: { message: 'down' } }), {
            status: 500,
          });
        }
        return new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          const abort = () => reject(new DOMException('Aborted', 'AbortError'));
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      }),
    );
    const wallet = new RunPaidWallet({
      request_id: 'request-1',
      request_fingerprint: fingerprint('request'),
      config_fingerprint: fingerprint('config'),
      created_at: new Date().toISOString(),
      deadline_at: new Date(deadlineAt).toISOString(),
      stages: [
        {
          stage: 'synthesis',
          requested: true,
          fallback_authorized: true,
          prompt_version: 'synthesis-v1',
          providers: clients.map(({ provider, model }) => ({
            provider,
            model,
          })),
        },
      ],
    });
    const paid = paidLlmAttemptHooks({
      wallet,
      stage: 'synthesis',
      prompt: 'p',
      config: makeConfig(),
    });
    const started = Date.now();

    await expect(
      callWithCascade({
        clients,
        prompt: 'p',
        action: 'synthesis',
        timeoutMs: wallet.remainingMs(),
        json: false,
        signal: paid.signal,
        beforeAttempt: paid.beforeAttempt,
        onAttempt: paid.onAttempt,
      }),
    ).rejects.toThrow();

    expect(calls).toBe(2);
    expect(wallet.signal.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(400);
    expect(wallet.snapshot().attempts).toHaveLength(2);
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
