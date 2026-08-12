import { basename, dirname, resolve } from 'node:path';
import { generateHtmlReport } from './commands/html-report.js';
import { writeHtmlReport } from './commands/html-report-v2.js';
import { generateJsonlReport } from './commands/jsonl-report.js';
import { writeJsonlReport } from './commands/jsonl-report-v2.js';
import { safeWriteFile } from './core/fs-utils.js';
import { generateSummary } from './core/synthesis.js';
import {
  type CanonicalRunPresentation,
  projectCanonicalRunPresentation,
} from './node-canonical-presentation.js';
import {
  readCanonicalRunManifest,
  readRunJsonSchemaVersion,
} from './node-canonical-run.js';
import {
  DEFAULT_FS,
  resolveContainedPathWithFs,
  resolveRunDirectoryWithFs,
} from './node-run-artifact-codecs.js';
import type { RunArtifactRepository } from './node-run-artifacts.js';

export interface CanonicalRunReportingView {
  readonly runDir: string;
  readonly presentation: CanonicalRunPresentation;
  readonly summary: string;
}

/** Read a v3 run into a one-way presentation view without mutating authority. */
export function readCanonicalRunReportingView(
  runDirInput: string,
): CanonicalRunReportingView | null {
  const runDir = resolve(runDirInput);
  const runsRoot = dirname(runDir);
  let schemaVersion: number | undefined;
  try {
    schemaVersion = readRunJsonSchemaVersion(runsRoot, runDir);
  } catch {
    return null;
  }
  if (schemaVersion !== 3) return null;
  try {
    const manifest = readCanonicalRunManifest(runsRoot, runDir);
    const presentation = projectCanonicalRunPresentation(
      manifest,
      runDir,
      basename(runDir),
    );
    return {
      runDir,
      presentation,
      summary: generateSummary({
        query: manifest.request.query,
        reports: presentation.reports,
        sources: presentation.sources,
        asyncTasks: [],
        timestamp: Math.floor(Date.parse(manifest.generated_at) / 1_000),
      }),
    };
  } catch {
    return null;
  }
}

function reportPath(runDir: string, fileName: string): string {
  const safeRunDir = resolveRunDirectoryWithFs(DEFAULT_FS, runDir);
  if (!safeRunDir)
    throw new Error(`Invalid canonical run directory: ${runDir}`);
  return resolveContainedPathWithFs(DEFAULT_FS, safeRunDir, fileName);
}

/** Version-dispatching writer used only by standalone presentation commands. */
export function writeHtmlReportForRun(
  runDir: string,
  repository?: RunArtifactRepository,
): string | null {
  const canonical = readCanonicalRunReportingView(runDir);
  if (!canonical) return writeHtmlReport(runDir, repository);
  const { presentation } = canonical;
  const path = reportPath(canonical.runDir, 'report.html');
  safeWriteFile(
    path,
    generateHtmlReport({
      manifest: presentation.generatorManifest,
      reports: presentation.reports,
      providerContents: presentation.providerContents,
      sources: presentation.sources,
      sourceSummary: {
        total: presentation.totalCitations,
        unique: presentation.sources.length,
      },
    }),
  );
  return path;
}

/** Version-dispatching writer used only by standalone presentation commands. */
export function writeJsonlReportForRun(
  runDir: string,
  repository?: RunArtifactRepository,
): string | null {
  const canonical = readCanonicalRunReportingView(runDir);
  if (!canonical) return writeJsonlReport(runDir, repository);
  const { presentation } = canonical;
  const path = reportPath(canonical.runDir, 'results.jsonl');
  safeWriteFile(
    path,
    generateJsonlReport({
      manifest: presentation.generatorManifest,
      reports: presentation.reports,
      providerContents: presentation.providerContents,
      sources: presentation.sources,
      sourceSummary: {
        total: presentation.totalCitations,
        unique: presentation.sources.length,
      },
    }),
  );
  return path;
}
