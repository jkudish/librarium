import { describe, expect, it } from 'vitest';
import { PerplexityDeepResearchProvider } from '../../src/adapters/perplexity-deep-research.js';

describe('historical Perplexity background evidence lane', () => {
  it('points the retained v1 evidence reference at the durable Agent adapter', () => {
    expect(new PerplexityDeepResearchProvider().preset).toBe('medium');
  });
});
