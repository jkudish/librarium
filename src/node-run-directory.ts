import { mkdirSync } from 'node:fs';

/** Injectable dependencies for unique run-directory creation. */
export interface CreateRunDirDeps {
  /** Current time in milliseconds. Defaults to Date.now. */
  now?: () => number;
  /** Short random suffix generator. Defaults to a base36 fragment. */
  randomSuffix?: () => string;
  /** Exclusive directory creator. Defaults to mkdirSync. */
  mkdir?: (dir: string) => void;
}

function defaultRandomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Create a unique run directory and return its absolute path.
 *
 * This filesystem service intentionally lives outside `librarium/core`; the
 * pure prompt and output-path helpers remain usable in Workers.
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

  mkdirSync(baseDir, { recursive: true });

  const maxAttempts = 50;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const milliseconds = now();
    const seconds = Math.floor(milliseconds / 1_000);
    const millis = milliseconds % 1_000;
    const dirName = `${seconds}-${slug}-${String(millis).padStart(3, '0')}${randomSuffix()}`;
    const dir = `${baseDir}${separator}${dirName}`;
    try {
      mkdir(dir);
      return dir;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') throw error;
      lastError = error;
    }
  }

  throw new Error(
    `Failed to create a unique run directory under ${baseDir} after ${maxAttempts} attempts${
      lastError instanceof Error ? `: ${lastError.message}` : ''
    }`,
  );
}
