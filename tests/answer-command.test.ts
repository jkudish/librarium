import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProvider } from '../src/adapters/index.js';
import {
  registerAnswerCommand,
  synthesizeAndVerifyAnswer,
  synthesizeAnswer,
} from '../src/commands/answer.js';
import type { PostDispatchContext } from '../src/commands/run.js';
import type {
  Config,
  DeduplicatedSource,
  Provider,
  ProviderDispatchResult,
} from '../src/types.js';

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

function makeResult(
  provider: string,
  text: string,
  status: ProviderDispatchResult['status'] = 'success',
): ProviderDispatchResult {
  return {
    provider,
    tier: 'ai-grounded',
    status,
    text,
    sourceUrls: [],
    citations: [],
    durationMs: 100,
  };
}

const SOURCES: DeduplicatedSource[] = [
  {
    url: 'https://a.com',
    normalizedUrl: 'https://a.com',
    title: 'Alpha',
    providers: ['openai'],
    citationCount: 2,
  },
];

function makeContext(
  outputDir: string,
  results: ProviderDispatchResult[],
  config: Config,
): { context: PostDispatchContext; lines: string[] } {
  const lines: string[] = [];
  const context: PostDispatchContext = {
    query: 'what is x',
    config,
    results,
    reports: [],
    sources: SOURCES,
    outputDir,
    color: false,
    printLine: (line) => lines.push(line),
  };
  return { context, lines };
}

describe('answer command --max-cost flag', () => {
  function parseAnswer(args: string[]): { maxCost?: number; verify?: boolean } {
    const program = new Command();
    program.exitOverride();
    registerAnswerCommand(program);
    let parsed: { maxCost?: number } = {};
    const cmd = program.commands.find((c) => c.name() === 'answer');
    if (!cmd) throw new Error('answer command not registered');
    // Capture the parsed options without executing the (async) action.
    cmd.action(() => {});
    program.parse(['node', 'librarium', 'answer', ...args]);
    parsed = cmd.opts();
    return parsed;
  }

  it('registers --max-cost and parses a positive USD amount', () => {
    expect(parseAnswer(['some query', '--max-cost', '2.50']).maxCost).toBe(2.5);
  });

  it('rejects a non-positive or non-numeric --max-cost', () => {
    expect(() => parseAnswer(['q', '--max-cost', '0'])).toThrow();
    expect(() => parseAnswer(['q', '--max-cost', '-1'])).toThrow();
    expect(() => parseAnswer(['q', '--max-cost', 'abc'])).toThrow();
  });

  it('keeps verification opt-in', () => {
    expect(parseAnswer(['some query']).verify).toBeUndefined();
    expect(parseAnswer(['some query', '--verify']).verify).toBe(true);
  });
});

describe('synthesizeAnswer', () => {
  let dir: string;
  const env = process.env;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'librarium-answer-'));
    process.env = { ...env, OPENAI_API_KEY: 'test-key' };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = env;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetch(status: number, body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );
  }

  it('writes answer.md and returns answer metadata on success', async () => {
    stubFetch(200, {
      choices: [{ message: { content: 'X is a thing [1].' } }],
    });
    const { context } = makeContext(
      dir,
      [makeResult('openai', 'a finding about x')],
      makeConfig(),
    );
    const out = await synthesizeAnswer(context);
    expect(out?.manifestExtra?.answer).toEqual({
      provider: 'openai',
      model: 'gpt-5-mini',
    });
    const answerPath = join(dir, 'answer.md');
    expect(existsSync(answerPath)).toBe(true);
    const md = readFileSync(answerPath, 'utf8');
    expect(md).toContain('X is a thing [1].');
    expect(md).toContain('## Sources');
    expect(md).toContain('1. Alpha - https://a.com');
  });

  it('fails open: prints a warning and writes no answer.md when synthesis fails', async () => {
    stubFetch(500, { error: { message: 'down', type: 'server_error' } });
    const { context, lines } = makeContext(
      dir,
      [makeResult('openai', 'a finding')],
      makeConfig(),
    );
    const out = await synthesizeAnswer(context);
    expect(out).toBeUndefined();
    expect(existsSync(join(dir, 'answer.md'))).toBe(false);
    expect(lines.some((l) => l.includes('answer synthesis failed'))).toBe(true);
    expect(lines.some((l) => l.includes('research above is intact'))).toBe(
      true,
    );
  });

  it('fails open when no provider returned usable content', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { context, lines } = makeContext(
      dir,
      [makeResult('openai', '', 'error')],
      makeConfig(),
    );
    const out = await synthesizeAnswer(context);
    expect(out).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      lines.some((l) => l.includes('no successful provider content')),
    ).toBe(true);
  });

  it('reports a clear error when no synthesis provider key is available', async () => {
    process.env = { ...env };
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    const { context, lines } = makeContext(
      dir,
      [makeResult('openai', 'a finding')],
      makeConfig(),
    );
    const out = await synthesizeAnswer(context);
    expect(out).toBeUndefined();
    expect(
      lines.some((l) => l.includes('no synthesis provider available')),
    ).toBe(true);
  });

  it('fails open during opt-in verification and preserves the original answer', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return calls === 1
          ? new Response(
              JSON.stringify({
                choices: [
                  { message: { content: 'Original grounded answer [1].' } },
                ],
              }),
              { status: 200 },
            )
          : new Response(
              JSON.stringify({
                error: { message: 'verification unavailable' },
              }),
              {
                status: 500,
              },
            );
      }),
    );
    const { context } = makeContext(
      dir,
      [makeResult('openai', 'a finding about x')],
      makeConfig(),
    );
    const out = await synthesizeAndVerifyAnswer(context);
    expect(readFileSync(join(dir, 'answer.md'), 'utf8')).toContain(
      'Original grounded answer [1].',
    );
    expect(out?.manifestExtra?.verification?.status).toBe('incomplete');
    expect(out?.manifestExtra?.verification?.revised).toBe(false);
    expect(existsSync(join(dir, 'verification.json'))).toBe(true);
  });

  it('makes zero verification calls when the inherited ceiling is already exhausted and preserves answer.md', async () => {
    process.env.VERIFY_PRIMARY_KEY = 'primary-key';
    const execute = vi.fn<Provider['execute']>();
    registerProvider({
      id: 'primary',
      displayName: 'Primary',
      tier: 'ai-grounded',
      envVar: 'VERIFY_PRIMARY_KEY',
      execute,
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: 'Original grounded answer [1].' } },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const runConfig = makeConfig();
    runConfig.defaults.maxCostUsd = 0.01;
    runConfig.providers.primary = {
      apiKey: '$VERIFY_PRIMARY_KEY',
      enabled: true,
    };
    const { context } = makeContext(
      dir,
      [makeResult('primary', 'a finding about x')],
      runConfig,
    );
    context.reports = [
      {
        id: 'primary',
        tier: 'ai-grounded',
        status: 'success',
        durationMs: 1,
        wordCount: 1,
        citationCount: 0,
        outputFile: 'primary.md',
        metaFile: 'primary.meta.json',
        usage: { costUsd: 0.01 },
      },
    ];

    const out = await synthesizeAndVerifyAnswer(context);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, 'answer.md'), 'utf8')).toContain(
      'Original grounded answer [1].',
    );
    expect(out?.manifestExtra?.answer).toEqual({
      provider: 'openai',
      model: 'gpt-5-mini',
    });
    expect(out?.manifestExtra?.verification).toMatchObject({
      status: 'incomplete',
      revised: false,
      usage: { providerAttempts: 0, llmCalls: 0 },
    });
  });

  it('retains synthesis attribution when verification throws unexpectedly', async () => {
    stubFetch(200, {
      choices: [{ message: { content: 'Original grounded answer [1].' } }],
    });
    const { context, lines } = makeContext(
      dir,
      [makeResult('openai', 'a finding about x')],
      makeConfig(),
    );
    context.reports = null as never;

    const out = await synthesizeAndVerifyAnswer(context);

    expect(out?.manifestExtra).toEqual({
      answer: { provider: 'openai', model: 'gpt-5-mini' },
    });
    expect(readFileSync(join(dir, 'answer.md'), 'utf8')).toContain(
      'Original grounded answer [1].',
    );
    expect(
      lines.some((line) => line.includes('verification failed unexpectedly')),
    ).toBe(true);
  });
});
