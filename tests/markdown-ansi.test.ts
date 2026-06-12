import { describe, expect, it } from 'vitest';
import {
  renderMarkdownAnsi,
  visibleWidth,
  wrapAnsi,
} from '../src/commands/markdown-ansi.js';
import { hyperlink } from '../src/commands/run-format.js';

const ESC = '\u001b';
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const ITALIC = `${ESC}[3m`;
const UNDERLINE = `${ESC}[4m`;

function plain(content: string, width = 80): string {
  return renderMarkdownAnsi(content, { color: false, width });
}

function colored(content: string, width = 80): string {
  return renderMarkdownAnsi(content, { color: true, width });
}

describe('visibleWidth', () => {
  it('counts visible characters only', () => {
    expect(visibleWidth('hello')).toBe(5);
    expect(visibleWidth(`${BOLD}hello${ESC}[22m`)).toBe(5);
    expect(visibleWidth(hyperlink('hi', 'https://example.com', true))).toBe(2);
    expect(visibleWidth('')).toBe(0);
  });
});

describe('wrapAnsi', () => {
  it('wraps plain text at the width boundary', () => {
    expect(wrapAnsi('one two three four', 9)).toEqual([
      'one two',
      'three',
      'four',
    ]);
  });

  it('keeps short text on one line', () => {
    expect(wrapAnsi('short', 20)).toEqual(['short']);
  });

  it('treats ANSI escape sequences as zero-width', () => {
    const text = `${BOLD}one${ESC}[22m two`;
    expect(wrapAnsi(text, 7)).toEqual([`${BOLD}one${ESC}[22m two`]);
  });

  it('hard-breaks words longer than the width', () => {
    expect(wrapAnsi('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('starts a long word on a fresh line before hard-breaking', () => {
    expect(wrapAnsi('hi abcdefgh', 4)).toEqual(['hi', 'abcd', 'efgh']);
  });

  it('honors existing newlines as forced breaks', () => {
    expect(wrapAnsi('one\ntwo', 20)).toEqual(['one', 'two']);
  });

  it('never splits an OSC 8 hyperlink escape sequence', () => {
    const linked = hyperlink(
      'averyverylongpieceoflinktext',
      'https://example.com/path',
      true,
    );
    const lines = wrapAnsi(`intro ${linked} outro`, 10);
    for (const line of lines) {
      // Every OSC 8 open in the line must be terminated within the line.
      const opens = line.split(`${ESC}]8;;`).length - 1;
      const terminators = line.split(`${ESC}\\`).length - 1;
      expect(terminators).toBe(opens);
      expect(visibleWidth(line)).toBeLessThanOrEqual(10);
    }
  });

  it('closes and reopens an OSC 8 hyperlink across a wrap', () => {
    const linked = hyperlink('one two three', 'https://example.com', true);
    const lines = wrapAnsi(linked, 7);
    expect(lines.length).toBeGreaterThan(1);
    // Each line is self-contained: opens with the link, closes it at the end.
    for (const line of lines) {
      expect(line.startsWith(`${ESC}]8;;https://example.com${ESC}\\`)).toBe(
        true,
      );
      expect(line.endsWith(`${ESC}]8;;${ESC}\\`)).toBe(true);
    }
  });

  it('reopens SGR styles on the next line when a style spans the break', () => {
    const text = `${BOLD}one two three${ESC}[22m`;
    const lines = wrapAnsi(text, 7);
    expect(lines).toEqual([
      `${BOLD}one two${ESC}[0m`,
      `${BOLD}three${ESC}[22m`,
    ]);
  });

  it('does not reopen styles that were closed before the break', () => {
    const text = `${BOLD}one${ESC}[22m two three`;
    const lines = wrapAnsi(text, 8);
    expect(lines).toEqual([`${BOLD}one${ESC}[22m two`, 'three']);
  });

  it('returns the text unwrapped for a non-positive width', () => {
    expect(wrapAnsi('one two', 0)).toEqual(['one two']);
  });
});

describe('renderMarkdownAnsi headings', () => {
  it('renders h1 bold and underlined in color mode', () => {
    const out = colored('# Title');
    expect(out).toContain(`${BOLD}${UNDERLINE}Title`);
  });

  it('renders h3 bold only', () => {
    const out = colored('### Deep');
    expect(out).toContain(`${BOLD}Deep${ESC}[22m`);
    expect(out).not.toContain(UNDERLINE);
  });

  it('renders headings as plain text without color', () => {
    expect(plain('# Title')).toBe('Title\n');
  });

  it('strips inline styling inside headings', () => {
    const out = colored('# has `code` inside');
    expect(out).toContain('has code inside');
    expect(out).not.toContain(DIM);
  });
});

describe('renderMarkdownAnsi paragraphs and inline styles', () => {
  it('hard-wraps paragraphs to the given width', () => {
    const out = plain('one two three four five six seven', 10);
    for (const line of out.trimEnd().split('\n')) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(10);
    }
  });

  it('styles bold and italic with ANSI codes', () => {
    const out = colored('**bold** and *ital*');
    expect(out).toContain(`${BOLD}bold${ESC}[22m`);
    expect(out).toContain(`${ITALIC}ital${ESC}[23m`);
  });

  it('renders inline code dim', () => {
    expect(colored('use `qmd` here')).toContain(`${DIM}qmd${ESC}[22m`);
  });

  it('emits no ANSI codes at all when color is false', () => {
    const out = plain('# H\n\n**b** *i* `c` [t](https://e.com)\n\n> q');
    expect(out).not.toContain(ESC);
  });
});

describe('renderMarkdownAnsi code blocks', () => {
  it('indents code blocks by two spaces and dims them', () => {
    const out = colored('```\nconst x = 1;\n```');
    expect(out).toContain(`${DIM}  const x = 1;${ESC}[22m`);
  });

  it('keeps code lines verbatim without color', () => {
    const out = plain('```\nconst x = 1;\n```');
    expect(out).toContain('  const x = 1;');
  });
});

describe('renderMarkdownAnsi lists', () => {
  it('normalizes unordered bullets', () => {
    const out = plain('* one\n* two');
    expect(out).toContain('• one');
    expect(out).toContain('• two');
  });

  it('numbers ordered lists from the start value', () => {
    const out = plain('3. three\n4. four');
    expect(out).toContain('3. three');
    expect(out).toContain('4. four');
  });

  it('indents wrapped list item lines under the bullet', () => {
    const out = plain('- alpha beta gamma delta epsilon', 14);
    const lines = out.trimEnd().split('\n');
    expect(lines[0]).toBe('• alpha beta');
    expect(lines[1]).toBe('  gamma delta');
  });

  it('renders task list checkboxes', () => {
    const out = plain('- [x] done\n- [ ] todo');
    expect(out).toContain('• [x] done');
    expect(out).toContain('• [ ] todo');
  });
});

describe('renderMarkdownAnsi links', () => {
  it('emits OSC 8 hyperlinks in color mode', () => {
    const out = colored('[text](https://example.com)');
    expect(out).toContain(
      `${ESC}]8;;https://example.com${ESC}\\text${ESC}]8;;${ESC}\\`,
    );
  });

  it('shows the URL in parens when hyperlinks are disabled', () => {
    const out = plain('[text](https://example.com)');
    expect(out).toContain('text (https://example.com)');
  });

  it('does not repeat the URL for bare autolinks', () => {
    const out = plain('<https://example.com>');
    expect(out.trimEnd()).toBe('https://example.com');
  });
});

describe('renderMarkdownAnsi blockquotes and rules', () => {
  it('prefixes blockquote lines with a gutter', () => {
    const out = plain('> quoted text');
    expect(out).toContain('| quoted text');
  });

  it('renders horizontal rules as a line', () => {
    const out = plain('a\n\n---\n\nb', 20);
    expect(out).toContain('─'.repeat(20));
  });
});

describe('renderMarkdownAnsi untrusted content', () => {
  it('renders raw HTML as plain text without interpreting it', () => {
    const out = plain('<script>alert(1)</script>');
    expect(out).toContain('<script>alert(1)</script>');
  });

  it('renders inline HTML tags as plain text', () => {
    const out = plain('hello <b>world</b> end');
    expect(out).toContain('hello <b>world</b> end');
  });

  it('strips raw escape bytes so content cannot inject ANSI', () => {
    const out = plain(`evil ${ESC}[31mred${ESC}[0m text`);
    expect(out).not.toContain(ESC);
    expect(out).toContain('evil [31mred[0m text');
  });
});
