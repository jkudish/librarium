import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aggregateUsage } from '../src/commands/usage-data.js';
import type { ProviderReport, RunManifest } from '../src/types.js';

const DAY = 24 * 60 * 60 * 1000;

function report(id: string, usage?: ProviderReport['usage']): ProviderReport {
  return {
    id,
    tier: 'ai-grounded',
    status: 'success',
    durationMs: 100,
    wordCount: 10,
    citationCount: 1,
    outputFile: `${id}.md`,
    metaFile: `${id}.meta.json`,
    usage,
  };
}

function writeManifest(
  baseDir: string,
  timestampSeconds: number,
  providers: ProviderReport[],
): void {
  const dir = join(
    baseDir,
    `${timestampSeconds}-slug-${randomUUID().slice(0, 6)}`,
  );
  mkdirSync(dir, { recursive: true });
  const manifest: RunManifest = {
    version: 1,
    timestamp: timestampSeconds,
    slug: 'slug',
    query: 'q',
    mode: 'sync',
    outputDir: dir,
    providers,
    sources: { total: 0, unique: 0, file: 'sources.json' },
    asyncTasks: [],
    exitCode: 0,
  };
  writeFileSync(join(dir, 'run.json'), JSON.stringify(manifest));
}

describe('aggregateUsage', () => {
  let baseDir: string;
  const now = Date.UTC(2026, 0, 15);
  const nowSec = Math.floor(now / 1000);

  beforeEach(() => {
    baseDir = join(tmpdir(), `librarium-usage-${randomUUID().slice(0, 8)}`);
    mkdirSync(baseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('returns zeroed totals for a missing or empty base dir', () => {
    expect(aggregateUsage(join(baseDir, 'nope'))).toEqual({
      runCount: 0,
      runsWithoutUsage: 0,
      totalCostUsd: 0,
      runsWithCost: 0,
      providers: [],
      range: null,
    });
    expect(aggregateUsage(baseDir).runCount).toBe(0);
  });

  it('totals cost and tokens per provider across runs', () => {
    writeManifest(baseDir, nowSec, [
      report('exa', { costUsd: 0.02, totalTokens: 1000 }),
      report('openai-deep', {
        costUsd: 0.5,
        inputTokens: 200,
        outputTokens: 300,
      }),
    ]);
    writeManifest(baseDir, nowSec - 10, [
      report('exa', { costUsd: 0.03, totalTokens: 2000 }),
    ]);

    const agg = aggregateUsage(baseDir);
    expect(agg.runCount).toBe(2);
    expect(agg.totalCostUsd).toBeCloseTo(0.55);

    const exa = agg.providers.find((p) => p.provider === 'exa');
    expect(exa?.costUsd).toBeCloseTo(0.05);
    expect(exa?.totalTokens).toBe(3000);
    expect(exa?.runCount).toBe(2);

    const oai = agg.providers.find((p) => p.provider === 'openai-deep');
    expect(oai?.totalTokens).toBe(500);
    // Sorted by cost descending: openai-deep first.
    expect(agg.providers[0].provider).toBe('openai-deep');
  });

  it('counts runs with no reported usage', () => {
    writeManifest(baseDir, nowSec, [report('exa', { costUsd: 0.01 })]);
    writeManifest(baseDir, nowSec - 5, [report('brave-search', undefined)]);
    writeManifest(baseDir, nowSec - 6, [
      report('brave-search', { raw: { x: 1 } }),
    ]);

    const agg = aggregateUsage(baseDir);
    expect(agg.runCount).toBe(3);
    expect(agg.runsWithoutUsage).toBe(2);
    expect(agg.runsWithCost).toBe(1);
  });

  it('filters by --days using the manifest timestamp', () => {
    writeManifest(baseDir, nowSec, [report('exa', { costUsd: 0.01 })]);
    writeManifest(baseDir, Math.floor((now - 40 * DAY) / 1000), [
      report('exa', { costUsd: 0.99 }),
    ]);

    const recent = aggregateUsage(baseDir, { days: 7, now });
    expect(recent.runCount).toBe(1);
    expect(recent.totalCostUsd).toBeCloseTo(0.01);

    const all = aggregateUsage(baseDir, { now });
    expect(all.runCount).toBe(2);
    expect(all.totalCostUsd).toBeCloseTo(1.0);
  });

  it('reports the date range across included runs', () => {
    writeManifest(baseDir, nowSec, [report('exa', { costUsd: 0.01 })]);
    writeManifest(baseDir, nowSec - 100, [report('exa', { costUsd: 0.01 })]);
    const agg = aggregateUsage(baseDir);
    expect(agg.range).toEqual({ fromSeconds: nowSec - 100, toSeconds: nowSec });
  });

  it('ignores corrupt manifests', () => {
    const dir = join(baseDir, '123-bad');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), '{ not valid json');
    expect(aggregateUsage(baseDir).runCount).toBe(0);
  });
});
