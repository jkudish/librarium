import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverCandidates,
  formatSize,
  getDirSize,
  hasPendingAsync,
  isInsideBaseDir,
  summarizeCandidates,
  unsafeBaseDirReason,
} from '../src/commands/cleanup-data.js';
import type { RunManifest } from '../src/types.js';

let baseDir: string;

const DAY = 24 * 60 * 60 * 1000;

function makeManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    schemaVersion: 2,
    revision: 0,
    status: 'completed',
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
    ],
    sources: { total: 25, unique: 20, file: 'sources.json' },
    exitCode: 0,
    ...overrides,
  };
}

/** Create a run dir named "{unixSeconds}-{slug}" with optional files. */
function makeRun(name: string, files: Record<string, string> = {}): string {
  const dir = join(baseDir, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content);
  }
  return dir;
}

beforeEach(() => {
  baseDir = join(
    tmpdir(),
    `librarium-cleanup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(baseDir, { recursive: true });
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('formatSize', () => {
  it('formats bytes, KB, MB, GB', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(1024 * 1024 * 2)).toBe('2.0 MB');
    expect(formatSize(1024 * 1024 * 1024 * 3)).toBe('3.00 GB');
  });
});

describe('getDirSize', () => {
  it('sums files recursively', () => {
    const dir = makeRun('100-a', { 'a.md': 'x'.repeat(100) });
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'nested', 'b.md'), 'y'.repeat(50));
    expect(getDirSize(dir)).toBe(150);
  });

  it('returns 0 for a missing directory', () => {
    expect(getDirSize(join(baseDir, 'does-not-exist'))).toBe(0);
  });
});

describe('discoverCandidates', () => {
  it('returns empty for a non-existent base dir', () => {
    expect(discoverCandidates(join(baseDir, 'nope'))).toEqual([]);
  });

  it('filters by age by default and respects --days', () => {
    const now = 1_000 * DAY; // arbitrary fixed clock
    const oldSecs = Math.floor((now - 40 * DAY) / 1000);
    const recentSecs = Math.floor((now - 5 * DAY) / 1000);
    makeRun(`${oldSecs}-old`, { 'run.json': JSON.stringify(makeManifest()) });
    makeRun(`${recentSecs}-recent`, {
      'run.json': JSON.stringify(makeManifest()),
    });

    const def = discoverCandidates(baseDir, { now });
    expect(def.map((c) => c.name)).toEqual([`${oldSecs}-old`]);

    const wide = discoverCandidates(baseDir, { now, days: 3 });
    expect(wide.map((c) => c.name).sort()).toEqual(
      [`${oldSecs}-old`, `${recentSecs}-recent`].sort(),
    );
  });

  it('all=true returns every directory regardless of age, newest first', () => {
    const now = 1_000 * DAY;
    const oldSecs = Math.floor((now - 40 * DAY) / 1000);
    const recentSecs = Math.floor((now - 1 * DAY) / 1000);
    makeRun(`${oldSecs}-old`, { 'run.json': JSON.stringify(makeManifest()) });
    makeRun(`${recentSecs}-recent`, {
      'run.json': JSON.stringify(makeManifest()),
    });

    const all = discoverCandidates(baseDir, { all: true, now });
    expect(all.map((c) => c.name)).toEqual([
      `${recentSecs}-recent`,
      `${oldSecs}-old`,
    ]);
  });

  it('captures query and ignores non-directories', () => {
    const now = 1_000 * DAY;
    const secs = Math.floor((now - 40 * DAY) / 1000);
    makeRun(`${secs}-x`, {
      'run.json': JSON.stringify(makeManifest({ query: 'my query' })),
    });
    writeFileSync(join(baseDir, 'stray.txt'), 'not a dir');

    const out = discoverCandidates(baseDir, { now });
    expect(out).toHaveLength(1);
    expect(out[0].query).toBe('my query');
  });

  it('falls back to mtime when dir name lacks a timestamp', () => {
    makeRun('no-timestamp', { 'run.json': JSON.stringify(makeManifest()) });
    const out = discoverCandidates(baseDir, { all: true });
    expect(out).toHaveLength(1);
    expect(out[0].query).toBe('postgres pooling best practices');
  });
});

describe('hasPendingAsync', () => {
  it('ignores legacy async-tasks.json files', () => {
    const dir = makeRun('100-a', {
      'async-tasks.json': JSON.stringify([{ taskId: 't1', status: 'pending' }]),
    });
    expect(hasPendingAsync(dir)).toBe(false);
  });

  it('reads pending task state from run.json', () => {
    const dir = makeRun('100-c', {
      'run.json': JSON.stringify(
        makeManifest({
          providers: [
            {
              id: 'openai-deep',
              tier: 'deep-research',
              status: 'async-pending',
              durationMs: 0,
              wordCount: 0,
              citationCount: 0,
              outputFile: '',
              metaFile: '',
              task: { taskId: 't1', submittedAt: 1, status: 'pending' },
            },
          ],
        }),
      ),
    });
    expect(hasPendingAsync(dir)).toBe(true);
  });

  it('protects completed tasks that still await retrieval', () => {
    const dir = makeRun('100-awaiting', {
      'run.json': JSON.stringify(
        makeManifest({
          status: 'awaiting_async',
          exitCode: null,
          providers: [
            {
              id: 'openai-research',
              tier: 'deep-research',
              status: 'async-pending',
              durationMs: 0,
              wordCount: 0,
              citationCount: 0,
              outputFile: '',
              metaFile: '',
              task: { taskId: 't1', submittedAt: 1, status: 'completed' },
            },
          ],
        }),
      ),
    });
    expect(hasPendingAsync(dir)).toBe(true);
  });

  it('conservatively protects a corrupt authoritative manifest', () => {
    const dir = makeRun('100-corrupt', { 'run.json': '{not-json' });
    expect(hasPendingAsync(dir)).toBe(true);
  });

  it('is false for a run dir with no async indicators', () => {
    const dir = makeRun('100-d', {
      'run.json': JSON.stringify(makeManifest()),
    });
    expect(hasPendingAsync(dir)).toBe(false);
  });
});

describe('summarizeCandidates', () => {
  it('aggregates count, size, oldest/newest, pending-async', () => {
    const now = 1_000 * DAY;
    const oldSecs = Math.floor((now - 40 * DAY) / 1000);
    const newSecs = Math.floor((now - 1 * DAY) / 1000);
    makeRun(`${oldSecs}-old`, {
      'run.json': JSON.stringify(makeManifest()),
      'a.md': 'x'.repeat(100),
    });
    makeRun(`${newSecs}-new`, {
      'run.json': JSON.stringify(
        makeManifest({
          status: 'awaiting_async',
          exitCode: null,
          providers: [
            {
              id: 'openai-research',
              tier: 'deep-research',
              status: 'async-pending',
              durationMs: 0,
              wordCount: 0,
              citationCount: 0,
              outputFile: '',
              metaFile: '',
              task: { taskId: 't', submittedAt: 1, status: 'running' },
            },
          ],
        }),
      ),
      'b.md': 'y'.repeat(200),
    });

    const candidates = discoverCandidates(baseDir, { all: true, now });
    const s = summarizeCandidates(candidates);
    expect(s.count).toBe(2);
    expect(s.totalSize).toBeGreaterThanOrEqual(300);
    expect(s.oldest?.name).toBe(`${oldSecs}-old`);
    expect(s.newest?.name).toBe(`${newSecs}-new`);
    expect(s.pendingAsyncCount).toBe(1);
  });

  it('handles an empty list', () => {
    expect(summarizeCandidates([])).toEqual({
      count: 0,
      totalSize: 0,
      oldest: null,
      newest: null,
      pendingAsyncCount: 0,
    });
  });
});

describe('unsafeBaseDirReason', () => {
  it('refuses the home directory', () => {
    expect(unsafeBaseDirReason(homedir())).toMatch(/home directory/);
  });

  it('refuses a filesystem root', () => {
    const root = parse(process.cwd()).root;
    expect(unsafeBaseDirReason(root)).toMatch(/filesystem root/);
  });

  it('allows a normal output dir', () => {
    expect(unsafeBaseDirReason(baseDir)).toBeNull();
  });
});

describe('isInsideBaseDir', () => {
  it('accepts a proper descendant', () => {
    expect(isInsideBaseDir(baseDir, join(baseDir, '100-a'))).toBe(true);
    expect(isInsideBaseDir(baseDir, join(baseDir, 'a', 'b'))).toBe(true);
  });

  it('rejects the base dir itself', () => {
    expect(isInsideBaseDir(baseDir, baseDir)).toBe(false);
  });

  it('rejects traversal outside the base dir', () => {
    expect(isInsideBaseDir(baseDir, join(baseDir, '..', '..', 'etc'))).toBe(
      false,
    );
    expect(isInsideBaseDir(baseDir, parse(baseDir).root)).toBe(false);
  });

  it('rejects a sibling that shares a name prefix', () => {
    expect(isInsideBaseDir(`${baseDir}/runs`, `${baseDir}/runs-evil/x`)).toBe(
      false,
    );
  });
});
