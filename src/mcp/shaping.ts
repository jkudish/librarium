import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverRuns, readRunEntry } from '../commands/browse-data.js';
import { loadAsyncTasks } from '../core/async-manager.js';
import type {
  AsyncTaskHandle,
  DeduplicatedSource,
  ProviderReport,
  ProviderUsage,
  RunManifest,
} from '../types.js';
import type { SilentRunResult } from './research.js';

/** Cap on deduped sources inlined in a `research` result. */
export const MAX_SOURCES = 25;
/** Per-provider character cap for `get_results` markdown. */
export const MAX_PROVIDER_CHARS = 40_000;

export interface ShapedProvider {
  id: string;
  tier: string;
  status: ProviderReport['status'];
  durationMs: number;
  citationCount: number;
  wordCount: number;
  usage?: ProviderUsage;
  error?: string;
  fallbackFor?: string;
}

export interface ShapedSource {
  url: string;
  title?: string;
  providers: string[];
  citationCount: number;
}

export interface ResearchToolResult {
  outputDir: string;
  query: string;
  mode: RunManifest['mode'];
  tallies: {
    succeeded: number;
    failed: number;
    pending: number;
    skipped: number;
  };
  totalDurationMs: number;
  providers: ShapedProvider[];
  sources: {
    total: number;
    unique: number;
    shown: number;
    truncated: boolean;
    items: ShapedSource[];
  };
  pendingTaskIds: string[];
  summaryFile: string;
}

function shapeProviders(reports: ProviderReport[]): ShapedProvider[] {
  return reports.map((r) => ({
    id: r.id,
    tier: r.tier,
    status: r.status,
    durationMs: r.durationMs,
    citationCount: r.citationCount,
    wordCount: r.wordCount,
    ...(r.usage ? { usage: r.usage } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.fallbackFor ? { fallbackFor: r.fallbackFor } : {}),
  }));
}

function shapeSources(sources: DeduplicatedSource[]): {
  shown: number;
  truncated: boolean;
  items: ShapedSource[];
} {
  const truncated = sources.length > MAX_SOURCES;
  const items = sources.slice(0, MAX_SOURCES).map((s) => ({
    url: s.url,
    ...(s.title ? { title: s.title } : {}),
    providers: s.providers,
    citationCount: s.citationCount,
  }));
  return { shown: items.length, truncated, items };
}

/**
 * Shape a silent run into the compact `research` tool result. Full provider
 * content is deliberately excluded (token blowup) — callers fetch it via
 * `get_results`.
 */
export function shapeResearchResult(run: SilentRunResult): ResearchToolResult {
  const { manifest, sources } = run;
  const reports = manifest.providers;
  const tallies = {
    succeeded: reports.filter((r) => r.status === 'success').length,
    failed: reports.filter((r) => r.status === 'error').length,
    pending: reports.filter((r) => r.status === 'async-pending').length,
    skipped: reports.filter((r) => r.status === 'skipped').length,
  };
  const shapedSources = shapeSources(sources);
  return {
    outputDir: manifest.outputDir,
    query: manifest.query,
    mode: manifest.mode,
    tallies,
    totalDurationMs: run.totalDurationMs,
    providers: shapeProviders(reports),
    sources: {
      total: manifest.sources.total,
      unique: manifest.sources.unique,
      shown: shapedSources.shown,
      truncated: shapedSources.truncated,
      items: shapedSources.items,
    },
    pendingTaskIds: manifest.asyncTasks
      .filter((t) => t.status === 'pending' || t.status === 'running')
      .map((t) => t.taskId),
    summaryFile: join(manifest.outputDir, 'summary.md'),
  };
}

/** Truncate a provider's markdown to the cap with an explicit marker. */
export function truncateProviderContent(content: string): {
  content: string;
  truncated: boolean;
  fullChars: number;
} {
  const fullChars = content.length;
  if (fullChars <= MAX_PROVIDER_CHARS) {
    return { content, truncated: false, fullChars };
  }
  const head = content.slice(0, MAX_PROVIDER_CHARS);
  return {
    content: `${head}\n\n[...truncated ${fullChars - MAX_PROVIDER_CHARS} of ${fullChars} chars; read the full file from the run directory...]`,
    truncated: true,
    fullChars,
  };
}

export interface ProviderContent {
  id: string;
  tier: string;
  status: ProviderReport['status'];
  content: string;
  truncated: boolean;
  fullChars: number;
  error?: string;
}

export interface GetResultsToolResult {
  runDir: string;
  query: string;
  summary: {
    mode: RunManifest['mode'];
    providers: ShapedProvider[];
    sources: { total: number; unique: number };
  };
  results: ProviderContent[];
}

/**
 * Resolve the run directory to read from: explicit `runDir`, else the most
 * recent run under the configured output base. Returns null when none exists.
 */
export function resolveRunDir(baseDir: string, runDir?: string): string | null {
  if (runDir) {
    return existsSync(join(runDir, 'run.json')) ? runDir : null;
  }
  const recent = discoverRuns(baseDir, 1);
  return recent[0]?.dir ?? null;
}

/**
 * Read provider markdown from a run directory, capped per provider, plus the
 * manifest summary. Optional `provider` filter limits to one provider id.
 */
export function readRunResults(
  runDir: string,
  provider?: string,
): GetResultsToolResult | null {
  const entry = readRunEntry(runDir);
  if (!entry) return null;
  const manifest = entry.manifest;

  const reports = provider
    ? manifest.providers.filter((r) => r.id === provider)
    : manifest.providers;

  const results: ProviderContent[] = [];
  for (const report of reports) {
    if (!report.outputFile) {
      results.push({
        id: report.id,
        tier: report.tier,
        status: report.status,
        content: '',
        truncated: false,
        fullChars: 0,
        ...(report.error ? { error: report.error } : {}),
      });
      continue;
    }
    const path = join(runDir, report.outputFile);
    let raw = '';
    try {
      raw = existsSync(path) ? readFileSync(path, 'utf-8') : '';
    } catch {
      raw = '';
    }
    const capped = truncateProviderContent(raw);
    results.push({
      id: report.id,
      tier: report.tier,
      status: report.status,
      content: capped.content,
      truncated: capped.truncated,
      fullChars: capped.fullChars,
      ...(report.error ? { error: report.error } : {}),
    });
  }

  return {
    runDir,
    query: manifest.query,
    summary: {
      mode: manifest.mode,
      providers: manifest.providers.map((r) => ({
        id: r.id,
        tier: r.tier,
        status: r.status,
        durationMs: r.durationMs,
        citationCount: r.citationCount,
        wordCount: r.wordCount,
        ...(r.usage ? { usage: r.usage } : {}),
        ...(r.error ? { error: r.error } : {}),
        ...(r.fallbackFor ? { fallbackFor: r.fallbackFor } : {}),
      })),
      sources: {
        total: manifest.sources.total,
        unique: manifest.sources.unique,
      },
    },
    results,
  };
}

/** Load async task handles for a run directory. */
export function loadRunAsyncTasks(runDir: string): AsyncTaskHandle[] {
  return loadAsyncTasks(runDir);
}
