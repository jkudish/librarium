import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  describeRun,
  discoverRuns,
  extractPreview,
  isRunManifest,
  readRunEntry,
  runTallies,
} from '../src/commands/browse-data.js';
import type { RunManifest } from '../src/types.js';

let baseDir: string;

function makeManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    version: 1,
    timestamp: 1_781_136_000,
    slug: 'postgres-pooling',
    query: 'postgres pooling best practices',
    mode: 'mixed',
    outputDir: '/tmp/x',
    providers: [
      {
        id: 'exa',
        tier: 'ai-grounded',
        status: 'success',
        durationMs: 1800,
        wordCount: 100,
        citationCount: 25,
        outputFile: 'exa.md',
        metaFile: 'exa.meta.json',
      },
      {
        id: 'brave-search',
        tier: 'raw-search',
        status: 'error',
        durationMs: 300,
        wordCount: 0,
        citationCount: 0,
        outputFile: 'brave-search.md',
        metaFile: 'brave-search.meta.json',
        error: 'HTTP 401',
      },
      {
        id: 'openai-deep',
        tier: 'deep-research',
        status: 'async-pending',
        durationMs: 0,
        wordCount: 0,
        citationCount: 0,
        outputFile: '',
        metaFile: '',
      },
    ],
    sources: { total: 25, unique: 20, file: 'sources.json' },
    asyncTasks: [],
    exitCode: 0,
    ...overrides,
  };
}

function writeRun(name: string, manifest: RunManifest): string {
  const dir = join(baseDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify(manifest));
  return dir;
}

beforeEach(() => {
  baseDir = join(
    tmpdir(),
    `librarium-browse-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(baseDir, { recursive: true });
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('isRunManifest', () => {
  it('accepts a valid manifest and rejects junk', () => {
    expect(isRunManifest(makeManifest())).toBe(true);
    expect(isRunManifest(null)).toBe(false);
    expect(isRunManifest({})).toBe(false);
    expect(isRunManifest({ query: 'x' })).toBe(false);
  });
});

describe('readRunEntry / discoverRuns', () => {
  it('reads a run directory with a valid manifest', () => {
    const dir = writeRun('run-1', makeManifest());
    const entry = readRunEntry(dir);
    expect(entry?.manifest.query).toBe('postgres pooling best practices');
  });

  it('returns null for missing or corrupt run.json', () => {
    const empty = join(baseDir, 'empty');
    mkdirSync(empty);
    expect(readRunEntry(empty)).toBeNull();

    const corrupt = join(baseDir, 'corrupt');
    mkdirSync(corrupt);
    writeFileSync(join(corrupt, 'run.json'), '{not json');
    expect(readRunEntry(corrupt)).toBeNull();
  });

  it('discovers runs sorted newest first and respects the limit', () => {
    writeRun('a', makeManifest({ timestamp: 100, query: 'oldest' }));
    writeRun('b', makeManifest({ timestamp: 300, query: 'newest' }));
    writeRun('c', makeManifest({ timestamp: 200, query: 'middle' }));
    mkdirSync(join(baseDir, 'no-manifest'));

    const runs = discoverRuns(baseDir);
    expect(runs.map((r) => r.manifest.query)).toEqual([
      'newest',
      'middle',
      'oldest',
    ]);
    expect(discoverRuns(baseDir, 2)).toHaveLength(2);
  });

  it('returns empty for a missing base dir', () => {
    expect(discoverRuns(join(baseDir, 'nope'))).toEqual([]);
  });
});

describe('runTallies / describeRun', () => {
  it('summarizes provider statuses', () => {
    expect(runTallies(makeManifest())).toBe('1 ok, 1 failed, 1 pending');
  });

  it('omits zero categories', () => {
    const manifest = makeManifest();
    manifest.providers = [manifest.providers[0] as RunManifest['providers'][0]];
    expect(runTallies(manifest)).toBe('1 ok');
  });

  it('labels with date and truncated query', () => {
    const longQuery = 'q'.repeat(80);
    const { label, hint } = describeRun({
      dir: '/tmp/x',
      manifest: makeManifest({ query: longQuery }),
    });
    expect(label).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}q+…$/);
    expect(label.length).toBeLessThan(80);
    expect(hint).toContain('1 ok');
  });
});

describe('extractPreview', () => {
  it('strips leading and trailing blank lines', () => {
    expect(extractPreview('\n\nhello\nworld\n\n')).toEqual(['hello', 'world']);
  });

  it('truncates to maxLines with an ellipsis marker', () => {
    const content = Array.from({ length: 40 }, (_, i) => `line ${i}`).join(
      '\n',
    );
    const preview = extractPreview(content, 25);
    expect(preview).toHaveLength(26);
    expect(preview.at(-1)).toBe('…');
    expect(preview[0]).toBe('line 0');
  });

  it('handles CRLF content', () => {
    expect(extractPreview('a\r\nb')).toEqual(['a', 'b']);
  });
});
