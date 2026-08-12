import { randomUUID } from 'node:crypto';
import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

export const RUN_JSON_FILE = 'run.json';
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 20;
const WINDOWS_LOCK_TRANSIENT_RETRIES = 5;
const lockWaitArray = new Int32Array(new SharedArrayBuffer(4));

export class RunJsonLockError extends Error {
  constructor(readonly manifestPath: string) {
    super(
      'Timed out waiting for the run.json mutation lock; if the recorded owner crashed, remove this lock file manually after confirming no Librarium process is using the run',
    );
    this.name = 'RunJsonLockError';
  }
}

/** Shared cross-process lock for v2 compatibility and canonical v3 CAS. */
export function withRunJsonLock<T>(manifestPath: string, action: () => T): T {
  const lockPath = `${manifestPath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const token = randomUUID();
  let descriptor: number | undefined;
  let windowsTransientRetries = 0;
  while (descriptor === undefined) {
    try {
      const candidate = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(
          candidate,
          JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }),
        );
        descriptor = candidate;
      } catch (error) {
        closeSync(candidate);
        try {
          unlinkSync(lockPath);
        } catch {}
        throw error;
      }
    } catch (error) {
      const lockError = error as NodeJS.ErrnoException;
      const code = lockError.code;
      const windowsTransient =
        process.platform === 'win32' &&
        code === 'EPERM' &&
        lockError.syscall === 'open' &&
        windowsTransientRetries < WINDOWS_LOCK_TRANSIENT_RETRIES;
      if (code !== 'EEXIST' && !windowsTransient) throw error;
      if (windowsTransient) windowsTransientRetries += 1;
      if (Date.now() >= deadline) throw new RunJsonLockError(manifestPath);
      Atomics.wait(lockWaitArray, 0, 0, LOCK_POLL_MS);
    }
  }
  try {
    return action();
  } finally {
    closeSync(descriptor);
    try {
      const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        token?: string;
      };
      if (owner.token === token) unlinkSync(lockPath);
    } catch {
      // A dead-owner recovery or manual cleanup may already have removed it.
    }
  }
}
