import { safeWriteFile } from '../core/fs-utils.js';
import { projectRunArtifactSnapshot } from '../node-run-artifact-presentation.js';
import {
  RunArtifactRepository,
  type RunArtifactSnapshot,
} from '../node-run-artifacts.js';
import { generateHtmlReport } from './html-report.js';

export function writeHtmlReportFromSnapshot(
  snapshot: RunArtifactSnapshot,
  repository: RunArtifactRepository = new RunArtifactRepository(),
): string {
  const reportPath = repository.resolveContainedPath(
    snapshot.runDir,
    'report.html',
  );
  safeWriteFile(
    reportPath,
    generateHtmlReport(projectRunArtifactSnapshot(snapshot)),
  );
  return reportPath;
}

export function writeHtmlReport(
  runDir: string,
  repository: RunArtifactRepository = new RunArtifactRepository(),
): string | null {
  let snapshot: RunArtifactSnapshot;
  try {
    snapshot = repository.readSnapshot(runDir, { view: 'recovery' });
  } catch {
    return null;
  }
  return writeHtmlReportFromSnapshot(snapshot, repository);
}
