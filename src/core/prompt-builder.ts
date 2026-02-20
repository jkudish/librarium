import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_SLUG_LENGTH } from '../constants.js';

/**
 * Generate a slug from query text.
 * Lowercase, hyphens, max 40 chars.
 */
export function generateSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
}

/**
 * Resolve output directory with timestamp prefix.
 * Creates: {baseDir}/{timestamp}-{slug}/
 */
export function resolveOutputDir(baseDir: string, slug: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const dirName = `${timestamp}-${slug}`;
  const outputDir = join(baseDir, dirName);
  mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

/**
 * Build the research prompt that gets saved to prompt.md
 */
export function buildPrompt(query: string): string {
  return [
    '# Research Query',
    '',
    query,
    '',
    '---',
    '',
    `*Dispatched by librarium at ${new Date().toISOString()}*`,
    '',
  ].join('\n');
}
