import { describe, expect, it } from 'vitest';
import { deduplicateSources, normalizeUrl } from '../src/core/normalizer.js';
import type { Citation } from '../src/types.js';

describe('normalizeUrl', () => {
  it('strips https://', () => {
    expect(normalizeUrl('https://example.com/page')).toBe('example.com/page');
  });

  it('strips http://', () => {
    expect(normalizeUrl('http://example.com/page')).toBe('example.com/page');
  });

  it('strips www.', () => {
    expect(normalizeUrl('https://www.example.com/page')).toBe(
      'example.com/page',
    );
  });

  it('strips trailing slashes', () => {
    expect(normalizeUrl('https://example.com/page/')).toBe('example.com/page');
  });

  it('strips utm_* params', () => {
    const url =
      'https://example.com/page?utm_source=twitter&utm_medium=social&utm_campaign=launch&keep=yes';
    expect(normalizeUrl(url)).toBe('example.com/page?keep=yes');
  });

  it('strips fbclid, gclid, and other tracking params', () => {
    const url =
      'https://example.com/page?fbclid=abc123&gclid=def456&msclkid=ghi789';
    expect(normalizeUrl(url)).toBe('example.com/page');
  });

  it('lowercases hostname', () => {
    expect(normalizeUrl('https://EXAMPLE.COM/Page')).toBe('example.com/Page');
  });

  it('preserves path and non-tracking params', () => {
    const url = 'https://example.com/docs/api?version=3&lang=en';
    expect(normalizeUrl(url)).toBe('example.com/docs/api?version=3&lang=en');
  });

  it('handles malformed URLs gracefully', () => {
    const result = normalizeUrl('not a valid url');
    expect(typeof result).toBe('string');
    expect(result).toBe('not a valid url');
  });
});

describe('deduplicateSources', () => {
  it('merges same URL from different providers', () => {
    const citations: Citation[] = [
      {
        url: 'https://example.com/page',
        title: 'Example Page',
        provider: 'perplexity-sonar',
      },
      {
        url: 'https://www.example.com/page/',
        title: 'Example Page',
        provider: 'brave-answers',
      },
    ];
    const result = deduplicateSources(citations);
    expect(result).toHaveLength(1);
    expect(result[0].citationCount).toBe(2);
    expect(result[0].providers).toContain('perplexity-sonar');
    expect(result[0].providers).toContain('brave-answers');
  });

  it('sorts by citation count descending', () => {
    const citations: Citation[] = [
      { url: 'https://rare.com', provider: 'exa' },
      { url: 'https://popular.com', provider: 'perplexity-sonar' },
      { url: 'https://popular.com', provider: 'brave-answers' },
      { url: 'https://popular.com', provider: 'exa' },
    ];
    const result = deduplicateSources(citations);
    expect(result[0].normalizedUrl).toBe('popular.com');
    expect(result[0].citationCount).toBe(3);
    expect(result[1].normalizedUrl).toBe('rare.com');
    expect(result[1].citationCount).toBe(1);
  });

  it('preserves first title found', () => {
    const citations: Citation[] = [
      {
        url: 'https://example.com',
        title: 'First Title',
        provider: 'perplexity-sonar',
      },
      {
        url: 'https://example.com',
        title: 'Second Title',
        provider: 'brave-answers',
      },
    ];
    const result = deduplicateSources(citations);
    expect(result[0].title).toBe('First Title');
  });

  it('handles empty input', () => {
    const result = deduplicateSources([]);
    expect(result).toHaveLength(0);
  });
});
