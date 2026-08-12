import { dirname, resolve } from 'node:path';
import { readCanonicalRunReportingView } from '../node-canonical-reporting.js';
import {
  discoverCanonicalRunDirectories,
  readRunJsonSchemaVersion,
} from '../node-canonical-run.js';
import type { RunArtifactSnapshot } from '../node-run-artifact-codecs.js';
import { presentationSourceSummary } from '../node-run-artifact-presentation.js';
import { RunArtifactRepository } from '../node-run-artifacts.js';
import type { ProviderReport, RunManifest } from '../types.js';

/**
 * Pure(ish) helpers for `librarium browse`: run manifest discovery and
 * parsing plus preview extraction. No interactive code here so everything
 * stays unit-testable.
 */

export interface RunEntry {
  dir: string;
  manifest: RunManifest;
  schemaVersion?: 2 | 3;
}

export { isRunManifest } from '../core/run-manifest.js';

/** Parse a single run directory; returns null when there is no valid run.json. */
export function readRunEntry(
  dir: string,
  repository: RunArtifactRepository = new RunArtifactRepository(),
): RunEntry | null {
  const resolved = resolve(dir);
  const runsRoot = dirname(resolved);
  let schemaVersion: number | undefined;
  try {
    schemaVersion = readRunJsonSchemaVersion(runsRoot, resolved);
  } catch {
    schemaVersion = undefined;
  }
  if (schemaVersion === 3) {
    const view = readCanonicalRunReportingView(resolved);
    if (!view) return null;
    return {
      dir: resolved,
      manifest: view.presentation.generatorManifest,
      schemaVersion: 3,
    };
  }
  const manifest = repository.tryReadManifest(dir);
  return manifest ? { dir, manifest, schemaVersion: 2 } : null;
}

/** Read one selected run with non-mutating recovery projection for browsing. */
export function readRunSnapshot(
  dir: string,
  repository: RunArtifactRepository = new RunArtifactRepository(),
): RunArtifactSnapshot | null {
  return repository.tryReadSnapshot(dir, { view: 'recovery' });
}

export interface BrowseProviderPresentation {
  readonly report: Readonly<ProviderReport>;
  readonly content?: string;
}

export interface BrowseRunPresentation {
  readonly query: string;
  readonly mode: RunManifest['mode'];
  readonly providers: readonly BrowseProviderPresentation[];
  readonly sources: { readonly total: number; readonly unique: number };
}

export interface BrowseRunView {
  readonly runDir: string;
  readonly manifest: Readonly<RunManifest>;
  readonly presentation: BrowseRunPresentation;
  readonly summary?: string;
}

/** Project one immutable artifact snapshot into the browse view model. */
export function shapeBrowseRunSnapshot(
  snapshot: RunArtifactSnapshot,
): BrowseRunPresentation {
  const sources = presentationSourceSummary(snapshot);
  return {
    query: snapshot.manifest.query,
    mode: snapshot.manifest.mode,
    providers: snapshot.reports.map((report) => {
      const artifact = Object.hasOwn(snapshot.providerArtifacts, report.id)
        ? snapshot.providerArtifacts[report.id]
        : undefined;
      return {
        report,
        ...(artifact?.content === undefined
          ? {}
          : { content: artifact.content }),
      };
    }),
    sources,
  };
}

/** Read either historical v2 artifacts or a canonical v3 presentation. */
export function readBrowseRunView(
  dir: string,
  repository: RunArtifactRepository = new RunArtifactRepository(),
): BrowseRunView | null {
  const canonical = readCanonicalRunReportingView(dir);
  if (canonical) {
    const { presentation } = canonical;
    return {
      runDir: canonical.runDir,
      manifest: presentation.generatorManifest,
      presentation: {
        query: presentation.generatorManifest.query,
        mode: presentation.generatorManifest.mode,
        providers: presentation.reports.map((report) => ({
          report,
          content: presentation.providerContents[report.outputFile] ?? '',
        })),
        sources: {
          total: presentation.totalCitations,
          unique: presentation.sources.length,
        },
      },
      summary: canonical.summary,
    };
  }
  const snapshot = readRunSnapshot(dir, repository);
  return snapshot
    ? {
        runDir: snapshot.runDir,
        manifest: snapshot.manifest,
        presentation: shapeBrowseRunSnapshot(snapshot),
        summary: snapshot.summary,
      }
    : null;
}

/**
 * Discover recent runs under the output base directory (newest first).
 */
export function discoverRuns(
  baseDir: string,
  limit = 20,
  repository: RunArtifactRepository = new RunArtifactRepository(),
): RunEntry[] {
  const historical = repository
    .discoverRuns(baseDir, limit)
    .map(({ runDir, manifest }) => ({
      dir: runDir,
      manifest,
      schemaVersion: 2 as const,
    }));
  const canonical = discoverCanonicalRunDirectories(baseDir, limit).map(
    (runDir) => {
      const view = readCanonicalRunReportingView(runDir);
      if (!view) return null;
      return {
        dir: runDir,
        manifest: view.presentation.generatorManifest,
        schemaVersion: 3 as const,
      };
    },
  );
  return [...historical, ...canonical.filter((entry) => entry !== null)]
    .sort((left, right) => right.manifest.timestamp - left.manifest.timestamp)
    .slice(0, Math.max(0, limit));
}

/** Format a manifest timestamp (seconds) as a local date-time label. */
export function formatRunDate(timestampSeconds: number): string {
  const date = new Date(timestampSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Per-status tallies for a run, e.g. "4 ok, 1 failed, 1 pending". */
export function runTallies(manifest: RunManifest): string {
  const ok = manifest.providers.filter((p) => p.status === 'success').length;
  const failed = manifest.providers.filter((p) => p.status === 'error').length;
  const pending = manifest.providers.filter(
    (p) => p.status === 'async-pending',
  ).length;
  const parts = [`${ok} ok`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (pending > 0) parts.push(`${pending} pending`);
  return parts.join(', ');
}

/** Selectable label and hint for a run entry. */
export function describeRun(entry: RunEntry): { label: string; hint: string } {
  const query =
    entry.manifest.query.length > 60
      ? `${entry.manifest.query.slice(0, 59)}…`
      : entry.manifest.query;
  return {
    label: `${formatRunDate(entry.manifest.timestamp)}  ${query}`,
    hint: runTallies(entry.manifest),
  };
}

/**
 * Extract the first lines of a provider's markdown output for the inline
 * preview. Leading blank lines are dropped; a trailing ellipsis line marks
 * truncated content.
 */
export function extractPreview(content: string, maxLines = 25): string[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && (lines[0] as string).trim() === '') {
    lines.shift();
  }
  while (lines.length > 0 && (lines.at(-1) as string).trim() === '') {
    lines.pop();
  }
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), '…'];
}
