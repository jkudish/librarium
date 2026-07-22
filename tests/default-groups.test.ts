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
  'comprehensive',
  'all',
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

  it('includes Grok only in the comprehensive and all grounded groups', () => {
    expect(DEFAULT_GROUPS.comprehensive).toContain('grok');
    expect(DEFAULT_GROUPS.all).toContain('grok');
    expect(DEFAULT_GROUPS.quick).not.toContain('grok');
    expect(DEFAULT_GROUPS.fast).not.toContain('grok');
  });
});

describe('default groups -- grok membership invariant', () => {
  it('keeps grok out of every group except comprehensive and all', () => {
    const allowed = new Set(['comprehensive', 'all']);
    for (const [group, members] of Object.entries(DEFAULT_GROUPS)) {
      if (allowed.has(group)) expect(members).toContain('grok');
      else expect(members).not.toContain('grok');
    }
  });
});
