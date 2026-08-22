import { describe, expect, it } from 'vitest';
import { DEFAULT_GROUPS } from '../src/constants.js';

const LLM_PROVIDERS = [
  'claude',
  'openai-chat',
  'gemini-chat',
  'openrouter-chat',
] as const;

const GROUNDED_GROUPS = [
  'quick',
  'fast',
  'raw',
  'deep',
  'visibility',
  'comprehensive',
  'all',
] as const;

const SEARCHAPI_SURFACES = [
  'searchapi-chatgpt',
  'searchapi-gemini',
  'searchapi-perplexity',
  'searchapi-google-ai-mode',
  'searchapi-bing-copilot',
  'searchapi-google-ai-overview',
] as const;

const VISIBILITY_PROVIDERS = [
  ...SEARCHAPI_SURFACES,
  'perplexity-sonar-pro',
  'gemini-grounded',
  'grok',
] as const;

describe('default groups -- llm tier', () => {
  it('defines an llm group with exactly the four opt-in providers', () => {
    expect(DEFAULT_GROUPS.llm).toEqual([...LLM_PROVIDERS]);
  });

  it('excludes every llm provider from each grounded group', () => {
    for (const group of GROUNDED_GROUPS) {
      const members = DEFAULT_GROUPS[group];
      expect(members).toBeDefined();
      for (const llmId of LLM_PROVIDERS) {
        expect(members).not.toContain(llmId);
      }
    }
  });

  it('includes Grok web in visibility, comprehensive, and all', () => {
    expect(DEFAULT_GROUPS.visibility).toContain('grok');
    expect(DEFAULT_GROUPS.comprehensive).toContain('grok');
    expect(DEFAULT_GROUPS.all).toContain('grok');
    expect(DEFAULT_GROUPS.quick).not.toContain('grok');
    expect(DEFAULT_GROUPS.fast).not.toContain('grok');
  });
});

describe('default groups -- grok membership invariant', () => {
  it('keeps grok web out of every group except visibility, comprehensive, and all', () => {
    const allowed = new Set(['visibility', 'comprehensive', 'all']);
    for (const [group, members] of Object.entries(DEFAULT_GROUPS)) {
      if (allowed.has(group)) expect(members).toContain('grok');
      else expect(members).not.toContain('grok');
    }
  });

  it('adds X-only and combined only to comprehensive and all, never visibility', () => {
    for (const id of ['grok-x-only', 'grok-combined'] as const) {
      expect(DEFAULT_GROUPS.comprehensive).toContain(id);
      expect(DEFAULT_GROUPS.all).toContain(id);
      expect(DEFAULT_GROUPS.visibility).not.toContain(id);
      expect(DEFAULT_GROUPS.quick).not.toContain(id);
      expect(DEFAULT_GROUPS.fast).not.toContain(id);
      expect(DEFAULT_GROUPS.deep).not.toContain(id);
      expect(DEFAULT_GROUPS.llm).not.toContain(id);
    }
  });
});

describe('default groups -- visibility expansion', () => {
  it('defines exactly the nine-provider visibility roster in policy order', () => {
    expect(DEFAULT_GROUPS.visibility).toEqual([...VISIBILITY_PROVIDERS]);
  });

  it('puts all SearchAPI surfaces in comprehensive/all and no other default group', () => {
    for (const id of SEARCHAPI_SURFACES) {
      expect(DEFAULT_GROUPS.comprehensive).toContain(id);
      expect(DEFAULT_GROUPS.all).toContain(id);
      for (const group of ['quick', 'fast', 'raw', 'deep', 'llm'] as const) {
        expect(DEFAULT_GROUPS[group]).not.toContain(id);
      }
    }
  });

  it('keeps retired Perplexity identities out of every default group', () => {
    for (const id of [
      'perplexity-pro-search',
      'perplexity-advanced-deep',
    ] as const) {
      for (const members of Object.values(DEFAULT_GROUPS)) {
        expect(members).not.toContain(id);
      }
    }
  });

  it('has eight default groups and all 33 grounded providers', () => {
    expect(Object.keys(DEFAULT_GROUPS)).toHaveLength(8);
    expect(DEFAULT_GROUPS.all).toHaveLength(34);
  });
});

describe('default groups -- OpenAI research migration', () => {
  it('contains the canonical OpenAI research provider exactly once per deep group', () => {
    for (const group of ['deep', 'comprehensive', 'all'] as const) {
      expect(DEFAULT_GROUPS[group]).toContain('openai-research');
      expect(DEFAULT_GROUPS[group]).not.toContain('openai-deep');
      expect(DEFAULT_GROUPS[group]).not.toContain('openai-deep-o3');
    }
  });
});
