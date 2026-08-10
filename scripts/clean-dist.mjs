import { realpathSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Exact repository build output, independent of the caller's cwd. */
export const DIST_DIRECTORY = fileURLToPath(
  new URL('../dist/', import.meta.url),
);

export function cleanDist() {
  rmSync(DIST_DIRECTORY, { recursive: true, force: true });
}

export function isMainModule(path = process.argv[1]) {
  if (!path) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(path))
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  cleanDist();
}
