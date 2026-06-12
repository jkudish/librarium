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
  it('defines an llm group with exactly the four ungrounded providers', () => {
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
});
