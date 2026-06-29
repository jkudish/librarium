import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeWriteFile } from '../core/fs-utils.js';
import type { DeduplicatedSource, RunManifest } from '../types.js';
import { readAnswerArtifact } from './answer-synthesis.js';
import { readRunEntry } from './browse-data.js';
import { enrichRetrievedReports } from './html-report.js';

/**
 * Self-contained JSONL report generator for a run directory.
 *
 * generateJsonlReport() is a pure function (manifest + file contents in,
 * JSONL string out) so it stays unit-testable; writeJsonlReport() is the
 * filesystem wrapper used by `run --jsonl`, `librarium jsonl`, browse, and
 * status --retrieve regeneration.
 */

export interface JsonlReportInput {
  manifest: RunManifest;
  /** Provider markdown contents keyed by report outputFile. */
  providerContents: Record<string, string>;
  sources: DeduplicatedSource[];
  /**
   * The synthesized grounded answer (answer.md body) when the run produced one.
   * provider/model come from the manifest's additive `answer` metadata.
   */
  answer?: { content: string; provider?: string; model?: string };
}

/** Line 1: run header. */
interface RunLine {
  type: 'run';
  version: 1;
  query: string;
  slug: string;
  timestamp: number;
  mode: string;
  succeeded: number;
  failed: number;
  pending: number;
  uniqueSources: number;
  totalCitations: number;
  refinedQueries?: Partial<Record<string, string>>;
}

/** Optional line for the grounded synthesized answer (librarium answer). */
interface AnswerLine {
  type: 'answer';
  provider?: string;
  model?: string;
  content: string;
}

/** One line per provider. */
interface ResultLine {
  type: 'result';
  id: string;
  tier: string;
  status: string;
  durationMs: number;
  citationCount: number;
  usage?: Record<string, unknown>;
  metering?: Record<string, unknown>;
  error?: string;
  fallbackFor?: string;
  content: string | null;
}

/** One line per deduped source. */
interface SourceLine {
  type: 'source';
  url: string;
  title?: string;
  providers: string[];
  citationCount: number;
}

/**
 * JSON.stringify replacer that drops undefined values so they are omitted
 * from the output entirely (rather than serialized as null).
 */
function replacer(_key: string, value: unknown): unknown {
  return value === undefined ? undefined : value;
}

/** Serialize one JSONL object, dropping undefined-valued keys. */
function serializeLine(
  obj: RunLine | AnswerLine | ResultLine | SourceLine,
): string {
  return JSON.stringify(obj, replacer);
}

/** Pure generator: manifest plus file contents in, full JSONL string out. */
export function generateJsonlReport(input: JsonlReportInput): string {
  const { manifest, providerContents, sources, answer } = input;
  const reports = manifest.providers;

  const succeeded = reports.filter((r) => r.status === 'success').length;
  const failed = reports.filter((r) => r.status === 'error').length;
  const pending = reports.filter((r) => r.status === 'async-pending').length;

  const runLine: RunLine = {
    type: 'run',
    version: 1,
    query: manifest.query,
    slug: manifest.slug,
    timestamp: manifest.timestamp,
    mode: manifest.mode,
    succeeded,
    failed,
    pending,
    uniqueSources: manifest.sources.unique,
    totalCitations: manifest.sources.total,
    ...(manifest.refinedQueries !== undefined
      ? { refinedQueries: manifest.refinedQueries }
      : {}),
  };

  // The grounded answer (when present) leads the body, right after the run
  // header. provider/model come from the manifest's additive answer metadata.
  const answerLine: AnswerLine | null =
    answer && answer.content.trim().length > 0
      ? {
          type: 'answer',
          provider: answer.provider,
          model: answer.model,
          content: answer.content,
        }
      : null;

  const resultLines: ResultLine[] = reports.map((report) => {
    const content =
      report.outputFile && providerContents[report.outputFile] !== undefined
        ? providerContents[report.outputFile]
        : null;

    const line: ResultLine = {
      type: 'result',
      id: report.id,
      tier: report.tier,
      status: report.status,
      durationMs: report.durationMs,
      citationCount: report.citationCount,
      content,
    };
    if (report.usage !== undefined) {
      line.usage = report.usage as unknown as Record<string, unknown>;
    }
    if (report.metering !== undefined) {
      line.metering = report.metering as unknown as Record<string, unknown>;
    }
    if (report.error !== undefined) line.error = report.error;
    if (report.fallbackFor !== undefined) line.fallbackFor = report.fallbackFor;
    return line;
  });

  const sourceLines: SourceLine[] = sources.map((source) => {
    const line: SourceLine = {
      type: 'source',
      url: source.url,
      providers: source.providers,
      citationCount: source.citationCount,
    };
    if (source.title !== undefined) line.title = source.title;
    return line;
  });

  const lines = [
    serializeLine(runLine),
    ...(answerLine ? [serializeLine(answerLine)] : []),
    ...resultLines.map((l) => serializeLine(l)),
    ...sourceLines.map((l) => serializeLine(l)),
  ];

  return lines.join('\n');
}

/**
 * Build and write results.jsonl for an existing run directory.
 * Returns the report path, or null when the directory has no run manifest.
 */
export function writeJsonlReport(runDir: string): string | null {
  const entry = readRunEntry(runDir);
  if (!entry) return null;
  entry.manifest.providers = enrichRetrievedReports(
    runDir,
    entry.manifest.providers,
  );

  const providerContents: Record<string, string> = {};
  for (const report of entry.manifest.providers) {
    if (!report.outputFile) continue;
    const filePath = join(runDir, report.outputFile);
    if (!existsSync(filePath)) continue;
    try {
      providerContents[report.outputFile] = readFileSync(filePath, 'utf-8');
    } catch {
      // Missing/unreadable provider files render as null content instead.
    }
  }

  let sources: DeduplicatedSource[] = [];
  const sourcesPath = join(runDir, 'sources.json');
  if (existsSync(sourcesPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(sourcesPath, 'utf-8'));
      if (Array.isArray(parsed)) sources = parsed as DeduplicatedSource[];
    } catch {
      // Corrupt sources.json degrades to an empty sources section.
    }
  }

  const answer = readAnswerArtifact(runDir, entry.manifest);

  const jsonl = generateJsonlReport({
    manifest: entry.manifest,
    providerContents,
    sources,
    ...(answer ? { answer } : {}),
  });
  const reportPath = join(runDir, 'results.jsonl');
  safeWriteFile(reportPath, jsonl);
  return reportPath;
}
