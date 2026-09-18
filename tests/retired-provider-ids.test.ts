import { describe, expect, it } from 'vitest';
import {
  migrateRetiredProviderId,
  RETIRED_PROVIDER_REPLACEMENTS,
  retiredProviderMigrationPriority,
} from '../src/core/retired-provider-ids.js';

describe('retired provider tombstones', () => {
  it('is immutable and maps every retired id to its replacement', () => {
    expect(Object.isFrozen(RETIRED_PROVIDER_REPLACEMENTS)).toBe(true);
    expect(RETIRED_PROVIDER_REPLACEMENTS).toEqual({
      'perplexity-sonar': 'perplexity-sonar-pro',
      'perplexity-deep': 'perplexity-sonar-deep',
      'perplexity-pro-search': 'perplexity-sonar-pro',
      'perplexity-advanced-deep': 'perplexity-sonar-deep',
      'openai-deep': 'openai-research',
      'openai-deep-o3': 'openai-research',
    });
  });

  it('keeps canonical OpenAI config ahead of o3 and deep aliases', () => {
    const ids = ['openai-deep', 'openai-research', 'openai-deep-o3'];
    expect(
      [...ids].sort(
        (left, right) =>
          retiredProviderMigrationPriority(
            left,
            migrateRetiredProviderId(left),
          ) -
          retiredProviderMigrationPriority(
            right,
            migrateRetiredProviderId(right),
          ),
      ),
    ).toEqual(['openai-research', 'openai-deep-o3', 'openai-deep']);
  });
});
