import { describe, expect, it } from 'vitest';
import {
  computeInitProviderChoices,
  isLlmTierProvider,
  LLM_TIER_PROVIDER_IDS,
  PROVIDER_ENV_VARS,
} from '../src/constants.js';

const LLM_PROVIDERS = [
  'claude',
  'openai-chat',
  'gemini-chat',
  'openrouter-chat',
] as const;

describe('isLlmTierProvider', () => {
  it('identifies the four opt-in llm providers', () => {
    for (const id of LLM_PROVIDERS) {
      expect(isLlmTierProvider(id)).toBe(true);
    }
    expect([...LLM_TIER_PROVIDER_IDS].sort()).toEqual(
      [...LLM_PROVIDERS].sort(),
    );
  });

  it('does not flag grounded providers, including key-sharing siblings', () => {
    // These share API keys with llm-tier providers but are grounded.
    for (const id of [
      'openai-research',
      'gemini-deep',
      'gemini-grounded',
      'openrouter-online',
      'exa',
      'tavily',
    ]) {
      expect(isLlmTierProvider(id)).toBe(false);
    }
  });
});

describe('computeInitProviderChoices (init opt-in policy)', () => {
  it('never enables llm-tier providers by default, even with keys present', () => {
    const env = {
      OPENAI_API_KEY: 'sk-openai',
      GEMINI_API_KEY: 'gm-key',
      OPENROUTER_API_KEY: 'or-key',
      ANTHROPIC_API_KEY: 'ant-key',
    };
    const choices = computeInitProviderChoices(env);

    for (const id of LLM_PROVIDERS) {
      const choice = choices.find((c) => c.id === id);
      expect(choice).toBeDefined();
      expect(choice!.keyPresent).toBe(true);
      expect(choice!.isLlm).toBe(true);
      // The crux: key present but NOT enabled/pre-checked by default.
      expect(choice!.enableByDefault).toBe(false);
    }
  });

  it('enables grounded providers whose shared keys are present', () => {
    const env = {
      OPENAI_API_KEY: 'sk-openai',
      GEMINI_API_KEY: 'gm-key',
      OPENROUTER_API_KEY: 'or-key',
    };
    const choices = computeInitProviderChoices(env);

    for (const id of [
      'openai-research',
      'gemini-deep',
      'gemini-grounded',
      'openrouter-online',
    ]) {
      const choice = choices.find((c) => c.id === id);
      expect(choice).toBeDefined();
      expect(choice!.keyPresent).toBe(true);
      expect(choice!.isLlm).toBe(false);
      expect(choice!.enableByDefault).toBe(true);
    }
  });

  it('does not enable providers whose env vars are missing', () => {
    const choices = computeInitProviderChoices({});
    for (const choice of choices) {
      expect(choice.keyPresent).toBe(false);
      expect(choice.enableByDefault).toBe(false);
    }
  });

  it('covers every provider in PROVIDER_ENV_VARS, preserving order', () => {
    const choices = computeInitProviderChoices({});
    expect(choices.map((c) => c.id)).toEqual(Object.keys(PROVIDER_ENV_VARS));
    expect(choices.map((c) => c.envVar)).toEqual(
      Object.values(PROVIDER_ENV_VARS),
    );
  });
});
