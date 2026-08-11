import { RunArtifactRepository } from '../node-run-artifacts.js';

/**
 * Pure aggregation for `librarium usage`: walk the run.json manifests under the
 * output base dir and total up API-reported cost and tokens per provider. No
 * interactive or rendering code here so it stays unit-testable.
 *
 * Honest data only: cost figures come straight from each manifest's reported
 * usage. Manifests with no reported usage are counted but contribute 0.
 */

export interface ProviderUsageTotals {
  provider: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Number of runs this provider appeared in (with a success/usage entry). */
  runCount: number;
  /** Whether any run reported a cost for this provider. */
  reportedCost: boolean;
  /** Summed pre-dispatch estimated cost (a guess, kept separate from costUsd). */
  estimatedCostUsd: number;
  /** Whether any run carried a USD estimate for this provider. */
  hasEstimate: boolean;
}

export interface UsageAggregate {
  runCount: number;
  /** Runs that had no reported usage on any provider. */
  runsWithoutUsage: number;
  totalCostUsd: number;
  /** Number of runs that reported at least one cost figure. */
  runsWithCost: number;
  /** Summed pre-dispatch estimated cost across all runs (separate lane). */
  totalEstimatedCostUsd: number;
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
 * matched by timestamp when `days` is supplied. Returns zeroed totals when the
 * directory is missing or empty.
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
  let totalCostUsd = 0;
  let runsWithCost = 0;
  let totalEstimatedCostUsd = 0;
  let fromSeconds = Number.POSITIVE_INFINITY;
  let toSeconds = Number.NEGATIVE_INFINITY;

  for (const { manifest } of repository.discoverRuns(
    baseDir,
    Number.MAX_SAFE_INTEGER,
  )) {
    if (cutoffSeconds !== undefined && manifest.timestamp < cutoffSeconds) {
      continue;
    }

    runCount += 1;
    fromSeconds = Math.min(fromSeconds, manifest.timestamp);
    toSeconds = Math.max(toSeconds, manifest.timestamp);

    let runHadUsage = false;
    let runHadCost = false;

    for (const report of manifest.providers) {
      const usage = report.usage;
      const hasCost = typeof usage?.costUsd === 'number';
      const hasTokens =
        usage !== undefined &&
        (usage.inputTokens !== undefined ||
          usage.outputTokens !== undefined ||
          usage.totalTokens !== undefined);
      // Pre-dispatch estimate (a guess) — a separate lane from reported usage.
      // Skipped providers never launched, so their estimate is not counted.
      const estimateUsd = report.metering?.estimate?.estimatedCostUsd;
      const hasEstimate =
        report.status !== 'skipped' &&
        typeof estimateUsd === 'number' &&
        Number.isFinite(estimateUsd);
      if (!hasCost && !hasTokens && !hasEstimate) continue;

      // "Usage" here means actual reported usage; an estimate alone does not
      // count a run as having usage (it never made a measured call).
      if (hasCost || hasTokens) runHadUsage = true;
      const totals = byProvider.get(report.id) ?? {
        provider: report.id,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        runCount: 0,
        reportedCost: false,
        estimatedCostUsd: 0,
        hasEstimate: false,
      };
      totals.runCount += 1;
      if (hasCost) {
        const cost = usage?.costUsd ?? 0;
        totals.costUsd += cost;
        totals.reportedCost = true;
        totalCostUsd += cost;
        runHadCost = true;
      }
      if (hasEstimate) {
        totals.estimatedCostUsd += estimateUsd;
        totals.hasEstimate = true;
        totalEstimatedCostUsd += estimateUsd;
      }
      const input = usage?.inputTokens ?? 0;
      const output = usage?.outputTokens ?? 0;
      totals.inputTokens += input;
      totals.outputTokens += output;
      // Prefer a reported total; otherwise sum input+output.
      totals.totalTokens += usage?.totalTokens ?? input + output;
      byProvider.set(report.id, totals);
    }

    if (!runHadUsage) runsWithoutUsage += 1;
    if (runHadCost) runsWithCost += 1;
  }

  const providers = [...byProvider.values()].sort(
    (a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens,
  );

  return {
    runCount,
    runsWithoutUsage,
    totalCostUsd,
    runsWithCost,
    totalEstimatedCostUsd,
    providers,
    range: runCount > 0 ? { fromSeconds, toSeconds } : null,
  };
}
