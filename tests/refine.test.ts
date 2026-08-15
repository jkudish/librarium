import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatHttpError,
  parseRefineResponse,
  refineQuery,
  resolveRefineClient,
  resolveRefineClients,
} from '../src/commands/refine.js';
import type { Config } from '../src/types.js';

const VALID = JSON.stringify({
  deepResearch:
    'Investigate postgres connection pooling strategies, covering pgbouncer, built-in poolers, and cloud offerings.',
  aiGrounded:
    'What are current best practices for postgres connection pooling?',
  rawSearch: 'postgres connection pooling pgbouncer best practices',
  suggestedGroup: 'quick',
});

function makeConfig(refine?: Config['refine']): Config {
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
    refine,
  };
}

describe('parseRefineResponse', () => {
  it('parses a clean JSON response into tier queries', () => {
    const refined = parseRefineResponse(VALID);
    expect(refined.tierQueries['deep-research']).toContain('pgbouncer');
    expect(refined.tierQueries['ai-grounded']).toContain('best practices');
    expect(refined.tierQueries['raw-search']).toBe(
      'postgres connection pooling pgbouncer best practices',
    );
    expect(refined.suggestedGroup).toBe('quick');
  });

  it('tolerates code fences and surrounding prose', () => {
    const refined = parseRefineResponse(
      `Here you go:\n\`\`\`json\n${VALID}\n\`\`\`\nHope that helps!`,
    );
    expect(refined.tierQueries['raw-search']).toContain('pgbouncer');
  });

  it('drops invalid suggestedGroup values', () => {
    const refined = parseRefineResponse(
      VALID.replace('"quick"', '"not-a-group"'),
    );
    expect(refined.suggestedGroup).toBeUndefined();
  });

  it('does not suggest the explicit consumer-surface visibility group', () => {
    const refined = parseRefineResponse(
      VALID.replace('"quick"', '"visibility"'),
    );
    expect(refined.suggestedGroup).toBeUndefined();
  });

  it('throws when variants are missing or empty', () => {
    expect(() => parseRefineResponse('{}')).toThrow();
    expect(() =>
      parseRefineResponse('{"deepResearch": "x", "aiGrounded": ""}'),
    ).toThrow();
    expect(() => parseRefineResponse('no json here')).toThrow();
  });
});

describe('resolveRefineClient', () => {
  it('prefers OpenAI, then Gemini, then Perplexity by available key', () => {
    expect(
      resolveRefineClient(makeConfig(), {
        OPENAI_API_KEY: 'a',
        GEMINI_API_KEY: 'b',
      })?.provider,
    ).toBe('openai');
    expect(
      resolveRefineClient(makeConfig(), { GEMINI_API_KEY: 'b' })?.provider,
    ).toBe('gemini');
    expect(
      resolveRefineClient(makeConfig(), { PERPLEXITY_API_KEY: 'c' })?.provider,
    ).toBe('perplexity');
    expect(resolveRefineClient(makeConfig(), {})).toBeNull();
  });

  it('honors config.refine provider and model overrides', () => {
    const client = resolveRefineClient(
      makeConfig({ provider: 'gemini', model: 'gemini-custom' }),
      { OPENAI_API_KEY: 'a', GEMINI_API_KEY: 'b' },
    );
    expect(client?.provider).toBe('gemini');
    expect(client?.model).toBe('gemini-custom');
  });

  it('returns null when the configured provider has no key', () => {
    expect(
      resolveRefineClient(makeConfig({ provider: 'perplexity' }), {
        OPENAI_API_KEY: 'a',
      }),
    ).toBeNull();
  });

  it('uses default models per provider', () => {
    expect(
      resolveRefineClient(makeConfig(), { OPENAI_API_KEY: 'a' })?.model,
    ).toBe('gpt-5-mini');
    expect(
      resolveRefineClient(makeConfig(), { GEMINI_API_KEY: 'b' })?.model,
    ).toBe('gemini-2.5-flash');
    expect(
      resolveRefineClient(makeConfig(), { PERPLEXITY_API_KEY: 'c' })?.model,
    ).toBe('low');
  });
});

describe('formatHttpError', () => {
  it('includes OpenAI error code and message', () => {
    const body = JSON.stringify({
      error: {
        message:
          'You exceeded your current quota, please check your plan and billing details.',
        type: 'insufficient_quota',
        code: 'insufficient_quota',
      },
    });
    const message = formatHttpError('OpenAI', 429, body);
    expect(message).toContain('OpenAI refine call failed: HTTP 429');
    expect(message).toContain('insufficient_quota');
    expect(message).toContain('(You exceeded your current quota');
  });

  it('uses Gemini status when code is numeric', () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: 'Resource has been exhausted.',
        status: 'RESOURCE_EXHAUSTED',
      },
    });
    const message = formatHttpError('Gemini', 429, body);
    expect(message).toContain('RESOURCE_EXHAUSTED');
    expect(message).toContain('(Resource has been exhausted.)');
  });

  it('falls back to the raw body for non-JSON responses and truncates', () => {
    const message = formatHttpError('Perplexity', 502, 'Bad gateway');
    expect(message).toBe(
      'Perplexity refine call failed: HTTP 502 [unparseable provider error]',
    );
    const long = formatHttpError(
      'OpenAI',
      400,
      JSON.stringify({ error: { message: 'x'.repeat(300), code: 'bad' } }),
    );
    expect(long.length).toBeLessThan(180);
    expect(long).toContain('\u2026');
  });

  it('omits detail when the body is empty', () => {
    expect(formatHttpError('OpenAI', 500, '')).toBe(
      'OpenAI refine call failed: HTTP 500',
    );
  });
});

describe('refine cascade', () => {
  const VALID_BODY = {
    choices: [{ message: { content: VALID } }],
  };
  const GEMINI_BODY = {
    candidates: [{ content: { parts: [{ text: VALID }] } }],
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it('cascades to the next provider when the first fails', async () => {
    const getCalls = stubFetch((url) =>
      url.includes('openai.com')
        ? {
            status: 429,
            body: {
              error: {
                message: 'You exceeded your current quota',
                code: 'insufficient_quota',
              },
            },
          }
        : { status: 200, body: GEMINI_BODY },
    );
    const warnings: string[] = [];
    const refined = await refineQuery(
      'scale postgres',
      makeConfig(),
      { OPENAI_API_KEY: 'a', GEMINI_API_KEY: 'b', PERPLEXITY_API_KEY: 'c' },
      (w) => warnings.push(w),
    );
    expect(refined.tierQueries['raw-search']).toContain('pgbouncer');
    const calls = getCalls();
    expect(calls[0]).toContain('openai.com');
    expect(calls[1]).toContain('generativelanguage.googleapis.com');
    expect(calls).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('insufficient_quota');
    expect(warnings[0]).toContain('trying gemini');
  });

  it('cascades through to perplexity and throws when all fail', async () => {
    const getCalls = stubFetch(() => ({
      status: 500,
      body: { error: { message: 'down', type: 'server_error' } },
    }));
    const warnings: string[] = [];
    await expect(
      refineQuery(
        'scale postgres',
        makeConfig(),
        { OPENAI_API_KEY: 'a', GEMINI_API_KEY: 'b', PERPLEXITY_API_KEY: 'c' },
        (w) => warnings.push(w),
      ),
    ).rejects.toThrow(/Perplexity refine call failed: HTTP 500/);
    expect(getCalls()).toHaveLength(3);
    expect(warnings).toHaveLength(2);
  });

  it('does not cascade when config pins the provider', async () => {
    const getCalls = stubFetch(() => ({
      status: 429,
      body: { error: { message: 'quota', code: 'insufficient_quota' } },
    }));
    const warnings: string[] = [];
    await expect(
      refineQuery(
        'scale postgres',
        makeConfig({ provider: 'openai' }),
        { OPENAI_API_KEY: 'a', GEMINI_API_KEY: 'b' },
        (w) => warnings.push(w),
      ),
    ).rejects.toThrow(/insufficient_quota/);
    expect(getCalls()).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });

  it('skips providers without keys when cascading', () => {
    const clients = resolveRefineClients(makeConfig(), {
      GEMINI_API_KEY: 'b',
      PERPLEXITY_API_KEY: 'c',
    });
    expect(clients.map((c) => c.provider)).toEqual(['gemini', 'perplexity']);
  });

  it('model override applies only to the first client', () => {
    const clients = resolveRefineClients(
      makeConfig({ model: 'custom-model' }),
      {
        OPENAI_API_KEY: 'a',
        GEMINI_API_KEY: 'b',
      },
    );
    expect(clients[0]?.model).toBe('custom-model');
    expect(clients[1]?.model).toBe('gemini-2.5-flash');
  });

  it('succeeds on the first provider without warnings', async () => {
    const getCalls = stubFetch(() => ({ status: 200, body: VALID_BODY }));
    const warnings: string[] = [];
    const refined = await refineQuery(
      'scale postgres',
      makeConfig(),
      { OPENAI_API_KEY: 'a', GEMINI_API_KEY: 'b' },
      (w) => warnings.push(w),
    );
    expect(refined.suggestedGroup).toBe('quick');
    expect(getCalls()).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });
});
