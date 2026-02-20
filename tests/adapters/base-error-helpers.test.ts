import { describe, expect, it } from 'vitest';
import { BaseProvider } from '../../src/adapters/base.js';
import type {
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../../src/types.js';

class TestProvider extends BaseProvider {
  readonly id = 'brave-answers';
  readonly tier: ProviderTier = 'ai-grounded';

  async execute(_q: string, _o: ProviderOptions): Promise<ProviderResult> {
    throw new Error('not implemented');
  }

  // Expose protected methods for testing
  public testFormatError(status: number, data: unknown): string {
    return this.formatError(status, data);
  }

  public testFormatCatchError(err: unknown): string {
    return this.formatCatchError(err);
  }
}

describe('BaseProvider error helpers', () => {
  const provider = new TestProvider();

  describe('formatError', () => {
    it('includes status and body', () => {
      const result = provider.testFormatError(500, { error: 'internal' });
      expect(result).toContain('500');
      expect(result).toContain('internal');
    });

    it('adds hint for 401', () => {
      const result = provider.testFormatError(401, { error: 'unauthorized' });
      expect(result).toContain('401');
      expect(result).toContain('BRAVE_API_KEY');
      expect(result).toContain('set and valid');
    });

    it('adds hint for 403', () => {
      const result = provider.testFormatError(403, { error: 'forbidden' });
      expect(result).toContain('403');
      expect(result).toContain('lack required permissions');
    });

    it('truncates long response bodies', () => {
      const longData = { error: 'x'.repeat(500) };
      const result = provider.testFormatError(400, longData);
      expect(result.length).toBeLessThan(300);
    });
  });

  describe('formatCatchError', () => {
    it('returns message for normal errors', () => {
      const result = provider.testFormatCatchError(new Error('timeout'));
      expect(result).toBe('timeout');
    });

    it('replaces fetch failed with user-friendly message', () => {
      const result = provider.testFormatCatchError(new Error('fetch failed'));
      expect(result).toContain('Network error');
      expect(result).toContain('Brave AI Answers');
    });

    it('replaces Failed to fetch with user-friendly message', () => {
      const result = provider.testFormatCatchError(
        new Error('Failed to fetch'),
      );
      expect(result).toContain('Network error');
    });

    it('handles non-Error values', () => {
      const result = provider.testFormatCatchError('string error');
      expect(result).toBe('string error');
    });
  });
});
