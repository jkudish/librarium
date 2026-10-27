import { RunArtifactRepository } from '../node-run-artifacts.js';
import { discoverRuns } from './browse-data.js';

/**
 * Pure aggregation for `librarium usage`: discover authoritative v2 and v3
 * run.json manifests under the output base dir and total up API-reported cost
 * and tokens per provider. No interactive or rendering code here so it stays
 * unit-testable.
 *
 * Honest data only: cost figures come straight from each manifest's reported
 * usage. A provider result without a reported cost is unknown, never $0; a
 * pricing-snapshot estimate is kept in its own lane.
 */

export interface ProviderUsageTotals {
  provider: string;
  /** Summed provider-reported cost; null when no run reported one. */
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Number of runs this provider appeared in (any launched result). */
  runCount: number;
  /** Whether any run reported a cost for this provider. */
  reportedCost: boolean;
  /** Summed estimated cost (a guess, kept separate from costUsd); null when none. */
  estimatedCostUsd: number | null;
  /** Whether any run carried a USD estimate for this provider. */
  hasEstimate: boolean;
  /** Runs with neither a reported cost nor an estimate: cost unknown. */
  unknownCostRuns: number;
  /** Provider-reported server-side search requests, when any were reported. */
  searchRequests?: number;
  /** Provider-reported server-side tool counts (for example X posts fetched). */
  serverToolUsage?: Record<string, number>;
}

export interface UsageAggregate {
  runCount: number;
  /** Runs that had no reported usage on any provider. */
  runsWithoutUsage: number;
  /** Summed provider-reported cost; null when no run reported one. */
  totalCostUsd: number | null;
  /** Number of runs that reported at least one cost figure. */
  runsWithCost: number;
  /** Summed estimated cost across all runs (separate lane); null when none. */
  totalEstimatedCostUsd: number | null;
  /** Provider results with neither a reported cost nor an estimate. */
  unknownCostResults: number;
  providers: ProviderUsageTotals[];
  /** Earliest and latest manifest timestamps (unix seconds), or null when empty. */
  range: { fromSeconds: number; toSeconds: number } | null;
}

export interface UsageScanOptions {
  /** Only include manifests newer than this many days. Omit for all. */
  days?: number;
  /** Clock injection for deterministic tests (ms). */
  now?: number;
}

/**
 * Aggregate usage across all run manifests under `baseDir`. Manifests are
 * matched by timestamp when `days` is supplied. Returns empty totals (no
 * runs, unknown cost) when the directory is missing or empty.
 */
export function aggregateUsage(
  baseDir: string,
  opts: UsageScanOptions = {},
  repository: RunArtifactRepository = new RunArtifactRepository(),
): UsageAggregate {
  const now = opts.now ?? Date.now();
  const cutoffSeconds =
    opts.days !== undefined
      ? Math.floor((now - opts.days * 24 * 60 * 60 * 1000) / 1000)
      : undefined;

  const byProvider = new Map<string, ProviderUsageTotals>();
  let runCount = 0;
  let runsWithoutUsage = 0;
  let totalCostUsd: number | null = null;
  let runsWithCost = 0;
  let totalEstimatedCostUsd: number | null = null;
  let unknownCostResults = 0;
  let fromSeconds = Number.POSITIVE_INFINITY;
  let toSeconds = Number.NEGATIVE_INFINITY;

  const runsByDirectory = new Map<
    string,
    ReturnType<typeof discoverRuns>[number]
  >();
  for (const run of discoverRuns(
    baseDir,
    Number.MAX_SAFE_INTEGER,
    repository,
  )) {
    const existing = runsByDirectory.get(run.dir);
    if (!existing || run.schemaVersion === 3) {
      runsByDirectory.set(run.dir, run);
    }
  }

  for (const { manifest } of runsByDirectory.values()) {
    if (cutoffSeconds !== undefined && manifest.timestamp < cutoffSeconds) {
      continue;
    }

    runCount += 1;
    fromSeconds = Math.min(fromSeconds, manifest.timestamp);
    toSeconds = Math.max(toSeconds, manifest.timestamp);

    let runHadUsage = false;
    let runHadCost = false;

    for (const report of manifest.providers) {
      // Skipped providers never launched, so they neither bill nor count.
      if (report.status === 'skipped') continue;
      const usage = report.usage;
      const hasCost = typeof usage?.costUsd === 'number';
      const hasTokens =
        usage !== undefined &&
        (usage.inputTokens !== undefined ||
          usage.outputTokens !== undefined ||
          usage.totalTokens !== undefined);
      // An estimate (a guess) is a separate lane from reported usage.
      const estimateUsd = report.metering?.estimate?.estimatedCostUsd;
      const hasEstimate =
        typeof estimateUsd === 'number' && Number.isFinite(estimateUsd);

      // "Usage" here means actual reported usage; an estimate alone does not
      // count a run as having usage (it never made a measured call).
      if (hasCost || hasTokens) runHadUsage = true;
      const totals = byProvider.get(report.id) ?? {
        provider: report.id,
        costUsd: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        runCount: 0,
        reportedCost: false,
        estimatedCostUsd: null,
        hasEstimate: false,
        unknownCostRuns: 0,
      };
      totals.runCount += 1;
      if (hasCost) {
        const cost = usage?.costUsd ?? 0;
        totals.costUsd = (totals.costUsd ?? 0) + cost;
        totals.reportedCost = true;
        totalCostUsd = (totalCostUsd ?? 0) + cost;
        runHadCost = true;
      } else if (hasEstimate) {
        totals.estimatedCostUsd = (totals.estimatedCostUsd ?? 0) + estimateUsd;
        totals.hasEstimate = true;
        totalEstimatedCostUsd = (totalEstimatedCostUsd ?? 0) + estimateUsd;
      } else {
        totals.unknownCostRuns += 1;
        unknownCostResults += 1;
      }
      const input = usage?.inputTokens ?? 0;
      const output = usage?.outputTokens ?? 0;
      totals.inputTokens += input;
      totals.outputTokens += output;
      // Prefer a reported total; otherwise sum input+output.
      totals.totalTokens += usage?.totalTokens ?? input + output;
      if (usage?.searchRequests !== undefined) {
        totals.searchRequests =
          (totals.searchRequests ?? 0) + usage.searchRequests;
      }
      for (const [tool, count] of Object.entries(
        usage?.serverToolUsage ?? {},
      )) {
        totals.serverToolUsage ??= {};
        totals.serverToolUsage[tool] =
          (totals.serverToolUsage[tool] ?? 0) + count;
      }
      byProvider.set(report.id, totals);
    }

    if (!runHadUsage) runsWithoutUsage += 1;
    if (runHadCost) runsWithCost += 1;
  }

  const providers = [...byProvider.values()].sort(
    (a, b) =>
      (b.costUsd ?? 0) - (a.costUsd ?? 0) ||
      (b.estimatedCostUsd ?? 0) - (a.estimatedCostUsd ?? 0) ||
      b.totalTokens - a.totalTokens,
  );

  return {
    runCount,
    runsWithoutUsage,
    totalCostUsd,
    runsWithCost,
    totalEstimatedCostUsd,
    unknownCostResults,
    providers,
    range: runCount > 0 ? { fromSeconds, toSeconds } : null,
  };
}
