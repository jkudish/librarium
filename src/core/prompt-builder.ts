import { mkdirSync } from 'node:fs';
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
  const separator = baseDir.endsWith('/') || baseDir.endsWith('\\') ? '' : '/';
  return `${baseDir}${separator}${dirName}`;
}

/** Injectable deps for {@link createRunDir} so collisions are testable. */
export interface CreateRunDirDeps {
  /** Current time in ms. Defaults to Date.now. */
  now?: () => number;
  /** Short random suffix generator. Defaults to a base36 fragment. */
  randomSuffix?: () => string;
  /** Exclusive directory creator. Defaults to mkdirSync. */
  mkdir?: (dir: string) => void;
}

/** Default short random suffix: a few base36 characters. */
function defaultRandomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Create a unique run directory and return its absolute path. The directory
 * name embeds a millisecond timestamp plus a short random suffix so that
 * concurrent runs of the same query in the same second never share a
 * directory. Creation uses exclusive mkdir ({ recursive: false }) and retries
 * with a fresh suffix on collision (EEXIST), so the returned directory is the
 * one this call actually created. Callers should record this exact path in the
 * manifest.
 *
 * The leading second-granularity timestamp prefix is preserved so existing
 * sort/discovery by directory name keeps working; uniqueness comes from the
 * millisecond + random tail.
 */
export function createRunDir(
  baseDir: string,
  slug: string,
  deps: CreateRunDirDeps = {},
): string {
  const now = deps.now ?? Date.now;
  const randomSuffix = deps.randomSuffix ?? defaultRandomSuffix;
  const mkdir =
    deps.mkdir ?? ((dir: string) => mkdirSync(dir, { recursive: false }));
  const separator = baseDir.endsWith('/') || baseDir.endsWith('\\') ? '' : '/';

  // Ensure the base directory exists (recursive is fine here; it is shared).
  mkdirSync(baseDir, { recursive: true });

  const MAX_ATTEMPTS = 50;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const ms = now();
    const seconds = Math.floor(ms / 1000);
    const millis = ms % 1000;
    const dirName = `${seconds}-${slug}-${String(millis).padStart(3, '0')}${randomSuffix()}`;
    const dir = `${baseDir}${separator}${dirName}`;
    try {
      mkdir(dir);
      return dir;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') throw e;
      lastError = e;
    }
  }
  throw new Error(
    `Failed to create a unique run directory under ${baseDir} after ${MAX_ATTEMPTS} attempts${
      lastError instanceof Error ? `: ${lastError.message}` : ''
    }`,
  );
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
