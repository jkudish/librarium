import { randomUUID } from 'node:crypto';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * Atomically write a file by writing to a temp file and renaming.
 */
export function safeWriteFile(
  path: string,
  content: string,
  options?: { mode?: number },
): void {
  const tmp = `${path}.tmp.${randomUUID().slice(0, 8)}`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf-8', mode: options?.mode });
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
