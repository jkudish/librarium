import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import stripAnsiLib from 'strip-ansi';
import {
  buildMockConfig,
  type MockConfigSpec,
} from '../fixtures/config/mock-config.js';

/**
 * PTY smoke-test harness for librarium's interactive flows.
 *
 * Spawns the BUILT cli (`node dist/cli.js …`) inside a real pseudo-terminal so
 * the live table, wizard, browse list, and pager all believe they are talking
 * to a TTY (isTTY true, cursor math active, raw-mode keypresses delivered).
 *
 * Determinism:
 *  - Every run gets a fresh isolated HOME (mkdtemp) seeded with a config.json
 *    built from committed fixtures, so the user's real ~/.config/librarium is
 *    never read or written.
 *  - Providers are offline mock script providers (tests/fixtures/providers),
 *    so there is no network and output is stable.
 *
 * Gating: node-pty is loaded lazily. If it failed to build, {@link ptyAvailable}
 * returns false and tests skip with a clear message instead of crashing.
 */

const CLI_PATH = resolve(
  fileURLToPath(new URL('../../dist/cli.js', import.meta.url)),
);

// Control bytes for feeding the child.
export const KEY = {
  ENTER: '\r',
  UP: '[A',
  DOWN: '[B',
  SPACE: ' ',
  CTRL_C: '',
  ESC: '',
  q: 'q',
  j: 'j',
  k: 'k',
} as const;

export interface PtySession {
  /** Cumulative raw output (with ANSI escapes). */
  output(): string;
  /** Cumulative output with ANSI escapes stripped. */
  plain(): string;
  /** Write raw bytes to the child's stdin. */
  write(data: string): void;
  /** Resolve once `predicate(output)` is true or reject on timeout. */
  waitFor(
    predicate: (output: string) => boolean,
    timeoutMs?: number,
  ): Promise<void>;
  /** Resolve once the substring (ANSI-stripped) appears. */
  waitForText(text: string, timeoutMs?: number): Promise<void>;
  /** Resolve with the exit code + final output once the child exits. */
  waitForExit(timeoutMs?: number): Promise<{ code: number; signal: number }>;
  /**
   * Deliver SIGINT to the child — the deterministic equivalent of Ctrl+C.
   * Writing a raw ETX byte does not reliably trip the PTY line discipline's
   * ISIG handling here (the run spinner never enables raw input), so we send
   * the signal directly, which is exactly what the terminal would generate.
   */
  sigint(): void;
  /** Force-kill the child (cleanup). */
  kill(signal?: string): void;
}

export interface SpawnOptions {
  args: string[];
  config?: MockConfigSpec;
  cols?: number;
  rows?: number;
  cwd?: string;
  /** Extra env on top of the isolated defaults. */
  env?: Record<string, string>;
}

let ptyModule: typeof import('node-pty') | null | undefined;

/**
 * On macOS, node-pty shells out to a prebuilt `spawn-helper` binary. npm
 * extraction has historically stripped its execute bit, which surfaces at
 * runtime as an opaque `posix_spawnp failed`. Restore +x defensively so a
 * fresh `npm install` (locally or in CI) doesn't break the suite.
 */
function ensureSpawnHelperExecutable(pty: typeof import('node-pty')): void {
  if (process.platform !== 'darwin') return;
  try {
    const require = createRequire(import.meta.url);
    const pkgDir = dirname(require.resolve('node-pty/package.json'));
    const candidates = [
      join(pkgDir, 'build', 'Release', 'spawn-helper'),
      join(pkgDir, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper'),
    ];
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const mode = statSync(candidate).mode;
      // Add execute bits for user/group/other if missing.
      if ((mode & 0o111) !== 0o111) {
        chmodSync(candidate, mode | 0o755);
      }
    }
  } catch {
    // Best-effort: if anything here fails, spawning will surface the real error.
  }
  // node-pty caches the module-level reference; touching it is harmless.
  void pty;
}

/** Lazily require node-pty; cache failure as null so gating is cheap. */
function loadPty(): typeof import('node-pty') | null {
  if (ptyModule !== undefined) return ptyModule;
  try {
    const require = createRequire(import.meta.url);
    const mod = require('node-pty') as typeof import('node-pty');
    ensureSpawnHelperExecutable(mod);
    ptyModule = mod;
  } catch {
    ptyModule = null;
  }
  return ptyModule;
}

/** True when PTY tests can run on this platform/build. */
export function ptyAvailable(): boolean {
  if (process.platform === 'win32') return false;
  return loadPty() !== null;
}

/** Reason string for a skipped suite (printed via describe.skip title). */
export function skipReason(): string {
  if (process.platform === 'win32') {
    return 'PTY smoke tests are skipped on Windows';
  }
  return 'PTY smoke tests skipped: node-pty unavailable (failed to build?)';
}

export function stripAnsi(input: string): string {
  return stripAnsiLib(input);
}

/** Count occurrences of a literal substring. */
export function count(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * Create an isolated HOME directory seeded with a librarium config.json built
 * from a committed fixture spec. Returns the HOME path plus a disposer.
 */
export function makeIsolatedHome(config?: MockConfigSpec): {
  home: string;
  dispose: () => void;
} {
  const home = mkdtempSync(join(tmpdir(), 'librarium-pty-'));
  if (config) {
    const configDir = join(home, '.config', 'librarium');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      `${JSON.stringify(buildMockConfig(config), null, 2)}\n`,
    );
  }
  return {
    home,
    dispose: () => rmSync(home, { recursive: true, force: true }),
  };
}

/**
 * Spawn the built CLI in a PTY. Caller is responsible for disposing the
 * returned home dir via the `dispose` callback after the session ends.
 */
export function spawnCli(
  opts: SpawnOptions,
): PtySession & { home: string; dispose: () => void } {
  const pty = loadPty();
  if (!pty) throw new Error('node-pty is not available');

  const { home, dispose } = makeIsolatedHome(opts.config);
  // Run inside the isolated home unless the test needs a specific cwd (e.g. a
  // fixture run directory). cwd must not contain a .librarium.json that could
  // perturb config; the temp HOME is safe.
  const cwd = opts.cwd ?? home;

  let buffer = '';
  let exited = false;
  let exitInfo: { code: number; signal: number } | null = null;
  const exitWaiters: Array<(v: { code: number; signal: number }) => void> = [];

  const child = pty.spawn(process.execPath, [CLI_PATH, ...opts.args], {
    name: 'xterm-256color',
    cols: opts.cols ?? 100,
    rows: opts.rows ?? 30,
    cwd,
    env: {
      // Start from a minimal, deterministic environment.
      PATH: process.env.PATH ?? '',
      HOME: home,
      // Force color + interactive behaviour; live table needs color on.
      FORCE_COLOR: '1',
      TERM: 'xterm-256color',
      // Avoid the user's editor/pager leaking in.
      PAGER: 'cat',
      ...opts.env,
    },
  });

  child.onData((data) => {
    buffer += data;
  });
  child.onExit(({ exitCode, signal }) => {
    exited = true;
    exitInfo = { code: exitCode, signal: signal ?? 0 };
    for (const w of exitWaiters.splice(0)) w(exitInfo);
  });

  const output = (): string => buffer;
  const plain = (): string => stripAnsi(buffer);

  const waitFor = (
    predicate: (output: string) => boolean,
    timeoutMs = 10_000,
  ): Promise<void> =>
    new Promise((resolvePromise, reject) => {
      if (predicate(buffer)) return resolvePromise();
      const start = Date.now();
      const timer = setInterval(() => {
        if (predicate(buffer)) {
          clearInterval(timer);
          resolvePromise();
        } else if (exited) {
          clearInterval(timer);
          reject(
            new Error(
              `child exited before predicate matched.\n--- output ---\n${plain()}`,
            ),
          );
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(
            new Error(
              `waitFor timed out after ${timeoutMs}ms.\n--- output ---\n${plain()}`,
            ),
          );
        }
      }, 25);
    });

  const waitForText = (text: string, timeoutMs?: number): Promise<void> =>
    waitFor((out) => stripAnsi(out).includes(text), timeoutMs);

  const waitForExit = (
    timeoutMs = 15_000,
  ): Promise<{ code: number; signal: number }> =>
    new Promise((resolvePromise, reject) => {
      if (exited && exitInfo) return resolvePromise(exitInfo);
      const timer = setTimeout(() => {
        reject(
          new Error(
            `child did not exit within ${timeoutMs}ms.\n--- output ---\n${plain()}`,
          ),
        );
      }, timeoutMs);
      exitWaiters.push((info) => {
        clearTimeout(timer);
        resolvePromise(info);
      });
    });

  const write = (data: string): void => {
    child.write(data);
  };

  const sigint = (): void => {
    try {
      child.kill('SIGINT');
    } catch {
      // already gone
    }
  };

  const kill = (signal?: string): void => {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  };

  return {
    home,
    dispose,
    output,
    plain,
    write,
    waitFor,
    waitForText,
    waitForExit,
    sigint,
    kill,
  };
}

/** Small async delay for sequencing keystrokes after a prompt settles. */
export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
