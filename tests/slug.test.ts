import { describe, expect, it } from 'vitest';
import { generateSlug } from '../src/core/prompt-builder.js';

describe('generateSlug', () => {
  it('converts basic text to slug', () => {
    expect(generateSlug('Hello World')).toBe('hello-world');
  });

  it('strips special characters', () => {
    expect(generateSlug('PostgreSQL: Best Practices!')).toBe(
      'postgresql-best-practices',
    );
  });

  it('collapses multiple hyphens', () => {
    expect(generateSlug('one -- two --- three')).toBe('one-two-three');
  });

  it('strips leading and trailing hyphens', () => {
    expect(generateSlug('--hello world--')).toBe('hello-world');
  });

  it('truncates to 40 chars', () => {
    const long =
      'this is a very long query string that should be truncated to forty characters maximum';
    const slug = generateSlug(long);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toBe('this-is-a-very-long-query-string-that-sh');
  });

  it('handles empty string', () => {
    expect(generateSlug('')).toBe('');
  });

  it('handles all-special-characters string', () => {
    expect(generateSlug('!@#$%^&*()')).toBe('');
  });

  it('handles numbers', () => {
    expect(generateSlug('node 22 features')).toBe('node-22-features');
  });
});
