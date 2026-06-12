import { describe, expect, it } from 'vitest';
import {
  countDeepResearch,
  DEEP_RESEARCH_CONFIRM_THRESHOLD,
  deepResearchWarning,
  shouldConfirmDeepResearch,
} from '../src/commands/preflight.js';
import type { ProviderTier } from '../src/types.js';

const base = {
  deepResearchCount: DEEP_RESEARCH_CONFIRM_THRESHOLD,
  isTTY: true,
  yes: false,
  fromWizard: false,
};

describe('shouldConfirmDeepResearch', () => {
  it('confirms at or above the threshold in a TTY with no consent', () => {
    expect(shouldConfirmDeepResearch(base)).toBe(true);
    expect(shouldConfirmDeepResearch({ ...base, deepResearchCount: 5 })).toBe(
      true,
    );
  });

  it('does not confirm below the threshold', () => {
    expect(shouldConfirmDeepResearch({ ...base, deepResearchCount: 2 })).toBe(
      false,
    );
    expect(shouldConfirmDeepResearch({ ...base, deepResearchCount: 0 })).toBe(
      false,
    );
  });

  it('never confirms in a non-TTY (pipes/CI never hang or refuse)', () => {
    expect(shouldConfirmDeepResearch({ ...base, isTTY: false })).toBe(false);
    expect(
      shouldConfirmDeepResearch({
        ...base,
        isTTY: false,
        deepResearchCount: 10,
      }),
    ).toBe(false);
  });

  it('skips the confirm when --yes is passed', () => {
    expect(shouldConfirmDeepResearch({ ...base, yes: true })).toBe(false);
  });

  it('skips the confirm when invoked through the wizard', () => {
    expect(shouldConfirmDeepResearch({ ...base, fromWizard: true })).toBe(
      false,
    );
  });
});

describe('countDeepResearch', () => {
  const tierById = new Map<string, ProviderTier>([
    ['openai-deep', 'deep-research'],
    ['gemini-deep', 'deep-research'],
    ['exa', 'ai-grounded'],
    ['brave-search', 'raw-search'],
  ]);

  it('counts only deep-research-tier providers', () => {
    expect(
      countDeepResearch(['openai-deep', 'gemini-deep', 'exa'], tierById),
    ).toBe(2);
    expect(countDeepResearch(['exa', 'brave-search'], tierById)).toBe(0);
    expect(countDeepResearch(['unknown'], tierById)).toBe(0);
  });
});

describe('deepResearchWarning', () => {
  it('lists providers and warns about time and per-call billing, no em-dash', () => {
    const message = deepResearchWarning([
      'openai-deep',
      'gemini-deep',
      'perplexity-deep-research',
    ]);
    expect(message).toContain('openai-deep');
    expect(message).toContain('3 deep-research providers');
    expect(message.toLowerCase()).toContain('bills per call');
    expect(message).not.toContain('—');
  });
});
