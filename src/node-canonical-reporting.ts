import { generateHtmlReport } from './commands/html-report.js';
import { writeHtmlReport } from './commands/html-report-v2.js';
import { generateJsonlReport } from './commands/jsonl-report.js';
import { writeJsonlReport } from './commands/jsonl-report-v2.js';
import { safeWriteFile } from './core/fs-utils.js';
import { readCanonicalRunReportingView } from './node-canonical-report-loading.js';
import {
  canonicalHtmlReportInput,
  canonicalJsonlReportInput,
} from './node-canonical-report-view-model.js';
import {
  DEFAULT_FS,
  resolveContainedPathWithFs,
  resolveRunDirectoryWithFs,
} from './node-run-artifact-codecs.js';
import type { RunArtifactRepository } from './node-run-artifacts.js';

export type { CanonicalRunReportingView } from './node-canonical-report-loading.js';
export { readCanonicalRunReportingView } from './node-canonical-report-loading.js';

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
  const path = reportPath(canonical.runDir, 'report.html');
  safeWriteFile(path, generateHtmlReport(canonicalHtmlReportInput(canonical)));
  return path;
}

/** Version-dispatching writer used only by standalone presentation commands. */
export function writeJsonlReportForRun(
  runDir: string,
  repository?: RunArtifactRepository,
): string | null {
  const canonical = readCanonicalRunReportingView(runDir);
  if (!canonical) return writeJsonlReport(runDir, repository);
  const path = reportPath(canonical.runDir, 'results.jsonl');
  safeWriteFile(
    path,
    generateJsonlReport(canonicalJsonlReportInput(canonical)),
  );
  return path;
}
