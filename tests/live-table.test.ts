import { describe, expect, it } from 'vitest';
import { LiveRunTable } from '../src/commands/live-table.js';
import { computeLineWidths } from '../src/commands/run-format.js';
import type { ProviderReport } from '../src/types.js';

const CURSOR_UP = (n: number) => `\u001b[${n}A`;
const CLEAR_LINE = '\u001b[2K';

function makeStream(columns = 120) {
  const chunks: string[] = [];
  return {
    chunks,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    columns,
  };
}

function makeReport(overrides: Partial<ProviderReport> = {}): ProviderReport {
  return {
    id: 'exa',
    tier: 'ai-grounded',
    status: 'success',
    durationMs: 1800,
    wordCount: 100,
    citationCount: 25,
    outputFile: 'exa.md',
    metaFile: 'exa.meta.json',
    ...overrides,
  };
}

const widths = computeLineWidths(
  ['exa', 'brave-search'],
  ['ai-grounded', 'raw-search'],
);

describe('LiveRunTable', () => {
  it('renders one cleared line per row and moves the cursor up on re-render', () => {
    const stream = makeStream();
    const table = new LiveRunTable(stream, widths, false);
    table.addProvider('exa', 'ai-grounded');
    table.addProvider('brave-search', 'raw-search');

    table.markStarted('exa'); // triggers first render (2 rows, no cursor-up)
    const first = stream.chunks.at(-1) as string;
    expect(first.startsWith(CLEAR_LINE)).toBe(true);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI clear-line escapes
    expect(first.match(/\u001b\[2K/g)).toHaveLength(2);
    expect(first).toContain('exa');
    expect(first).toContain('queued'); // brave-search not started yet

    table.resolve(makeReport());
    const second = stream.chunks.at(-1) as string;
    expect(second.startsWith(CURSOR_UP(2))).toBe(true);
    expect(second).toContain('25 sources');
  });

  it('inserts fallback notice and row under the failed primary', () => {
    const stream = makeStream();
    const table = new LiveRunTable(stream, widths, false);
    table.addProvider('exa', 'ai-grounded');
    table.addProvider('brave-search', 'raw-search');
    table.markStarted('exa');

    table.addFallback('exa', 'tavily', 'raw-search');
    const render = stream.chunks.at(-1) as string;
    const lines = render.split('\n');
    expect(lines[0]).toContain('exa');
    expect(lines[1]).toContain('falling back to tavily');
    expect(lines[2]).toContain('tavily');
    expect(lines[3]).toContain('brave-search');
  });

  it('resolves the fallback row, not the primary, for fallback reports', () => {
    const stream = makeStream();
    const table = new LiveRunTable(stream, widths, false);
    table.addProvider('exa', 'ai-grounded');
    table.addFallback('exa', 'tavily', 'raw-search');

    table.resolve(
      makeReport({ id: 'tavily', tier: 'raw-search', fallbackFor: 'exa' }),
    );
    const render = stream.chunks.at(-1) as string;
    const lines = render.split('\n');
    // Primary row still pending (spinner frame), fallback row resolved.
    expect(lines[0]).not.toContain('✓');
    expect(lines[2]).toContain('✓');
    expect(lines[2]).toContain('(fallback for exa)');
  });

  it('resolveRemaining fills rows that never got events', () => {
    const stream = makeStream();
    const table = new LiveRunTable(stream, widths, false);
    table.addProvider('exa', 'ai-grounded');
    table.addProvider('brave-search', 'raw-search');
    table.resolve(makeReport());

    table.resolveRemaining([
      makeReport(),
      makeReport({
        id: 'brave-search',
        tier: 'raw-search',
        status: 'skipped',
        error: 'Provider not enabled',
      }),
    ]);
    const render = stream.chunks.at(-1) as string;
    expect(render).toContain('skipped');
  });

  it('truncates rows to the stream width', () => {
    const stream = makeStream(30);
    const table = new LiveRunTable(stream, widths, false);
    table.addProvider('exa', 'ai-grounded');
    table.resolve(
      makeReport({
        status: 'error',
        error: 'a very long error message that would normally wrap the line',
      }),
    );
    const render = stream.chunks.at(-1) as string;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
    const visible = render.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '');
    for (const line of visible.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(29);
    }
  });
});
