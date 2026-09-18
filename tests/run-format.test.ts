import { describe, expect, it } from 'vitest';
import {
  computeLineWidths,
  dimText,
  fileUrl,
  formatDuration,
  formatFallbackNotice,
  formatPendingLine,
  formatProviderLine,
  formatRunSummary,
  hyperlink,
  isColorEnabled,
  shortenHomePath,
  truncateAnsi,
} from '../src/commands/run-format.js';
import type { ProviderReport } from '../src/types.js';

function makeReport(overrides: Partial<ProviderReport> = {}): ProviderReport {
  return {
    id: 'perplexity-sonar-pro',
    tier: 'ai-grounded',
    status: 'success',
    durationMs: 2100,
    wordCount: 500,
    citationCount: 12,
    outputFile: 'perplexity-sonar-pro.md',
    metaFile: 'perplexity-sonar-pro.meta.json',
    ...overrides,
  };
}

const widths = computeLineWidths(
  ['perplexity-sonar-pro', 'exa', 'brave-search', 'openai-deep'],
  ['ai-grounded', 'ai-grounded', 'raw-search', 'deep-research'],
);

describe('computeLineWidths', () => {
  it('returns the longest id and tier lengths', () => {
    expect(widths).toEqual({
      id: 'perplexity-sonar-pro'.length,
      tier: 'deep-research'.length,
    });
  });

  it('handles empty input', () => {
    expect(computeLineWidths([], [])).toEqual({ id: 0, tier: 0 });
  });
});

describe('formatDuration', () => {
  it('formats milliseconds as seconds with one decimal', () => {
    expect(formatDuration(2100)).toBe('2.1s');
    expect(formatDuration(900)).toBe('0.9s');
    expect(formatDuration(0)).toBe('0.0s');
  });
});

describe('formatProviderLine', () => {
  it('formats a successful ai-grounded provider with "sources"', () => {
    const line = formatProviderLine(makeReport(), widths, false);
    expect(line).toBe(
      '  ✓ perplexity-sonar-pro   ai-grounded        2.1s    12 sources',
    );
  });

  it('uses "results" for raw-search providers', () => {
    const line = formatProviderLine(
      makeReport({
        id: 'brave-search',
        tier: 'raw-search',
        durationMs: 900,
        citationCount: 20,
      }),
      widths,
      false,
    );
    expect(line).toBe(
      '  ✓ brave-search           raw-search         0.9s    20 results',
    );
  });

  it('aligns lines across providers of different lengths', () => {
    const a = formatProviderLine(makeReport(), widths, false);
    const b = formatProviderLine(
      makeReport({ id: 'exa', citationCount: 9 }),
      widths,
      false,
    );
    expect(a.indexOf('ai-grounded')).toBe(b.indexOf('ai-grounded'));
    expect(a.indexOf('sources')).toBe(b.indexOf('sources'));
  });

  it('formats async-pending as submitted without duration', () => {
    const line = formatProviderLine(
      makeReport({
        id: 'openai-deep',
        tier: 'deep-research',
        status: 'async-pending',
        durationMs: 0,
        citationCount: 0,
      }),
      widths,
      false,
    );
    expect(line).toBe('  ◷ openai-deep            deep-research   submitted');
  });

  it('formats errors with the failure reason', () => {
    const line = formatProviderLine(
      makeReport({
        id: 'exa',
        status: 'error',
        durationMs: 300,
        citationCount: 0,
        error: 'HTTP 401 Unauthorized',
      }),
      widths,
      false,
    );
    expect(line).toBe(
      '  ✗ exa                    ai-grounded        0.3s   HTTP 401 Unauthorized',
    );
  });

  it('flattens and truncates long error messages', () => {
    const line = formatProviderLine(
      makeReport({ status: 'error', error: `boom\n${'x'.repeat(200)}` }),
      widths,
      false,
    );
    expect(line).not.toContain('\n');
    expect(line).toContain('boom x');
    expect(line.length).toBeLessThan(140);
    expect(line).toContain('…');
  });

  it('marks fallback results with the primary they recovered', () => {
    const line = formatProviderLine(
      makeReport({ id: 'exa', fallbackFor: 'openai-deep' }),
      widths,
      false,
    );
    expect(line).toContain('(fallback for openai-deep)');
  });

  it('formats skipped providers', () => {
    const line = formatProviderLine(
      makeReport({ status: 'skipped', error: 'Provider not enabled' }),
      widths,
      false,
    );
    expect(line).toContain('skipped');
    expect(line.trimStart().startsWith('-')).toBe(true);
  });

  it('wraps glyphs in ANSI colors when color is enabled', () => {
    const ok = formatProviderLine(makeReport(), widths, true);
    expect(ok).toContain('\u001b[32m✓\u001b[0m');
    const err = formatProviderLine(
      makeReport({ status: 'error', error: 'nope' }),
      widths,
      true,
    );
    expect(err).toContain('\u001b[31m✗\u001b[0m');
  });
});

describe('formatFallbackNotice', () => {
  it('renders an indented arrow line', () => {
    expect(formatFallbackNotice('openai-deep', false)).toBe(
      '    ↳ falling back to openai-deep',
    );
  });
});

describe('shortenHomePath', () => {
  it('replaces the home prefix with ~', () => {
    expect(shortenHomePath('/home/joey/research/run-1', '/home/joey')).toBe(
      '~/research/run-1',
    );
  });

  it('leaves non-home paths untouched', () => {
    expect(shortenHomePath('/srv/research', '/home/joey')).toBe(
      '/srv/research',
    );
  });
});

describe('formatRunSummary', () => {
  it('includes counts, dedupe line, and output dir', () => {
    const lines = formatRunSummary({
      succeeded: 5,
      failed: 0,
      pending: 0,
      uniqueSources: 74,
      totalCitations: 96,
      outputDir: '/home/joey/research/run-1',
      color: false,
      home: '/home/joey',
    });
    expect(lines).toContain('  5 succeeded, 0 failed, 0 async pending');
    expect(lines).toContain(
      '  ▸ 74 unique sources after dedupe (96 total citations)',
    );
    expect(lines).toContain('  ▸ ~/research/run-1/');
    expect(lines.join('\n')).not.toContain('librarium status');
  });

  it('adds the librarium status hint when async tasks are pending', () => {
    const lines = formatRunSummary({
      succeeded: 4,
      failed: 1,
      pending: 1,
      uniqueSources: 10,
      totalCitations: 12,
      outputDir: '/srv/out',
      color: false,
    });
    expect(lines.join('\n')).toContain('librarium status --wait');
  });
});

describe('isColorEnabled', () => {
  it('disables color when NO_COLOR is set', () => {
    expect(isColorEnabled({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
  });

  it('enables color when FORCE_COLOR is set even without a TTY', () => {
    expect(isColorEnabled({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true);
  });

  it('falls back to TTY detection', () => {
    expect(isColorEnabled({ isTTY: true }, {})).toBe(true);
    expect(isColorEnabled({ isTTY: false }, {})).toBe(false);
    expect(isColorEnabled({}, {})).toBe(false);
  });
});

describe('slow duration highlight', () => {
  it('paints durations at or above 10s yellow in color mode', () => {
    const line = formatProviderLine(
      makeReport({ durationMs: 12_345 }),
      widths,
      true,
    );
    expect(line).toContain('\u001b[33m  12.3s\u001b[0m');
  });

  it('leaves fast durations unpainted in color mode', () => {
    const line = formatProviderLine(
      makeReport({ durationMs: 2_100 }),
      widths,
      true,
    );
    expect(line).not.toContain('\u001b[33m');
  });

  it('emits no ANSI for slow durations when color is off', () => {
    const line = formatProviderLine(
      makeReport({ durationMs: 12_345 }),
      widths,
      false,
    );
    expect(line).toContain('  12.3s');
    expect(line).not.toContain('\u001b');
  });
});

describe('formatPendingLine', () => {
  it('shows queued before the provider starts', () => {
    const line = formatPendingLine(
      'exa',
      'ai-grounded',
      widths,
      false,
      '\u280b',
    );
    expect(line).toBe('  \u280b exa                    ai-grounded     queued');
  });

  it('ticks elapsed time once started', () => {
    const line = formatPendingLine(
      'exa',
      'ai-grounded',
      widths,
      false,
      '\u280b',
      2_300,
    );
    expect(line).toContain('2.3s');
  });
});

describe('truncateAnsi', () => {
  it('returns short lines unchanged', () => {
    expect(truncateAnsi('hello', 10)).toBe('hello');
  });

  it('truncates visible characters to the max width', () => {
    expect(truncateAnsi('hello world', 5)).toBe('hello');
  });

  it('does not count ANSI sequences toward the width', () => {
    const line = '\u001b[32mhello\u001b[0m world';
    expect(truncateAnsi(line, 11)).toBe(line);
  });

  it('appends a reset when cutting a styled line', () => {
    const line = '\u001b[32mhello world\u001b[0m';
    const cut = truncateAnsi(line, 5);
    expect(cut).toBe('\u001b[32mhello\u001b[0m');
  });

  it('handles zero width', () => {
    expect(truncateAnsi('hello', 0)).toBe('');
  });

  it('does not count or split OSC 8 hyperlink sequences', () => {
    const line = `]8;;file:///tmp/run\\report]8;;\\ done`;
    // Visible text is "report done" (11 chars); the OSC payloads are free.
    expect(truncateAnsi(line, 11)).toBe(line);
    // Cutting inside the visible text must keep both OSC sequences intact.
    const cut = truncateAnsi(line, 6);
    expect(cut).toContain(']8;;file:///tmp/run\\');
    expect(cut).toContain('report');
    expect(cut).toContain(']8;;\\');
    expect(cut).not.toContain('done');
  });

  it('consumes BEL-terminated OSC sequences', () => {
    const line = ']0;titlehello';
    expect(truncateAnsi(line, 5)).toBe(']0;titlehello');
  });
});

describe('dimText', () => {
  it('wraps in dim ANSI when color is on and is a no-op otherwise', () => {
    expect(dimText('x', true)).toBe('\u001b[2mx\u001b[0m');
    expect(dimText('x', false)).toBe('x');
  });
});

describe('wall-clock total', () => {
  it('appends the total duration to the tallies line', () => {
    const lines = formatRunSummary({
      succeeded: 4,
      failed: 0,
      pending: 0,
      uniqueSources: 10,
      totalCitations: 12,
      outputDir: '/srv/out',
      color: false,
      totalDurationMs: 13_300,
    });
    expect(lines).toContain(
      '  4 succeeded, 0 failed, 0 async pending in 13.3s',
    );
  });
});

describe('hyperlink / fileUrl', () => {
  it('emits an OSC 8 hyperlink when enabled', () => {
    expect(hyperlink('text', 'file:///tmp/x', true)).toBe(
      '\u001b]8;;file:///tmp/x\u001b\\text\u001b]8;;\u001b\\',
    );
  });

  it('returns plain text when disabled', () => {
    expect(hyperlink('text', 'file:///tmp/x', false)).toBe('text');
  });

  it('percent-encodes path segments in file URLs', () => {
    // On Windows, pathToFileURL prepends the current drive to rootless
    // paths, so assert on the encoded fragments rather than exact equality.
    const url = fileUrl('/Users/joey/My Reports/run #1');
    expect(url).toMatch(/^file:\/\/\//);
    expect(url).toContain('/Users/joey/My%20Reports/run%20%231');
    expect(fileUrl('/tmp/plain/path')).toContain('/tmp/plain/path');
  });

  it('links the output directory in the run summary when color is on', () => {
    const lines = formatRunSummary({
      succeeded: 1,
      failed: 0,
      pending: 0,
      uniqueSources: 1,
      totalCitations: 1,
      outputDir: '/srv/out dir',
      color: true,
    });
    const joined = lines.join('\n');
    expect(joined).toContain('\u001b]8;;file://');
    expect(joined).toContain('/srv/out%20dir\u001b\\');
    expect(joined).toContain('/srv/out dir/');
  });
});
