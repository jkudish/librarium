import { describe, expect, it } from 'vitest';
import {
  parseRefineResponse,
  resolveRefineClient,
} from '../src/commands/refine.js';
import type { Config } from '../src/types.js';

const VALID = JSON.stringify({
  deepResearch:
    'Investigate postgres connection pooling strategies, covering pgbouncer, built-in poolers, and cloud offerings.',
  aiGrounded: 'What are current best practices for postgres connection pooling?',
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
    ).toBe('sonar');
  });
});
