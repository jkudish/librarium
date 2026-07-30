import { describe, expect, it } from 'vitest';
import {
  normalizeProviderName,
  type ProviderNameEntry,
  resolveProviderToken,
  resolveProviderTokens,
  suggestProviders,
} from '../src/constants.js';

const PROVIDERS: ProviderNameEntry[] = [
  { id: 'openai-research', displayName: 'OpenAI Research' },
  { id: 'perplexity-sonar-pro', displayName: 'Perplexity Sonar Pro' },
  { id: 'exa', displayName: 'Exa Search' },
  { id: 'brave-search', displayName: 'Brave Web Search' },
  { id: 'brave-answers', displayName: 'Brave AI Answers' },
  { id: 'tavily', displayName: 'Tavily Search' },
];

describe('normalizeProviderName', () => {
  it('lowercases and collapses spaces, hyphens, and underscores', () => {
    expect(normalizeProviderName('Perplexity Sonar Pro')).toBe(
      'perplexity sonar pro',
    );
    expect(normalizeProviderName('perplexity-sonar-pro')).toBe(
      'perplexity sonar pro',
    );
    expect(normalizeProviderName('perplexity__sonar  pro')).toBe(
      'perplexity sonar pro',
    );
    expect(normalizeProviderName('  EXA-SEARCH  ')).toBe('exa search');
  });
});

describe('resolveProviderToken resolution order', () => {
  it('resolves an exact canonical id', () => {
    expect(resolveProviderToken('exa', PROVIDERS)).toEqual({
      kind: 'id',
      token: 'exa',
      id: 'exa',
    });
  });

  it('resolves a legacy alias before a name match', () => {
    expect(resolveProviderToken('perplexity-sonar', PROVIDERS)).toEqual({
      kind: 'alias',
      token: 'perplexity-sonar',
      id: 'perplexity-sonar-pro',
    });
  });

  it('warns and collapses retired OpenAI deep tokens to one dispatch id', () => {
    const result = resolveProviderTokens(
      ['openai-deep', 'openai-deep-o3', 'openai-research'],
      PROVIDERS,
    );
    expect(result.ids).toEqual(['openai-research']);
    expect(result.warnings).toHaveLength(2);
  });

  it('resolves a display name (exact form)', () => {
    expect(resolveProviderToken('Perplexity Sonar Pro', PROVIDERS)).toEqual({
      kind: 'name',
      token: 'Perplexity Sonar Pro',
      id: 'perplexity-sonar-pro',
    });
  });
});

describe('resolveProviderToken name normalization variants', () => {
  for (const token of [
    'Perplexity Sonar Pro',
    'perplexity sonar pro',
    'PERPLEXITY-SONAR-PRO',
    'perplexity_sonar_pro',
    '  perplexity   sonar pro  ',
  ]) {
    it(`resolves "${token}" by display name`, () => {
      const result = resolveProviderToken(token, PROVIDERS);
      expect(result.kind).toBe('name');
      expect(result.kind === 'name' && result.id).toBe('perplexity-sonar-pro');
    });
  }

  for (const token of ['Exa Search', 'EXA SEARCH', 'exa-search']) {
    it(`resolves "${token}" to exa`, () => {
      const result = resolveProviderToken(token, PROVIDERS);
      expect(result.kind).toBe('name');
      expect(result.kind === 'name' && result.id).toBe('exa');
    });
  }
});

describe('resolveProviderToken ambiguity', () => {
  it('errors with candidate list when a name matches multiple providers', () => {
    const ambiguous: ProviderNameEntry[] = [
      { id: 'brave-a', displayName: 'Brave Search' },
      { id: 'brave-b', displayName: 'Brave-Search' },
    ];
    const result = resolveProviderToken('brave search', ambiguous);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates.map((c) => c.id)).toEqual([
        'brave-a',
        'brave-b',
      ]);
    }
  });
});

describe('resolveProviderToken did-you-mean', () => {
  it('suggests by substring containment first', () => {
    const result = resolveProviderToken('brave', PROVIDERS);
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') {
      const ids = result.suggestions.map((s) => s.id);
      expect(ids).toContain('brave-search');
      expect(ids).toContain('brave-answers');
    }
  });

  it('suggests by edit distance when no containment', () => {
    const result = resolveProviderToken('tavly', PROVIDERS);
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') {
      expect(result.suggestions[0]?.id).toBe('tavily');
    }
  });

  it('caps suggestions at 3', () => {
    expect(suggestProviders('search', PROVIDERS).length).toBeLessThanOrEqual(3);
  });
});

describe('resolveProviderTokens aggregation', () => {
  it('resolves a mix of id and name with no warnings', () => {
    const result = resolveProviderTokens(
      ['Exa Search', 'brave-search'],
      PROVIDERS,
    );
    expect(result.ids).toEqual(['exa', 'brave-search']);
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('warns on legacy aliases but not on display-name matches', () => {
    const result = resolveProviderTokens(
      ['perplexity-sonar', 'Exa Search'],
      PROVIDERS,
    );
    expect(result.ids).toEqual(['perplexity-sonar-pro', 'exa']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('deprecated');
    expect(result.warnings[0]).toContain('perplexity-sonar');
  });

  it('deduplicates while preserving order', () => {
    const result = resolveProviderTokens(
      ['exa', 'Exa Search', 'exa-search'],
      PROVIDERS,
    );
    expect(result.ids).toEqual(['exa']);
  });

  it('errors with candidate list on ambiguity', () => {
    const ambiguous: ProviderNameEntry[] = [
      { id: 'one', displayName: 'Twin Name' },
      { id: 'two', displayName: 'Twin-Name' },
    ];
    const result = resolveProviderTokens(['twin name'], ambiguous);
    expect(result.ids).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('ambiguous');
    expect(result.errors[0]).toContain('one (Twin Name)');
    expect(result.errors[0]).toContain('two (Twin-Name)');
  });

  it('errors with did-you-mean suggestions on unknown token', () => {
    const result = resolveProviderTokens(['exra'], PROVIDERS);
    expect(result.ids).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Unknown provider: exra');
    expect(result.errors[0]).toContain('Did you mean');
    expect(result.errors[0]).toContain('exa (Exa Search)');
  });

  it('resolves custom provider display names', () => {
    const withCustom: ProviderNameEntry[] = [
      ...PROVIDERS,
      { id: 'my-custom', displayName: 'My Custom Engine' },
    ];
    const result = resolveProviderTokens(['my custom engine'], withCustom);
    expect(result.ids).toEqual(['my-custom']);
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
