import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

interface SafeWriteFileOptions {
  readonly mode?: number;
  /** Require Unix owner-only permissions before the rename commits the file. */
  readonly ownerOnly?: boolean;
}

/**
 * Atomically write a file by writing to a temp file and renaming.
 *
 * When ownerOnly is set, this intentionally supports Unix permission bits
 * only. Callers must reject Windows before touching the destination because
 * this helper does not establish a Windows ACL equivalent to mode 0600.
 */
export function safeWriteFile(
  path: string,
  content: string,
  options?: SafeWriteFileOptions,
): void {
  if (options?.ownerOnly && process.platform === 'win32') {
    throw new Error('Owner-only writes are unsupported on Windows.');
  }
  const expectedMode = options?.ownerOnly ? 0o600 : options?.mode;
  if (
    options?.ownerOnly &&
    options.mode !== undefined &&
    options.mode !== 0o600
  ) {
    throw new Error('Owner-only writes require mode 600.');
  }
  const tmp = `${path}.tmp.${randomUUID().slice(0, 8)}`;
  try {
    // wx makes temp-file creation exclusive even if a random-name collision
    // or a pre-existing symlink is present.
    writeFileSync(tmp, content, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: expectedMode,
    });
    if (expectedMode !== undefined) {
      // The mode argument is subject to umask; chmod and verify the exact
      // final bits while the file is still uncommitted.
      chmodSync(tmp, expectedMode);
      if ((statSync(tmp).mode & 0o777) !== expectedMode) {
        throw new Error(
          `Temporary file mode must be ${expectedMode.toString(8)}.`,
        );
      }
    }
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}
