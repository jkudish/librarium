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

const NEW_OPT_IN_PROVIDERS = [
  'searchapi-chatgpt',
  'searchapi-gemini',
  'searchapi-perplexity',
  'searchapi-google-ai-mode',
  'searchapi-bing-copilot',
  'searchapi-google-ai-overview',
  'perplexity-pro-search',
] as const;

const PARALLEL_OPT_IN_PROVIDERS = [
  'parallel-research',
  'parallel-chat',
  'parallel-search',
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
      expect(choice!.isOptIn).toBe(true);
      // The crux: key present but NOT enabled/pre-checked by default.
      expect(choice!.enableByDefault).toBe(false);
    }
  });

  it('lists new shared-key providers but never selects them automatically', () => {
    const choices = computeInitProviderChoices({
      SEARCHAPI_API_KEY: 'searchapi-key',
      PERPLEXITY_API_KEY: 'perplexity-key',
    });

    for (const id of NEW_OPT_IN_PROVIDERS) {
      const choice = choices.find((candidate) => candidate.id === id);
      expect(choice).toMatchObject({
        id,
        keyPresent: true,
        isOptIn: true,
        enableByDefault: false,
      });
    }
  });

  it('does not automatically enable any Parallel profile for its shared key', () => {
    const choices = computeInitProviderChoices({
      PARALLEL_API_KEY: 'parallel-key',
    });

    for (const id of PARALLEL_OPT_IN_PROVIDERS) {
      expect(choices.find((choice) => choice.id === id)).toMatchObject({
        keyPresent: true,
        isOptIn: true,
        enableByDefault: false,
      });
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
      expect(choice!.isOptIn).toBe(false);
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
