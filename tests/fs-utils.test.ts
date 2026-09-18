import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeWriteFile } from '../src/core/fs-utils.js';

const fsFault = vi.hoisted(() => ({
  remaining: 0,
  error: undefined as NodeJS.ErrnoException | undefined,
  renameCalls: [] as Array<{ temporaryPath: string; destinationPath: string }>,
  unlinkCalls: [] as string[],
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      fsFault.renameCalls.push({
        temporaryPath: String(args[0]),
        destinationPath: String(args[1]),
      });
      if (fsFault.remaining > 0) {
        fsFault.remaining -= 1;
        throw fsFault.error;
      }
      return actual.renameSync(...args);
    },
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      fsFault.unlinkCalls.push(String(args[0]));
      return actual.unlinkSync(...args);
    },
  };
});

describe('safeWriteFile', () => {
  let directory: string;
  let destinationPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'librarium-fs-utils-'));
    destinationPath = join(directory, 'artifact.json');
    writeFileSync(destinationPath, 'original');
    fsFault.remaining = 0;
    fsFault.error = undefined;
    fsFault.renameCalls.length = 0;
    fsFault.unlinkCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])(
    'retries transient Windows rename %s failures against the same temp file',
    (code) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
      fsFault.remaining = 2;
      fsFault.error = Object.assign(new Error(`injected ${code}`), {
        code,
        syscall: 'rename',
      });

      safeWriteFile(destinationPath, `replacement-${code}`);

      expect(readFileSync(destinationPath, 'utf8')).toBe(`replacement-${code}`);
      expect(fsFault.renameCalls).toHaveLength(3);
      expect(
        new Set(fsFault.renameCalls.map((call) => call.temporaryPath)).size,
      ).toBe(1);
      expect(
        fsFault.renameCalls.every(
          (call) => call.destinationPath === destinationPath,
        ),
      ).toBe(true);
      expect(wait).toHaveBeenCalledTimes(2);
      expect(wait.mock.calls.map((call) => call[3])).toEqual([20, 20]);
      expect(fsFault.unlinkCalls).toEqual([]);
      expect(readdirSync(directory)).toEqual(['artifact.json']);
    },
  );

  it('fails closed after the bounded Windows rename retry budget', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    const injected = Object.assign(new Error('injected EBUSY'), {
      code: 'EBUSY',
      syscall: 'rename',
    });
    fsFault.remaining = 6;
    fsFault.error = injected;

    let thrown: unknown;
    try {
      safeWriteFile(destinationPath, 'must-not-commit');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(injected);
    expect(fsFault.renameCalls).toHaveLength(6);
    expect(wait).toHaveBeenCalledTimes(5);
    expect(readFileSync(destinationPath, 'utf8')).toBe('original');
    expect(fsFault.unlinkCalls).toEqual([
      fsFault.renameCalls[0]?.temporaryPath,
    ]);
    expect(readdirSync(directory)).toEqual(['artifact.json']);
  });

  it.each([
    ['darwin', 'EPERM', 'rename'],
    ['win32', 'ENOENT', 'rename'],
    ['win32', 'EPERM', 'open'],
  ] as const)(
    'does not retry %s %s failures from %s',
    (platform, code, syscall) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
      const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
      const injected = Object.assign(new Error(`injected ${code}`), {
        code,
        syscall,
      });
      fsFault.remaining = 1;
      fsFault.error = injected;

      let thrown: unknown;
      try {
        safeWriteFile(destinationPath, 'must-not-commit');
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(injected);
      expect(fsFault.renameCalls).toHaveLength(1);
      expect(wait).not.toHaveBeenCalled();
      expect(readFileSync(destinationPath, 'utf8')).toBe('original');
      expect(fsFault.unlinkCalls).toEqual([
        fsFault.renameCalls[0]?.temporaryPath,
      ]);
      expect(readdirSync(directory)).toEqual(['artifact.json']);
    },
  );
});
