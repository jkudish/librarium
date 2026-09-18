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
  const sentinel = 'sentinel-credential-value';
  const credentialProvider = new TestProvider({
    credentials: { env: { BRAVE_ANSWERS_API_KEY: sentinel } },
  });

  describe('formatError', () => {
    it('includes status and body', () => {
      const result = provider.testFormatError(500, { error: 'internal' });
      expect(result).toContain('500');
      expect(result).toContain('internal');
    });

    it('adds hint for 401', () => {
      const result = provider.testFormatError(401, { error: 'unauthorized' });
      expect(result).toContain('401');
      expect(result).toContain('BRAVE_ANSWERS_API_KEY');
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

    it('redacts known credentials and credential-bearing URL parameters before truncating', () => {
      const result = credentialProvider.testFormatError(429, {
        error: `quota rejected ${sentinel}`,
        diagnostic:
          'https://provider.example/request?api_key=upstream-value&attempt=7',
      });

      expect(result).toContain('API returned 429');
      expect(result).toContain('quota rejected [REDACTED]');
      expect(result).toContain('api_key=[REDACTED]&attempt=7');
      expect(result).not.toContain(sentinel);
      expect(result).not.toContain('upstream-value');
    });

    it('does not expose a credential prefix at the truncation boundary', () => {
      const result = credentialProvider.testFormatError(500, {
        error: `${'x'.repeat(175)}${sentinel}`,
      });

      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain(sentinel.slice(0, 8));
    });

    it('handles non-serializable data gracefully', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const result = provider.testFormatError(500, circular);
      expect(result).toContain('500');
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

    it('catches TypeError (common for network failures)', () => {
      const result = provider.testFormatCatchError(
        new TypeError('other network issue'),
      );
      expect(result).toContain('Network error');
    });

    it('catches ENOTFOUND errors', () => {
      const result = provider.testFormatCatchError(
        new Error('getaddrinfo ENOTFOUND api.example.com'),
      );
      expect(result).toContain('Network error');
    });

    it('catches ECONNREFUSED errors', () => {
      const result = provider.testFormatCatchError(
        new Error('connect ECONNREFUSED 127.0.0.1:443'),
      );
      expect(result).toContain('Network error');
    });

    it('catches ETIMEDOUT errors', () => {
      const result = provider.testFormatCatchError(
        new Error('connect ETIMEDOUT 1.2.3.4:443'),
      );
      expect(result).toContain('Network error');
    });

    it('handles non-Error values', () => {
      const result = provider.testFormatCatchError('string error');
      expect(result).toBe('string error');
    });

    it('redacts credentials from non-network exception messages', () => {
      const result = credentialProvider.testFormatCatchError(
        new Error(
          `request ${sentinel} failed at https://provider.example/status?access_token=other-secret&attempt=8`,
        ),
      );

      expect(result).toContain('request [REDACTED] failed');
      expect(result).toContain('access_token=[REDACTED]&attempt=8');
      expect(result).not.toContain(sentinel);
      expect(result).not.toContain('other-secret');
    });
  });
});
