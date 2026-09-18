import { Marked, type Tokens } from 'marked';
import { hyperlink } from './run-format.js';

/**
 * Pure ANSI markdown renderer for the in-terminal reader in
 * `librarium browse`. Mirrors the html-report.ts pattern: a custom marked
 * renderer, except it emits ANSI-styled terminal text instead of HTML.
 * No I/O here so everything stays unit-testable.
 *
 * Provider output is untrusted: control characters (including raw ESC
 * bytes) are stripped from the source before lexing so content can never
 * inject its own escape sequences, and raw HTML tokens are rendered as
 * plain text instead of being interpreted.
 */

export interface MarkdownAnsiOptions {
  /** Emit ANSI styling. When false the output is plain wrapped text. */
  color: boolean;
  /** Hard-wrap width in visible columns. */
  width: number;
  /** Emit OSC 8 hyperlinks for links. Defaults to the color flag. */
  hyperlinks?: boolean;
}

type ResolvedOptions = Required<MarkdownAnsiOptions>;

const SGR = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  italic: '\u001b[3m',
  underline: '\u001b[4m',
  strike: '\u001b[9m',
  cyan: '\u001b[36m',
  boldDimOff: '\u001b[22m',
  italicOff: '\u001b[23m',
  underlineOff: '\u001b[24m',
  strikeOff: '\u001b[29m',
  fgOff: '\u001b[39m',
} as const;

/** Strip control characters (except newline and tab) from untrusted input. */
function sanitizeControlChars(content: string): string {
  return content.replace(/\r\n?/g, '\n').replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping untrusted control bytes is the point
    /[\u0000-\u0008\u000b-\u001f\u007f]/g,
    '',
  );
}

interface AnsiSegment {
  kind: 'ansi' | 'char';
  value: string;
}

/**
 * Split a string into zero-width ANSI escape sequences and visible
 * characters. Uses the same CSI/OSC boundary rules as truncateAnsi in
 * run-format.ts so OSC 8 hyperlinks are never split mid-sequence.
 */
function splitAnsiSegments(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '\u001b') {
      let j = i + 1;
      if (text[j] === '[') {
        // CSI: ESC [ ... final alphabetic byte.
        j++;
        while (j < text.length && !/[a-zA-Z]/.test(text[j] as string)) j++;
        j++; // include the final byte
      } else if (
        text[j] === ']' ||
        text[j] === 'P' ||
        text[j] === 'X' ||
        text[j] === '^' ||
        text[j] === '_'
      ) {
        // OSC/DCS/SOS/PM/APC: runs until ST (ESC \) or BEL.
        j++;
        while (j < text.length) {
          if (text[j] === '\u0007') {
            j++;
            break;
          }
          if (text[j] === '\u001b' && text[j + 1] === '\\') {
            j += 2;
            break;
          }
          j++;
        }
      } else {
        j++;
      }
      segments.push({ kind: 'ansi', value: text.slice(i, j) });
      i = j;
      continue;
    }
    segments.push({ kind: 'char', value: char });
    i++;
  }
  return segments;
}

/** Visible width of a string, ignoring ANSI escape sequences. */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const segment of splitAnsiSegments(text)) {
    if (segment.kind === 'char') width++;
  }
  return width;
}

/** SGR off-codes mapped to the attribute codes they cancel. */
const SGR_OFF: Record<number, (code: number) => boolean> = {
  22: (code) => code === 1 || code === 2,
  23: (code) => code === 3,
  24: (code) => code === 4,
  29: (code) => code === 9,
  39: (code) => code >= 30 && code <= 38,
  49: (code) => code >= 40 && code <= 48,
};

/**
 * Tracks active SGR attributes and the open OSC 8 hyperlink across a wrap,
 * so each wrapped line can be closed and the next one reopened with the
 * same styles. Lines stay self-contained, which matters for a pager that
 * renders arbitrary slices of them.
 */
class StyleState {
  private sgr: number[] = [];
  private link: string | null = null;

  apply(sequence: string): void {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: parsing ANSI escapes is the point
    const csi = sequence.match(/^\u001b\[([0-9;]*)m$/);
    if (csi) {
      const params =
        csi[1] === '' ? [0] : (csi[1] as string).split(';').map(Number);
      for (const param of params) {
        if (param === 0) {
          this.sgr = [];
        } else if (SGR_OFF[param]) {
          const cancels = SGR_OFF[param];
          this.sgr = this.sgr.filter((code) => !cancels(code));
        } else if (!this.sgr.includes(param)) {
          this.sgr.push(param);
        }
      }
      return;
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: parsing ANSI escapes is the point
    const osc = sequence.match(/^\u001b\]8;;(.*?)(?:\u0007|\u001b\\)$/s);
    if (osc !== null) {
      this.link = (osc[1] as string) === '' ? null : (osc[1] as string);
    }
  }

  /** Sequences that close every active style (appended at a line break). */
  closing(): string {
    let out = '';
    if (this.link !== null) out += '\u001b]8;;\u001b\\';
    if (this.sgr.length > 0) out += SGR.reset;
    return out;
  }

  /** Sequences that reopen the active styles (prepended to the next line). */
  opening(): string {
    let out = '';
    if (this.link !== null) out += `\u001b]8;;${this.link}\u001b\\`;
    for (const code of this.sgr) out += `\u001b[${code}m`;
    return out;
  }
}

interface Word {
  segments: AnsiSegment[];
  width: number;
}

/**
 * Hard-wrap text to a maximum visible width. ANSI escape sequences are
 * zero-width and never split; OSC 8 hyperlinks and SGR styles that span a
 * break are closed at the end of the line and reopened on the next one.
 * Words longer than the width are hard-broken at the width boundary.
 * Existing newlines are honored as forced breaks.
 */
export function wrapAnsi(text: string, width: number): string[] {
  if (width <= 0) return text.split('\n');
  const lines: string[] = [];
  const state = new StyleState();

  for (const rawLine of text.split('\n')) {
    const words = splitWords(rawLine);
    let line = state.opening();
    let lineWidth = 0;

    const flush = (): void => {
      lines.push(line + state.closing());
      line = state.opening();
      lineWidth = 0;
    };

    const appendSegments = (segments: AnsiSegment[]): void => {
      for (const segment of segments) {
        if (segment.kind === 'ansi') {
          line += segment.value;
          state.apply(segment.value);
          continue;
        }
        if (lineWidth >= width) flush();
        line += segment.value;
        lineWidth++;
      }
    };

    for (const word of words) {
      const separator = lineWidth > 0 ? 1 : 0;
      if (lineWidth + separator + word.width <= width) {
        if (separator) {
          line += ' ';
          lineWidth++;
        }
        appendSegments(word.segments);
        continue;
      }
      if (lineWidth > 0) flush();
      appendSegments(word.segments);
    }
    lines.push(line + state.closing());
  }
  return lines;
}

/** Split a single line into words; ANSI sequences attach to the current word. */
function splitWords(line: string): Word[] {
  const words: Word[] = [];
  let current: Word = { segments: [], width: 0 };
  for (const segment of splitAnsiSegments(line)) {
    if (segment.kind === 'char' && segment.value === ' ') {
      if (current.segments.length > 0) {
        words.push(current);
        current = { segments: [], width: 0 };
      }
      continue;
    }
    current.segments.push(segment);
    if (segment.kind === 'char') current.width++;
  }
  if (current.segments.length > 0) words.push(current);
  return words;
}

function paint(text: string, on: string, off: string, color: boolean): string {
  return color ? `${on}${text}${off}` : text;
}

/** Strip every ANSI escape sequence, keeping only visible characters. */
function stripAnsiSequences(text: string): string {
  return splitAnsiSegments(text)
    .filter((segment) => segment.kind === 'char')
    .map((segment) => segment.value)
    .join('');
}

function styleHeadingLine(line: string, depth: number, color: boolean): string {
  if (!color) return line;
  if (depth === 1) {
    return `${SGR.bold}${SGR.underline}${line}${SGR.underlineOff}${SGR.boldDimOff}`;
  }
  if (depth === 2) {
    return `${SGR.bold}${SGR.cyan}${line}${SGR.fgOff}${SGR.boldDimOff}`;
  }
  return `${SGR.bold}${line}${SGR.boldDimOff}`;
}

/** Render a token list (block level) with the given options. */
function renderTokens(
  tokens: Tokens.Generic[],
  options: ResolvedOptions,
): string {
  const marked = new Marked({
    renderer: createAnsiRenderer(options),
    gfm: true,
  });
  return marked.parser(tokens as any);
}

/** Custom marked renderer that emits ANSI-styled terminal text. */
function createAnsiRenderer(options: ResolvedOptions): any {
  const { color, width, hyperlinks } = options;
  const dim = (text: string): string =>
    paint(text, SGR.dim, SGR.boldDimOff, color);

  return {
    space(): string {
      return '';
    },

    heading(token: Tokens.Heading): string {
      // Inline styling inside a heading would fight the heading's own
      // bold (off-codes like 22m cancel it), so headings render plain
      // text and style the whole line.
      const body = stripAnsiSequences(
        (this as any).parser.parseInline(token.tokens),
      );
      const lines = wrapAnsi(body, width).map((line) =>
        styleHeadingLine(line, token.depth, color),
      );
      return `${lines.join('\n')}\n\n`;
    },

    paragraph(token: Tokens.Paragraph): string {
      const body = (this as any).parser.parseInline(token.tokens);
      return `${wrapAnsi(body, width).join('\n')}\n\n`;
    },

    code(token: Tokens.Code): string {
      // Code is never re-wrapped; the pager truncates long lines.
      const lines = token.text
        .replace(/\n+$/, '')
        .split('\n')
        .map((line) => dim(`  ${line}`));
      return `${lines.join('\n')}\n\n`;
    },

    blockquote(token: Tokens.Blockquote): string {
      const inner = renderTokens(token.tokens, {
        ...options,
        width: Math.max(10, width - 2),
      });
      const lines = inner
        .replace(/\n+$/, '')
        .split('\n')
        .map((line) => (line ? `${dim('| ')}${line}` : dim('|')));
      return `${lines.join('\n')}\n\n`;
    },

    list(token: Tokens.List): string {
      const lines: string[] = [];
      token.items.forEach((item, index) => {
        const marker = token.ordered
          ? `${(typeof token.start === 'number' ? token.start : 1) + index}. `
          : '• ';
        const indent = ' '.repeat(marker.length);
        let inner = renderTokens(item.tokens, {
          ...options,
          width: Math.max(10, width - marker.length),
        }).replace(/\n+$/, '');
        // Tight lists drop the blank line between an item's text and any
        // nested list; loose lists keep their paragraph spacing.
        if (!token.loose) inner = inner.replace(/\n{2,}/g, '\n');
        inner.split('\n').forEach((line, lineIndex) => {
          if (lineIndex === 0) {
            lines.push(`${marker}${line}`);
          } else {
            lines.push(line ? `${indent}${line}` : '');
          }
        });
      });
      return `${lines.join('\n')}\n\n`;
    },

    checkbox(token: { checked: boolean }): string {
      return token.checked ? '[x] ' : '[ ] ';
    },

    hr(): string {
      return `${dim('─'.repeat(Math.max(1, width)))}\n\n`;
    },

    html(token: Tokens.HTML | Tokens.Tag): string {
      // Raw HTML is untrusted: never interpreted, shown as plain text.
      if (!token.block) return token.text;
      const text = token.text.replace(/\n+$/, '');
      return `${wrapAnsi(text, width).join('\n')}\n\n`;
    },

    table(token: Tokens.Table): string {
      const inline = (tokens: Tokens.Generic[]): string =>
        (this as any).parser.parseInline(tokens);
      const header = token.header.map((cell) => inline(cell.tokens));
      const rows = token.rows.map((row) =>
        row.map((cell) => inline(cell.tokens)),
      );
      const colWidths = header.map((cell, column) =>
        Math.max(
          visibleWidth(cell),
          ...rows.map((row) => visibleWidth(row[column] ?? '')),
        ),
      );
      const pad = (text: string, target: number): string =>
        text + ' '.repeat(Math.max(0, target - visibleWidth(text)));
      const formatRow = (cells: string[]): string =>
        cells
          .map((cell, column) => pad(cell, colWidths[column] ?? 0))
          .join('  ')
          .trimEnd();
      const total = Math.min(
        width,
        colWidths.reduce((sum, w) => sum + w, 0) +
          2 * Math.max(0, colWidths.length - 1),
      );
      const lines = [
        paint(formatRow(header), SGR.bold, SGR.boldDimOff, color),
        dim('─'.repeat(Math.max(1, total))),
        ...rows.map(formatRow),
      ];
      return `${lines.join('\n')}\n\n`;
    },

    // --- inline renderers ---

    text(token: Tokens.Text | Tokens.Escape): string {
      if ('tokens' in token && token.tokens) {
        // Block-level text (e.g. a tight list item's body): the parser
        // routes it straight to renderer.text, so wrap it like a paragraph.
        const body = (this as any).parser.parseInline(token.tokens);
        return `${wrapAnsi(body, width).join('\n')}\n\n`;
      }
      return token.text;
    },

    strong(token: Tokens.Strong): string {
      const body = (this as any).parser.parseInline(token.tokens);
      return paint(body, SGR.bold, SGR.boldDimOff, color);
    },

    em(token: Tokens.Em): string {
      const body = (this as any).parser.parseInline(token.tokens);
      return paint(body, SGR.italic, SGR.italicOff, color);
    },

    del(token: Tokens.Del): string {
      const body = (this as any).parser.parseInline(token.tokens);
      return paint(body, SGR.strike, SGR.strikeOff, color);
    },

    codespan(token: Tokens.Codespan): string {
      return dim(token.text);
    },

    br(): string {
      return '\n';
    },

    link(token: Tokens.Link): string {
      const body = (this as any).parser.parseInline(token.tokens);
      if (hyperlinks) return hyperlink(body, token.href, true);
      const plainBody = stripAnsiSequences(body);
      if (plainBody === token.href) return body;
      return `${body} ${dim(`(${token.href})`)}`;
    },

    image(token: Tokens.Image): string {
      const label = token.text || 'image';
      if (hyperlinks) return hyperlink(label, token.href, true);
      return `${label} ${dim(`(${token.href})`)}`;
    },
  };
}

/**
 * Render markdown to ANSI-styled terminal text, hard-wrapped to `width`
 * visible columns. With `color: false` the output is plain wrapped text.
 */
export function renderMarkdownAnsi(
  content: string,
  options: MarkdownAnsiOptions,
): string {
  const resolved: ResolvedOptions = {
    color: options.color,
    width: Math.max(1, options.width),
    hyperlinks: options.hyperlinks ?? options.color,
  };
  const marked = new Marked({
    renderer: createAnsiRenderer(resolved),
    gfm: true,
  });
  const tokens = marked.lexer(sanitizeControlChars(content));
  const rendered = renderTokens(tokens as any, resolved);
  return `${rendered.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '')}\n`;
}
