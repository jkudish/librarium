import type { RunArtifactPresentationSourceSummary } from '../node-run-artifact-presentation.js';
import type {
  DeduplicatedSource,
  ProviderReport,
  RunManifest,
} from '../types.js';

export interface HtmlReportInput {
  readonly manifest: Readonly<RunManifest>;
  /** Recovery-view reports used for presentation. Defaults to manifest providers. */
  readonly reports?: readonly Readonly<ProviderReport>[];
  /** Provider markdown contents keyed by report outputFile. */
  readonly providerContents: Readonly<Record<string, string>>;
  readonly sources: readonly Readonly<DeduplicatedSource>[];
  /** Counts aligned with the presented source rows. Defaults to manifest facts. */
  readonly sourceSummary?: RunArtifactPresentationSourceSummary;
  /** The synthesized grounded answer (answer.md body), when present. */
  readonly answer?: { content: string; provider?: string; model?: string };
}

/** Pure report view model; it cannot read or mutate run artifacts. */
export interface HtmlReportViewModel {
  readonly manifest: Readonly<RunManifest>;
  readonly reports: readonly Readonly<ProviderReport>[];
  readonly providerContents: Readonly<Record<string, string>>;
  readonly sources: readonly Readonly<DeduplicatedSource>[];
  readonly sourceSummary: RunArtifactPresentationSourceSummary;
  readonly answer?: { content: string; provider?: string; model?: string };
  /** First successful provider, or the first available report. */
  readonly activeIndex: number;
}

export function createHtmlReportViewModel(
  input: HtmlReportInput,
): HtmlReportViewModel {
  const reports = input.reports ?? input.manifest.providers;
  const firstSuccess = reports.findIndex(
    (report) => report.status === 'success',
  );
  return {
    manifest: input.manifest,
    reports,
    providerContents: input.providerContents,
    sources: input.sources,
    sourceSummary: input.sourceSummary ?? {
      total: input.manifest.sources.total,
      unique: input.sources.length,
    },
    ...(input.answer === undefined ? {} : { answer: input.answer }),
    activeIndex: firstSuccess === -1 ? 0 : firstSuccess,
  };
}
