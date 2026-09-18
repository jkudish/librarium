/** Pure report-generator inputs projected from the canonical v3 authority. */
import type { HtmlReportInput } from './commands/html-report.js';
import type { JsonlReportInput } from './commands/jsonl-report.js';
import type { CanonicalRunReportingView } from './node-canonical-report-loading.js';

function presentationInput(view: CanonicalRunReportingView) {
  const { presentation } = view;
  return {
    manifest: presentation.generatorManifest,
    reports: presentation.reports,
    providerContents: presentation.providerContents,
    sources: presentation.sources,
    sourceSummary: {
      total: presentation.totalCitations,
      unique: presentation.sources.length,
    },
  };
}

/** Existing HTML renderer input, derived only from canonical run.json. */
export function canonicalHtmlReportInput(
  view: CanonicalRunReportingView,
): HtmlReportInput {
  return presentationInput(view);
}

/** Existing JSONL renderer input, derived only from canonical run.json. */
export function canonicalJsonlReportInput(
  view: CanonicalRunReportingView,
): JsonlReportInput {
  return presentationInput(view);
}
