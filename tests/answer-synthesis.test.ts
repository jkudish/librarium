import { describe, expect, it } from 'vitest';
import {
  buildAnswerSources,
  buildSynthesisPrompt,
  CONTENT_BUDGET_CHARS,
  renderAnswerMarkdown,
  truncateContent,
} from '../src/commands/answer-synthesis.js';
import type {
  DeduplicatedSource,
  ProviderDispatchResult,
} from '../src/types.js';

function source(
  url: string,
  extra: Partial<DeduplicatedSource> = {},
): DeduplicatedSource {
  return {
    url,
    normalizedUrl: url,
    providers: ['openai'],
    citationCount: 1,
    ...extra,
  };
}

function result(
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

describe('buildAnswerSources', () => {
  it('assigns stable 1-based indices preserving dedup order', () => {
    const sources = buildAnswerSources([
      source('https://a.com', { title: 'A', citationCount: 3 }),
      source('https://b.com', { citationCount: 1 }),
    ]);
    expect(sources).toEqual([
      {
        index: 1,
        url: 'https://a.com',
        title: 'A',
        providers: ['openai'],
      },
      {
        index: 2,
        url: 'https://b.com',
        title: undefined,
        providers: ['openai'],
      },
    ]);
  });
});

describe('truncateContent', () => {
  it('leaves short content untouched', () => {
    expect(truncateContent('hello', 10)).toEqual({
      text: 'hello',
      truncated: false,
    });
  });

  it('cuts to the budget and flags truncation', () => {
    const long = 'x'.repeat(50);
    const out = truncateContent(long, 10);
    expect(out.text).toHaveLength(10);
    expect(out.truncated).toBe(true);
  });

  it('defaults to the content budget', () => {
    const long = 'y'.repeat(CONTENT_BUDGET_CHARS + 100);
    const out = truncateContent(long);
    expect(out.text).toHaveLength(CONTENT_BUDGET_CHARS);
    expect(out.truncated).toBe(true);
  });
});

describe('buildSynthesisPrompt', () => {
  const sources = buildAnswerSources([
    source('https://a.com', { title: 'Alpha' }),
    source('https://b.com'),
  ]);

  it('numbers the sources list with titles and urls', () => {
    const prompt = buildSynthesisPrompt({
      query: 'what is x',
      results: [result('openai', 'finding one')],
      sources,
    });
    expect(prompt).toContain('[1] Alpha - https://a.com');
    expect(prompt).toContain('[2] https://b.com');
  });

  it('includes the question and each provider finding', () => {
    const prompt = buildSynthesisPrompt({
      query: 'what is x',
      results: [
        result('openai', 'finding one'),
        result('gemini', 'finding two'),
      ],
      sources,
    });
    expect(prompt).toContain('## Question\n\nwhat is x');
    expect(prompt).toContain('### Provider: openai (ai-grounded)');
    expect(prompt).toContain('finding one');
    expect(prompt).toContain('### Provider: gemini (ai-grounded)');
    expect(prompt).toContain('finding two');
  });

  it('truncates per-provider content to the budget and notes it', () => {
    const long = 'z'.repeat(100);
    const prompt = buildSynthesisPrompt({
      query: 'q',
      results: [result('openai', long)],
      sources,
      budget: 10,
    });
    expect(prompt).toContain('truncated to fit the synthesis budget');
    // The full 100-char block must not appear; only the 10-char slice.
    expect(prompt).not.toContain(long);
    expect(prompt).toContain('z'.repeat(10));
  });

  it('skips providers with empty content', () => {
    const prompt = buildSynthesisPrompt({
      query: 'q',
      results: [result('openai', '   '), result('gemini', 'real')],
      sources,
    });
    expect(prompt).not.toContain('Provider: openai');
    expect(prompt).toContain('Provider: gemini');
  });

  it('instructs the model to cite only from the source list and admit gaps', () => {
    const prompt = buildSynthesisPrompt({
      query: 'q',
      results: [result('openai', 'x')],
      sources,
    });
    expect(prompt).toContain('Answer ONLY from the findings');
    expect(prompt).toMatch(/indices from the Sources list/);
    expect(prompt).toMatch(/uncertain or missing/);
  });

  it('handles the no-sources case gracefully', () => {
    const prompt = buildSynthesisPrompt({
      query: 'q',
      results: [result('openai', 'x')],
      sources: [],
    });
    expect(prompt).toContain('no sources were extracted');
  });
});

describe('renderAnswerMarkdown', () => {
  it('appends a numbered source list matching citation indices', () => {
    const sources = buildAnswerSources([
      source('https://a.com', { title: 'Alpha' }),
      source('https://b.com'),
    ]);
    const md = renderAnswerMarkdown(
      'what is x',
      'X is a thing [1] supported by more detail [2].',
      sources,
    );
    expect(md).toContain('# what is x');
    expect(md).toContain('X is a thing [1]');
    expect(md).toContain('## Sources');
    expect(md).toContain('1. Alpha - https://a.com');
    expect(md).toContain('2. https://b.com');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('omits the sources section when there are no sources', () => {
    const md = renderAnswerMarkdown('q', 'an answer', []);
    expect(md).not.toContain('## Sources');
    expect(md).toContain('an answer');
  });
});
