import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DIST_DIRECTORY, isMainModule } from '../scripts/clean-dist.mjs';

describe('dist cleanup target', () => {
  it('is anchored to the repository rather than process.cwd()', () => {
    const repositoryDist = fileURLToPath(new URL('../dist/', import.meta.url));
    expect(DIST_DIRECTORY).toBe(repositoryDist);
    expect(DIST_DIRECTORY).not.toBe(resolve(tmpdir(), 'dist'));
  });

  it.skipIf(process.platform === 'win32')(
    'recognizes a symlinked script entrypoint',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'librarium-clean-dist-'));
      const link = join(directory, 'clean-dist.mjs');
      try {
        symlinkSync(
          fileURLToPath(new URL('../scripts/clean-dist.mjs', import.meta.url)),
          link,
        );
        expect(isMainModule(link)).toBe(true);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
