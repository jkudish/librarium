/**
 * Private presentation projection for Node report writers.
 *
 * The artifact repository owns filesystem recovery. Report writers consume
 * this projection without performing a second filesystem read or changing the
 * durable manifest.
 */
import type { RunArtifactSnapshot } from './node-run-artifacts.js';

export interface RunArtifactPresentation {
  readonly manifest: RunArtifactSnapshot['manifest'];
  readonly reports: RunArtifactSnapshot['reports'];
  readonly providerContents: Readonly<Record<string, string>>;
  readonly sources: RunArtifactSnapshot['sources'];
  readonly sourceSummary: RunArtifactPresentationSourceSummary;
  readonly answer?: RunArtifactSnapshot['answer'];
}

export interface RunArtifactPresentationSourceSummary {
  readonly total: number;
  readonly unique: number;
}

/** Source counts shown beside the persisted source rows in recovery views. */
export function presentationSourceSummary(
  snapshot: RunArtifactSnapshot,
): RunArtifactPresentationSourceSummary {
  return {
    total: snapshot.sources.reduce(
      (total, source) => total + source.citationCount,
      0,
    ),
    unique: snapshot.sources.length,
  };
}

export function projectRunArtifactSnapshot(
  snapshot: RunArtifactSnapshot,
): RunArtifactPresentation {
  const providerEntries: Array<[string, string]> = [];
  for (const report of snapshot.reports) {
    if (!report.outputFile) continue;
    const content = snapshot.providerArtifacts[report.id]?.content;
    if (content !== undefined) {
      providerEntries.push([report.outputFile, content]);
    }
  }

  return {
    manifest: snapshot.manifest,
    reports: snapshot.reports,
    providerContents: Object.fromEntries(providerEntries),
    sources: snapshot.sources,
    sourceSummary: presentationSourceSummary(snapshot),
    ...(snapshot.answer === undefined ? {} : { answer: snapshot.answer }),
  };
}
