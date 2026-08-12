import { safeWriteFile } from '../core/fs-utils.js';
import { projectRunArtifactSnapshot } from '../node-run-artifact-presentation.js';
import {
  RunArtifactRepository,
  type RunArtifactSnapshot,
} from '../node-run-artifacts.js';
import { generateJsonlReport } from './jsonl-report.js';

export function writeJsonlReportFromSnapshot(
  snapshot: RunArtifactSnapshot,
  repository: RunArtifactRepository = new RunArtifactRepository(),
): string {
  const reportPath = repository.resolveContainedPath(
    snapshot.runDir,
    'results.jsonl',
  );
  safeWriteFile(
    reportPath,
    generateJsonlReport(projectRunArtifactSnapshot(snapshot)),
  );
  return reportPath;
}

export function writeJsonlReport(
  runDir: string,
  repository: RunArtifactRepository = new RunArtifactRepository(),
): string | null {
  let snapshot: RunArtifactSnapshot;
  try {
    snapshot = repository.readSnapshot(runDir, { view: 'recovery' });
  } catch {
    return null;
  }
  return writeJsonlReportFromSnapshot(snapshot, repository);
}
