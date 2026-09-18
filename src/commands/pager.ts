import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { emitKeypressEvents } from 'node:readline';
import { dimText, isColorEnabled, truncateAnsi } from './run-format.js';

/**
 * Minimal hand-rolled fullscreen pager for `librarium browse`.
 *
 * No curses dependency: alternate screen buffer plus raw-mode keypress
 * handling via node:readline. The viewport math (clamping, slicing,
 * status line, key-to-action mapping) is pure and unit-tested; the
 * interactive loop is a thin shell around it.
 *
 * Cursor and screen restore are guaranteed the same way live-table.ts
 * guarantees cursor restore: a single idempotent cleanup runs on normal
 * exit, on thrown errors (keypress handler failures reject through it),
 * on SIGINT, and a last-resort process 'exit' hook rewrites the restore
 * sequences even if cleanup never ran.
 */

const ALT_SCREEN_ON = '\u001b[?1049h';
const ALT_SCREEN_OFF = '\u001b[?1049l';
const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
const CURSOR_HOME = '\u001b[H';
const CLEAR_LINE = '\u001b[2K';

export interface PagerContent {
  /** Shown at the left of the status line (e.g. the provider id). */
  title: string;
  /** Re-render content lines for a terminal width (called on resize). */
  render: (width: number) => string[];
  /** Raw file opened in $PAGER by the `o` key; omit to disable the key. */
  filePath?: string;
}

export interface KeypressEvent {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  sequence?: string;
}

export type PagerAction =
  | { type: 'scroll'; delta: number }
  | { type: 'page'; delta: number }
  | { type: 'top' }
  | { type: 'bottom' }
  | { type: 'open' }
  | { type: 'exit' }
  | { type: 'none' };

/** Map a keypress to a pager action. */
export function actionForKey(key: KeypressEvent): PagerAction {
  if (key.ctrl && key.name === 'c') return { type: 'exit' };
  if (key.ctrl || key.meta) return { type: 'none' };
  switch (key.name) {
    case 'up':
    case 'k':
      return { type: 'scroll', delta: -1 };
    case 'down':
    case 'j':
      return { type: 'scroll', delta: 1 };
    case 'space':
    case 'pagedown':
      return { type: 'page', delta: 1 };
    case 'b':
    case 'pageup':
      return { type: 'page', delta: -1 };
    case 'g':
      return key.shift || key.sequence === 'G'
        ? { type: 'bottom' }
        : { type: 'top' };
    case 'home':
      return { type: 'top' };
    case 'end':
      return { type: 'bottom' };
    case 'q':
    case 'escape':
      return { type: 'exit' };
    case 'o':
      return { type: 'open' };
    default:
      return { type: 'none' };
  }
}

/** Clamp the top line so the viewport never scrolls past the content. */
export function clampTopLine(
  topLine: number,
  totalLines: number,
  viewHeight: number,
): number {
  const max = Math.max(0, totalLines - viewHeight);
  return Math.min(Math.max(0, topLine), max);
}

/** Apply a movement action to the top line (returns the clamped result). */
export function applyAction(
  action: PagerAction,
  topLine: number,
  totalLines: number,
  viewHeight: number,
): number {
  let next = topLine;
  switch (action.type) {
    case 'scroll':
      next = topLine + action.delta;
      break;
    case 'page':
      next = topLine + action.delta * Math.max(1, viewHeight - 1);
      break;
    case 'top':
      next = 0;
      break;
    case 'bottom':
      next = totalLines;
      break;
    default:
      break;
  }
  return clampTopLine(next, totalLines, viewHeight);
}

/** Slice the visible window, padded with empty lines to fill the height. */
export function sliceViewport(
  lines: string[],
  topLine: number,
  viewHeight: number,
): string[] {
  const out = lines.slice(topLine, topLine + viewHeight);
  while (out.length < viewHeight) out.push('');
  return out;
}

/** Position label: "all", "top"/"bot", or a percentage with line counts. */
export function positionLabel(
  topLine: number,
  viewHeight: number,
  totalLines: number,
): string {
  if (totalLines <= viewHeight) return 'all';
  const bottom = Math.min(totalLines, topLine + viewHeight);
  if (topLine <= 0) return `top ${bottom}/${totalLines}`;
  if (bottom >= totalLines) return `bot ${totalLines}/${totalLines}`;
  return `${Math.round((bottom / totalLines) * 100)}% ${bottom}/${totalLines}`;
}

const KEY_HINTS =
  'j/k scroll · space/b page · g/G top/bottom · o $PAGER · q back';

export interface StatusLineInput {
  title: string;
  topLine: number;
  viewHeight: number;
  totalLines: number;
  width: number;
  color: boolean;
  /** Transient notice (e.g. a pager spawn failure) shown over the hints. */
  message?: string;
}

/** Dim single-line status bar, truncated to the terminal width. */
export function buildStatusLine(input: StatusLineInput): string {
  const position = positionLabel(
    input.topLine,
    input.viewHeight,
    input.totalLines,
  );
  const tail = input.message ?? KEY_HINTS;
  const body = ` ${input.title}  ${position}  ${tail}`;
  return truncateAnsi(dimText(body, input.color), input.width);
}

/** Open a file in $PAGER (fallback `less -R`); returns an error message or null. */
export function openInSystemPager(filePath: string): string | null {
  if (!existsSync(filePath)) return `File not found: ${filePath}`;
  const pagerEnv = process.env.PAGER?.trim();
  const parts =
    pagerEnv && pagerEnv.length > 0 ? pagerEnv.split(/\s+/) : ['less', '-R'];
  const [command, ...args] = parts as [string, ...string[]];
  const result = spawnSync(command, [...args, filePath], { stdio: 'inherit' });
  if (result.error) {
    return `Could not open pager (${command}): ${result.error.message}`;
  }
  return null;
}

/** Streams already decorated by emitKeypressEvents (avoid double decoding). */
const keypressDecorated = new WeakSet<NodeJS.ReadStream>();

/**
 * Run the fullscreen pager until the user exits (q, escape, or Ctrl+C).
 * Only meaningful in a TTY; as a defensive fallback, non-TTY streams get
 * the rendered content printed once instead.
 */
export async function runPager(content: PagerContent): Promise<void> {
  const stdout = process.stdout;
  const stdin = process.stdin;
  if (!stdout.isTTY || !stdin.isTTY) {
    stdout.write(`${content.render(80).join('\n')}\n`);
    return;
  }

  const color = isColorEnabled(stdout);
  let width = stdout.columns ?? 80;
  let rows = stdout.rows ?? 24;
  let lines = content.render(width);
  let topLine = 0;
  let message: string | undefined;

  const viewHeight = (): number => Math.max(1, rows - 1);

  const draw = (): void => {
    const height = viewHeight();
    topLine = clampTopLine(topLine, lines.length, height);
    const body = sliceViewport(lines, topLine, height)
      .map((line) => `${CLEAR_LINE}${truncateAnsi(line, width)}`)
      .join('\r\n');
    const status = buildStatusLine({
      title: content.title,
      topLine,
      viewHeight: height,
      totalLines: lines.length,
      width,
      color,
      message,
    });
    stdout.write(`${CURSOR_HOME}${body}\r\n${CLEAR_LINE}${status}`);
  };

  const enterScreen = (): void => {
    stdout.write(ALT_SCREEN_ON + HIDE_CURSOR);
  };
  const leaveScreen = (): void => {
    stdout.write(SHOW_CURSOR + ALT_SCREEN_OFF);
  };

  if (!keypressDecorated.has(stdin)) {
    emitKeypressEvents(stdin);
    keypressDecorated.add(stdin);
  }
  const wasRaw = stdin.isRaw;

  await new Promise<void>((resolve, reject) => {
    let finished = false;

    // Last-resort restore if the process dies while the pager is active
    // ('exit' does not fire on an unhandled SIGINT — same lesson as
    // live-table.ts).
    const restoreOnExit = (): void => {
      leaveScreen();
    };
    const restoreOnSigint = (): void => {
      cleanup();
      process.exit(130);
    };

    const cleanup = (): void => {
      if (finished) return;
      finished = true;
      stdin.removeListener('keypress', onKeypress);
      stdout.removeListener('resize', onResize);
      process.removeListener('exit', restoreOnExit);
      process.removeListener('SIGINT', restoreOnSigint);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      leaveScreen();
    };

    const finish = (): void => {
      cleanup();
      resolve();
    };
    const fail = (error: unknown): void => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    /** Hand the terminal to $PAGER, then restore the pager screen. */
    const openExternal = (): void => {
      if (!content.filePath) return;
      stdin.setRawMode(false);
      stdin.pause();
      leaveScreen();
      const error = openInSystemPager(content.filePath);
      enterScreen();
      stdin.setRawMode(true);
      stdin.resume();
      message = error ?? undefined;
      draw();
    };

    const onKeypress = (
      _input: string | undefined,
      key: KeypressEvent | undefined,
    ): void => {
      try {
        const action = actionForKey(key ?? {});
        if (action.type === 'none') return;
        message = undefined;
        if (action.type === 'exit') {
          finish();
          return;
        }
        if (action.type === 'open') {
          openExternal();
          return;
        }
        topLine = applyAction(action, topLine, lines.length, viewHeight());
        draw();
      } catch (error) {
        fail(error);
      }
    };

    // SIGWINCH surfaces as 'resize' on stdout: re-wrap to the new width.
    const onResize = (): void => {
      try {
        width = stdout.columns ?? 80;
        rows = stdout.rows ?? 24;
        lines = content.render(width);
        draw();
      } catch (error) {
        fail(error);
      }
    };

    try {
      enterScreen();
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('keypress', onKeypress);
      stdout.on('resize', onResize);
      process.once('exit', restoreOnExit);
      process.once('SIGINT', restoreOnSigint);
      draw();
    } catch (error) {
      fail(error);
    }
  });
}
