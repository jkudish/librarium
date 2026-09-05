import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { projectCanonicalRunPresentation } from '../node-canonical-presentation.js';
import {
  type CanonicalRunManifestV3,
  discoverCanonicalRunDirectories,
  readCanonicalRunManifest,
  readRunJsonSchemaVersion,
} from '../node-canonical-run.js';
import type { RunArtifactSnapshot } from '../node-run-artifact-codecs.js';
import { presentationSourceSummary } from '../node-run-artifact-presentation.js';
import { RunArtifactRepository } from '../node-run-artifacts.js';
import type {
  AsyncTaskHandle,
  DeduplicatedSource,
  ProviderReport,
  RunManifest,
} from '../types.js';
import type { SilentRunResult } from './research.js';
import {
  type ResultPageOptions,
  type RunEvidence,
  resultIndex,
  resultPage,
} from './result-pages.js';

export {
  CONTENT_DELIMITER_BEGIN,
  CONTENT_DELIMITER_END,
  UNTRUSTED_CONTENT_WARNING,
  wrapUntrustedContent,
} from './result-pages.js';

/** Raised when a path escapes its expected containment boundary. */
export class PathContainmentError extends Error {}

/**
 * True when `child` resolves to a strict descendant of `parent` (not equal to
 * it and not outside it via `..` traversal). Both inputs are resolved to
 * absolute paths first so relative segments, `.`/`..`, and absolute escapes are
 * all normalized away before comparison.
 */
export function isStrictDescendant(parent: string, child: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  if (resolvedChild === resolvedParent) return false;
  const rel = relative(resolvedParent, resolvedChild);
  // Outside the parent if relative starts with `..` or is itself absolute
  // (different root/drive on Windows).
  return (
    rel.length > 0 &&
    !rel.startsWith(`..${sep}`) &&
    rel !== '..' &&
    !isAbsolute(rel)
  );
}

/**
 * Resolve a manifest-supplied relative file name against a run directory,
 * rejecting absolute paths and any value that escapes the run directory via
 * traversal. Returns the safe absolute path. Throws PathContainmentError on a
 * containment violation. Manifest fields are untrusted: a tampered run.json
 * must not be able to read arbitrary files.
 */
export function resolveContainedFile(runDir: string, fileName: string): string {
  if (isAbsolute(fileName)) {
    throw new PathContainmentError(
      `Refusing to read absolute path "${fileName}" from a run manifest.`,
    );
  }
  const resolvedRunDir = resolve(runDir);
  const candidate = resolve(resolvedRunDir, fileName);
  if (
    candidate !== resolvedRunDir &&
    !isStrictDescendant(resolvedRunDir, candidate)
  ) {
    throw new PathContainmentError(
      `Refusing to read "${fileName}": resolves outside the run directory.`,
    );
  }
  return candidate;
}

/**
 * The artifact operations that the MCP shaping layer needs. Keeping this as
 * a small structural type lets callers inject a repository without exposing
 * any filesystem details to the MCP protocol adapter.
 */
export type McpArtifactRepository = Pick<
  RunArtifactRepository,
  'discoverRuns' | 'readSnapshot' | 'resolveRunDirectory'
> &
  Partial<Pick<RunArtifactRepository, 'readManifest' | 'readProviderContent'>>;

export type ResearchToolResult = ReturnType<typeof resultIndex>;
export type GetResultsToolResult = ReturnType<typeof resultPage>;

function canonicalEvidence(
  manifest: CanonicalRunManifestV3,
  runDir: string,
): RunEvidence {
  const presentation = projectCanonicalRunPresentation(manifest, runDir, '');
  return {
    runDir,
    query: manifest.request.query,
    mode: manifest.request.mode,
    state:
      manifest.coordination_state.status === 'running' ? 'pending' : 'terminal',
    sources: {
      total: presentation.totalCitations,
      unique: presentation.sources.length,
    },
    entries: presentation.reports.map((report) => ({
      report,
      identity: presentation.providerIdentities[report.id],
      content: presentation.providerContents[report.outputFile] ?? '',
      available: Object.hasOwn(
        presentation.providerContents,
        report.outputFile,
      ),
      citations: presentation.providerCitations[report.id],
      error: report.error,
    })),
  };
}

/**
 * Shape a silent run into the compact `research` tool result. Full provider
 * content is deliberately excluded (token blowup) — callers fetch it via
 * `get_results`.
 */
export function shapeResearchResult(
  run:
    | SilentRunResult
    | {
        readonly manifest: RunManifest;
        readonly reports: ProviderReport[];
        readonly sources: DeduplicatedSource[];
        readonly totalCitations: number;
        readonly totalDurationMs: number;
        readonly outputDir?: string;
      },
): ResearchToolResult {
  const { manifest, reports } = run;
  if (manifest.schemaVersion === 2) {
    return resultIndex({
      runDir: manifest.outputDir,
      query: manifest.query,
      mode: manifest.mode,
      sources: {
        total: manifest.sources.total,
        unique: manifest.sources.unique,
      },
      entries: reports.map((report) => ({ report, content: '' })),
      state:
        manifest.status === 'running' || manifest.status === 'awaiting_async'
          ? 'pending'
          : 'terminal',
    });
  }
  const canonicalRun = run as SilentRunResult;
  return resultIndex(canonicalEvidence(manifest, canonicalRun.outputDir));
}

function snapshotEvidence(
  snapshot: RunArtifactSnapshot,
  runDir = snapshot.runDir,
): RunEvidence {
  return {
    runDir,
    query: snapshot.manifest.query,
    mode: snapshot.manifest.mode,
    state: ['running', 'awaiting_async'].includes(snapshot.manifest.status)
      ? 'pending'
      : 'terminal',
    sources: presentationSourceSummary(snapshot),
    entries: snapshot.reports.map((report) => ({
      report,
      content: Object.hasOwn(snapshot.providerArtifacts, report.id)
        ? (snapshot.providerArtifacts[report.id]?.content ?? '')
        : '',
      available:
        Object.hasOwn(snapshot.providerArtifacts, report.id) &&
        snapshot.providerArtifacts[report.id]?.content !== undefined,
      citations: Object.hasOwn(snapshot.providerArtifacts, report.id)
        ? snapshot.providerArtifacts[report.id]?.meta?.citations
        : undefined,
      error: report.error,
    })),
  };
}

/** Shape one immutable recovery snapshot for the MCP get_results transport. */
export function shapeRunResultsSnapshot(
  snapshot: RunArtifactSnapshot,
  provider?: string,
  runDir = snapshot.runDir,
  options: ResultPageOptions = {},
): GetResultsToolResult {
  return resultPage(snapshotEvidence(snapshot, runDir), provider, options);
}

function isRejectedArtifactError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith('Unsafe run artifact path: ') ||
      error.message.startsWith('Symlinked run artifact path is not allowed: '))
  );
}

function legacyArtifactContainmentMessage(fileName: string): string {
  if (isAbsolute(fileName)) {
    return `Refusing to read absolute path "${fileName}" from a run manifest.`;
  }
  return `Refusing to read "${fileName}": resolves outside the run directory.`;
}

/**
 * Preserve the old per-provider error payload for a malformed declared output
 * while the repository remains the only component that performs filesystem
 * reads and containment checks. This branch runs only when the repository
 * rejects one declared artifact before it can build a complete snapshot.
 */
function readRejectedArtifactResults(
  runDir: string,
  repository: McpArtifactRepository,
): RunEvidence | null {
  const manifest = repository.readManifest?.(runDir);
  if (!manifest) return null;
  const entries = manifest.providers.map((report) => {
    let raw: string | undefined;
    let containmentError: string | undefined;
    if (repository.readProviderContent) {
      try {
        raw = repository.readProviderContent(runDir, report) ?? undefined;
      } catch (error) {
        if (isRejectedArtifactError(error)) {
          containmentError = legacyArtifactContainmentMessage(
            report.outputFile,
          );
        }
      }
    }
    return {
      report,
      content: raw ?? '',
      available: raw !== undefined,
      error: containmentError ?? report.error,
    };
  });
  return {
    runDir,
    query: manifest.query,
    mode: manifest.mode,
    state: ['running', 'awaiting_async'].includes(manifest.status)
      ? 'pending'
      : 'terminal',
    sources: {
      total: manifest.sources.total,
      unique: manifest.sources.unique,
    },
    entries,
  };
}

/**
 * Resolve the run directory to read from: explicit `runDir`, else the most
 * recent run under the configured output base. Returns null when none exists.
 *
 * An explicitly-passed `runDir` must resolve to a strict descendant of the
 * resolved output base; traversal (`..`) or absolute escapes are rejected with
 * a PathContainmentError so a caller cannot point the read tools at arbitrary
 * filesystem locations.
 */
export function resolveRunDir(
  baseDir: string,
  runDir?: string,
  repository: McpArtifactRepository = new RunArtifactRepository(),
): string | null {
  if (runDir) {
    if (!isStrictDescendant(baseDir, runDir)) {
      throw new PathContainmentError(
        `runDir "${runDir}" must be inside the configured output base "${baseDir}".`,
      );
    }
    // The repository returns its canonical real path after validation. Keep
    // the caller's resolved spelling in the protocol payload for compatibility
    // with the existing MCP surface (for example, macOS `/var` aliases).
    try {
      if (readRunJsonSchemaVersion(baseDir, runDir) === 3) {
        return resolve(runDir);
      }
    } catch {
      // Preserve the legacy repository error/null behavior below.
    }
    return repository.resolveRunDirectory(baseDir, runDir)
      ? resolve(runDir)
      : null;
  }
  const canonical = discoverCanonicalRunDirectories(baseDir, 1)[0];
  const recent = repository.discoverRuns(baseDir, 1);
  const latest = recent[0];
  if (canonical && latest) {
    const canonicalManifest = readCanonicalRunManifest(baseDir, canonical);
    return Date.parse(canonicalManifest.generated_at) >=
      latest.manifest.timestamp * 1_000
      ? canonical
      : latest.runDir;
  }
  if (canonical) return canonical;
  if (!latest) return null;
  // Discovery returns the repository's canonical path. Re-express it under
  // the configured base spelling without trusting manifest.outputDir, which
  // is untrusted data and may contain an unrelated absolute path.
  const canonicalBase = repository.resolveRunDirectory(baseDir);
  if (canonicalBase && isStrictDescendant(canonicalBase, latest.runDir)) {
    return join(baseDir, relative(canonicalBase, latest.runDir));
  }
  return latest.runDir;
}

/**
 * Read saved evidence through the existing canonical/historical readers.
 * Reading never resumes a run, initializes adapters, or writes artifacts.
 *
 * Manifest `outputFile` values are untrusted (a tampered run.json could point
 * anywhere): absolute paths and traversal outside the run directory are
 * rejected per provider, with the rejection surfaced in that provider's
 * `error` field instead of file content. Returned content is wrapped in
 * explicit untrusted-content delimiters; the payload's `contentWarning` field
 * tells clients to treat it as evidence, not instructions.
 */
function readRunEvidence(
  runDir: string,
  repository: McpArtifactRepository,
): RunEvidence | null {
  const runsRoot = dirname(resolve(runDir));
  if (readRunJsonSchemaVersion(runsRoot, runDir) === 3) {
    const manifest = readCanonicalRunManifest(runsRoot, runDir);
    const evidence = canonicalEvidence(manifest, runDir);
    for (const entry of evidence.entries) {
      try {
        const path = resolveContainedFile(runDir, entry.report.outputFile);
        const metadata = lstatSync(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new PathContainmentError(
            'Derived canonical provider output must be a regular file.',
          );
        }
        entry.content = readFileSync(path, 'utf8');
        entry.available = true;
      } catch {
        // Derived files are optional. Canonical safe output is authoritative.
      }
    }
    return evidence;
  }
  let snapshot: ReturnType<RunArtifactRepository['readSnapshot']>;
  try {
    snapshot = repository.readSnapshot(runDir, { view: 'recovery' });
  } catch (error) {
    // Preserve the helper's historical null result when the directory exists
    // but has no supported run manifest. The repository still owns all path
    // and symlink validation, so other errors remain visible to the caller.
    if (
      error instanceof Error &&
      error.message.startsWith('Run manifest does not exist:')
    ) {
      return null;
    }
    if (isRejectedArtifactError(error)) {
      const rejected = readRejectedArtifactResults(runDir, repository);
      if (rejected) return rejected;
    }
    throw error;
  }

  return snapshotEvidence(snapshot, runDir);
}

/** Every saved-content path uses the same total response and cursor boundary. */
export function readRunResults(
  runDir: string,
  provider?: string,
  repository: McpArtifactRepository = new RunArtifactRepository(),
  options: ResultPageOptions = {},
): GetResultsToolResult | null {
  const evidence = readRunEvidence(runDir, repository);
  return evidence ? resultPage(evidence, provider, options) : null;
}

export function readRunIndex(
  runDir: string,
  repository: McpArtifactRepository = new RunArtifactRepository(),
): ResearchToolResult | null {
  const evidence = readRunEvidence(runDir, repository);
  return evidence ? resultIndex(evidence) : null;
}

/** Load async task handles for a run directory. */
export function loadRunAsyncTasks(
  runDir: string,
  repository: McpArtifactRepository = new RunArtifactRepository(),
): AsyncTaskHandle[] {
  const snapshot = repository.readSnapshot(runDir, { view: 'authoritative' });
  return snapshot.manifest.providers.flatMap((provider) => {
    if (!provider.task || provider.task.retrievedAt !== undefined) return [];
    return [
      {
        provider: provider.id,
        taskId: provider.task.taskId,
        query: snapshot.manifest.query,
        submittedAt: provider.task.submittedAt,
        status: provider.task.status,
        outputDir: snapshot.runDir,
        ...(provider.task.lastPolledAt !== undefined
          ? { lastPolledAt: provider.task.lastPolledAt }
          : {}),
        ...(provider.task.completedAt !== undefined
          ? { completedAt: provider.task.completedAt }
          : {}),
        ...(provider.task.providerStatus !== undefined
          ? { providerStatus: provider.task.providerStatus }
          : {}),
        ...(provider.task.lastPollError !== undefined
          ? { lastPollError: provider.task.lastPollError }
          : {}),
      },
    ];
  });
}
