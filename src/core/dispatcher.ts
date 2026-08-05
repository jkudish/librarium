import pLimit from 'p-limit';
import { getProvider } from '../adapters/index.js';
import { sanitizeId } from '../constants.js';
import type {
  AsyncTaskHandle,
  Config,
  ProgressEvent,
  Provider,
  ProviderConfig,
  ProviderDispatchResult,
  ProviderMetering,
  ProviderReport,
  ProviderResult,
  ProviderUsage,
} from '../types.js';
import {
  BUDGET_SKIP_REASON,
  type BudgetTracker,
  ESTIMATE_BUDGET_SKIP_REASON,
  type EstimateBudgetTracker,
} from './budget.js';
import type { CredentialContext } from './credentials.js';
import { hasCredential } from './credentials.js';
import { UnsafeToRetrySubmissionError } from './errors.js';
import { buildProviderMetering } from './metering.js';

export interface DispatchOptions {
  config: Config;
  providerIds: string[];
  query: string;
  outputDir?: string;
  mode: 'sync' | 'async' | 'mixed';
  credentials?: CredentialContext;
  onProgress?: (event: ProgressEvent) => void;
  /**
   * Optional per-tier query overrides (e.g. produced by `run --refine`).
   * Providers receive the variant for their tier, falling back to `query`.
   */
  tierQueries?: Partial<Record<Provider['tier'], string>>;
  /**
   * Optional runtime spend circuit breaker. When supplied, each provider's
   * API-reported cost is folded in as results arrive; once the accumulated
   * total crosses the budget, providers that have not yet started are skipped
   * with a budget reason. In-flight requests are allowed to finish (aborting
   * mid-flight is provider-API-hostile). Additive and edge-safe: omit it and
   * dispatch behaves exactly as before.
   */
  budget?: BudgetTracker;
  /**
   * Optional pre-dispatch reservation circuit breaker. When supplied, each
   * provider's network-free estimated cost is reserved just before it launches;
   * once the accumulated reservation crosses the ceiling, not-yet-started
   * providers are skipped with an estimated-budget reason. Independent of
   * `budget` (reported cost): the two never reconcile. Additive and edge-safe.
   */
  estimatedBudget?: EstimateBudgetTracker;
  /**
   * Whether configured provider fallbacks may run. Defaults to true for normal
   * Librarium use. Callers that require an exact provider matrix, such as the
   * repository benchmark, can disable fallback dispatch explicitly.
   */
  allowFallbacks?: boolean;
}

export interface DispatchResult {
  reports: ProviderReport[];
  results: ProviderDispatchResult[];
  asyncTasks: AsyncTaskHandle[];
}

export async function dispatch(
  options: DispatchOptions,
): Promise<DispatchResult> {
  const {
    config,
    providerIds,
    query,
    mode,
    credentials,
    onProgress,
    budget,
    estimatedBudget,
  } = options;
  const queryForTier = (tier: Provider['tier']): string =>
    options.tierQueries?.[tier] ?? query;
  // Single metering normalization path: static kind + network-free estimate +
  // (when a result is in hand) the actual-cost lane, using each provider's
  // configured pricing overrides.
  const meteringFor = (id: string, usage?: ProviderUsage): ProviderMetering =>
    buildProviderMetering(id, config.providers[id], usage);
  const limit = pLimit(config.defaults.maxParallel);
  const reports: ProviderReport[] = [];
  const results: ProviderDispatchResult[] = [];
  const asyncTasks: AsyncTaskHandle[] = [];
  // Track fallback IDs already claimed to prevent two failing providers from
  // both triggering the same fallback concurrently (check+add is sync, no await
  // between them, so this is race-free despite the async event loop).
  const usedFallbacks = new Set<string>();

  // Execute a fallback provider, returning its report (with fallbackFor set)
  async function executeFallback(
    fallbackId: string,
    originalId: string,
    fallbackProvider: Provider,
  ): Promise<ProviderReport> {
    try {
      const result = await fallbackProvider.execute(
        queryForTier(fallbackProvider.tier),
        {
          timeout:
            fallbackProvider.tier === 'deep-research'
              ? config.defaults.asyncTimeout
              : config.defaults.timeout,
        },
      );
      const structured = createDispatchResult(
        fallbackId,
        fallbackProvider.tier,
        result,
        config.providers[fallbackId],
        originalId,
      );
      results.push(structured);

      return createReport(fallbackId, fallbackProvider.tier, structured);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const metering = meteringFor(fallbackId);
      results.push({
        provider: fallbackId,
        tier: fallbackProvider.tier,
        status: 'error',
        text: '',
        sourceUrls: [],
        citations: [],
        durationMs: 0,
        metering,
        error,
        fallbackFor: originalId,
      });
      return {
        id: fallbackId,
        tier: fallbackProvider.tier,
        status: 'error',
        durationMs: 0,
        wordCount: 0,
        citationCount: 0,
        outputFile: '',
        metaFile: '',
        metering,
        error,
        fallbackFor: originalId,
      };
    }
  }

  // Try to trigger a fallback for a failed provider. Returns the fallback report or null.
  async function tryFallback(
    id: string,
    errorReport: ProviderReport,
  ): Promise<ProviderReport | null> {
    if (options.allowFallbacks === false) return null;
    const fallbackId = config.providers[id]?.fallback;
    if (!fallbackId) return null;

    const fallbackProvider = getProvider(fallbackId);
    if (!fallbackProvider) return null;

    const fallbackConfig = config.providers[fallbackId];
    if (!fallbackConfig || !hasCredential(fallbackConfig.apiKey, credentials)) {
      return null;
    }

    // A selected primary owns its own dispatch/reporting path. Bail before
    // budget checks so the same provider cannot be recorded as skipped twice.
    if (providerIds.includes(fallbackId)) return null;

    // Fallbacks are API calls too: once the cost budget is exhausted, a
    // failed primary must not launch its backup.
    if (budget?.exceeded()) {
      recordBudgetSkip(
        fallbackId,
        fallbackProvider.tier,
        BUDGET_SKIP_REASON,
        id,
      );
      return null;
    }
    // A fallback is its own billable launch: skip it if the estimated budget is
    // already spent. (The reservation itself happens only once we've committed
    // to launching, below, so a fallback we bail on never reserves.)
    const fallbackEstimate = meteringFor(fallbackId).estimate;
    if (
      estimatedBudget?.exceeded() ||
      estimatedBudget?.wouldExceed(fallbackEstimate)
    ) {
      recordBudgetSkip(
        fallbackId,
        fallbackProvider.tier,
        ESTIMATE_BUDGET_SKIP_REASON,
        id,
      );
      return null;
    }

    // Claim this fallback atomically (synchronous check+add before any await)
    // to prevent two concurrently failing providers from both triggering the
    // same fallback target.
    if (usedFallbacks.has(fallbackId)) return null;
    usedFallbacks.add(fallbackId);

    // Committed to launching this fallback now: reserve its estimate against the
    // estimated budget. Reserving only after the claim guards means a fallback
    // we bail on above never leaves a phantom reservation behind.
    estimatedBudget?.reserve(fallbackEstimate);

    // Note: enabled is intentionally not checked here — fallback providers may
    // be configured with enabled: false so they only activate as backups.

    onProgress?.({
      providerId: fallbackId,
      event: 'fallback-started',
      report: errorReport,
    });

    return executeFallback(fallbackId, id, fallbackProvider);
  }

  // Fold a freshly produced report's reported cost into the budget (if any).
  // Returns nothing; the tracker is mutated in place.
  function recordBudget(report: ProviderReport): void {
    if (budget) budget.record(report.usage);
  }

  // Emit a budget-skipped report+result for a provider whose start was
  // suppressed because a budget (reported or estimated) was crossed. Metering
  // is still attached so consumers see the provider's capability even when it
  // never ran.
  function recordBudgetSkip(
    id: string,
    tier: Provider['tier'],
    reason: string,
    fallbackFor?: string,
  ): void {
    const metering = meteringFor(id);
    results.push({
      provider: id,
      tier,
      status: 'skipped',
      text: '',
      sourceUrls: [],
      citations: [],
      durationMs: 0,
      metering,
      error: reason,
      ...(fallbackFor ? { fallbackFor } : {}),
    });
    const report: ProviderReport = {
      id,
      tier,
      status: 'skipped',
      durationMs: 0,
      wordCount: 0,
      citationCount: 0,
      outputFile: '',
      metaFile: '',
      metering,
      error: reason,
      ...(fallbackFor ? { fallbackFor } : {}),
    };
    reports.push(report);
    // No progress emit: skipped reports are rendered once by the caller's
    // final skipped-report pass (and by resolveRemaining in live mode), so
    // emitting here would double-print them in non-live output.
  }

  const tasks = providerIds.map((id) =>
    limit(async (): Promise<void> => {
      const provider = getProvider(id);
      if (!provider) {
        const metering = meteringFor(id);
        results.push({
          provider: id,
          tier: 'raw-search',
          status: 'error',
          text: '',
          sourceUrls: [],
          citations: [],
          durationMs: 0,
          metering,
          error: `Provider "${id}" not found`,
        });
        reports.push({
          id,
          tier: 'raw-search',
          status: 'error',
          durationMs: 0,
          wordCount: 0,
          citationCount: 0,
          outputFile: '',
          metaFile: '',
          metering,
          error: `Provider "${id}" not found`,
        });
        return;
      }

      const providerConfig = config.providers[id];
      if (!providerConfig?.enabled) {
        const metering = meteringFor(id);
        results.push({
          provider: id,
          tier: provider.tier,
          status: 'skipped',
          text: '',
          sourceUrls: [],
          citations: [],
          durationMs: 0,
          metering,
          error: 'Provider not enabled',
        });
        reports.push({
          id,
          tier: provider.tier,
          status: 'skipped',
          durationMs: 0,
          wordCount: 0,
          citationCount: 0,
          outputFile: '',
          metaFile: '',
          metering,
          error: 'Provider not enabled',
        });
        return;
      }

      // Budget circuit breaker: once the accumulated API-reported cost has
      // crossed the budget, do not launch this provider. This check runs at the
      // moment the scheduler hands the task a slot (after earlier providers'
      // results have been recorded), so not-yet-started providers are skipped
      // while in-flight requests are left to finish.
      if (budget?.exceeded()) {
        recordBudgetSkip(id, provider.tier, BUDGET_SKIP_REASON);
        return;
      }

      // Estimated-cost reservation: skip if the estimate ceiling is already
      // spent, otherwise reserve this provider's network-free estimate before
      // it launches. Reserving only at launch means skipped providers never
      // leave a phantom reservation behind.
      const estimate = meteringFor(id).estimate;
      if (
        estimatedBudget?.exceeded() ||
        estimatedBudget?.wouldExceed(estimate)
      ) {
        recordBudgetSkip(id, provider.tier, ESTIMATE_BUDGET_SKIP_REASON);
        return;
      }
      estimatedBudget?.reserve(estimate);

      onProgress?.({ providerId: id, event: 'started' });

      // Background providers expose a complete persisted-task lifecycle.
      if (provider.execution === 'background' && mode !== 'sync') {
        try {
          const handle = await provider.submit(queryForTier(provider.tier), {
            timeout: config.defaults.asyncTimeout,
          });
          const pendingMetering = meteringFor(id);
          const submittedReport: ProviderReport = {
            id,
            tier: provider.tier,
            status: 'async-pending',
            durationMs: 0,
            wordCount: 0,
            citationCount: 0,
            outputFile: '',
            metaFile: '',
            metering: pendingMetering,
          };
          // Persist every accepted remote handle before any retrieval or
          // fallback work can throw. This is the paid-task write-ahead edge.
          onProgress?.({
            providerId: id,
            event: 'async-submitted',
            report: submittedReport,
            task: handle,
          });

          if (handle.status === 'cancelled') {
            const terminalError =
              handle.lastPollError ??
              (handle.providerStatus
                ? `Task was cancelled (${handle.providerStatus})`
                : 'Task was cancelled');
            const structured = createDispatchResult(
              id,
              provider.tier,
              {
                provider: id,
                tier: provider.tier,
                content: '',
                citations: [],
                durationMs: 0,
                error: terminalError,
              },
              providerConfig,
            );
            results.push(structured);
            const report = createReport(id, provider.tier, structured);
            report.task = {
              taskId: handle.taskId,
              submittedAt: handle.submittedAt,
              status: 'cancelled',
              completedAt: handle.completedAt ?? Date.now(),
              ...(handle.providerStatus
                ? { providerStatus: handle.providerStatus }
                : {}),
              lastPollError: terminalError,
            };
            reports.push(report);
            recordBudget(report);
            onProgress?.({
              providerId: id,
              event: 'error',
              report,
              task: handle,
            });
            const fallbackReport = await tryFallback(id, report);
            if (fallbackReport) {
              reports.push(fallbackReport);
              recordBudget(fallbackReport);
              onProgress?.({
                providerId: fallbackReport.id,
                event:
                  fallbackReport.status === 'success' ? 'completed' : 'error',
                report: fallbackReport,
              });
            }
            return;
          }

          // If submit is already terminal, retrieve immediately and treat it
          // as a synchronous result.
          if (handle.status === 'completed' || handle.status === 'failed') {
            const result = await provider.retrieve(handle);
            const structured = createDispatchResult(
              id,
              provider.tier,
              result,
              providerConfig,
            );
            results.push(structured);
            const report = createReport(id, provider.tier, structured);
            const retrievedAt = result.error ? undefined : Date.now();
            report.task = {
              taskId: handle.taskId,
              submittedAt: handle.submittedAt,
              status: handle.status,
              completedAt: handle.completedAt ?? Date.now(),
              ...(retrievedAt !== undefined ? { retrievedAt } : {}),
              ...(handle.providerStatus
                ? { providerStatus: handle.providerStatus }
                : {}),
              ...(result.error ? { lastPollError: result.error } : {}),
            };
            reports.push(report);
            recordBudget(report);

            if (result.error) {
              onProgress?.({
                providerId: id,
                event: 'error',
                report,
                task: handle,
              });
              const fallbackReport = await tryFallback(id, report);
              if (fallbackReport) {
                reports.push(fallbackReport);
                recordBudget(fallbackReport);
                if (fallbackReport.status === 'success') {
                  onProgress?.({
                    providerId: fallbackReport.id,
                    event: 'completed',
                    report: fallbackReport,
                  });
                } else {
                  onProgress?.({
                    providerId: fallbackReport.id,
                    event: 'error',
                    report: fallbackReport,
                  });
                }
              }
            } else {
              onProgress?.({
                providerId: id,
                event: 'completed',
                report,
                task: handle,
              });
            }
            return;
          }

          // Truly async — add to pending queue.
          // Note: fallback is not supported for tasks that remain pending/running,
          // since there is no synchronous result to evaluate. Fallback only fires
          // when a provider completes immediately with an error (handled above).
          asyncTasks.push(handle);
          results.push({
            provider: id,
            tier: provider.tier,
            status: 'async-pending',
            text: '',
            sourceUrls: [],
            citations: [],
            durationMs: 0,
            metering: pendingMetering,
          });
          reports.push(submittedReport);
          return;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const message =
            error instanceof UnsafeToRetrySubmissionError
              ? detail
              : `Background submission failed and was not retried because the remote task may have been accepted: ${detail}`;
          const structured = createDispatchResult(
            id,
            provider.tier,
            {
              provider: id,
              tier: provider.tier,
              content: '',
              citations: [],
              durationMs: 0,
              error: message,
            },
            providerConfig,
          );
          results.push(structured);
          const report = createReport(id, provider.tier, structured);
          reports.push(report);
          recordBudget(report);
          onProgress?.({ providerId: id, event: 'error', report });
          return;
        }
      }

      // Sync execution
      try {
        const result = await provider.execute(queryForTier(provider.tier), {
          // Deep-research providers poll inline in sync mode and can run for
          // minutes: give them the async deadline, not the per-request one.
          timeout:
            provider.tier === 'deep-research'
              ? config.defaults.asyncTimeout
              : config.defaults.timeout,
        });
        const structured = createDispatchResult(
          id,
          provider.tier,
          result,
          providerConfig,
        );
        results.push(structured);
        const report = createReport(id, provider.tier, structured);

        reports.push(report);
        recordBudget(report);

        // If provider returned an error result (e.g. 401/403), attempt fallback
        if (result.error) {
          onProgress?.({ providerId: id, event: 'error', report });
          const fallbackReport = await tryFallback(id, report);
          if (fallbackReport) {
            reports.push(fallbackReport);
            recordBudget(fallbackReport);
            if (fallbackReport.status === 'success') {
              onProgress?.({
                providerId: fallbackReport.id,
                event: 'completed',
                report: fallbackReport,
              });
            } else {
              onProgress?.({
                providerId: fallbackReport.id,
                event: 'error',
                report: fallbackReport,
              });
            }
          }
        } else {
          onProgress?.({ providerId: id, event: 'completed', report });
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const metering = meteringFor(id);
        results.push({
          provider: id,
          tier: provider.tier,
          status: 'error',
          text: '',
          sourceUrls: [],
          citations: [],
          durationMs: 0,
          metering,
          error,
        });
        const errorReport: ProviderReport = {
          id,
          tier: provider.tier,
          status: 'error',
          durationMs: 0,
          wordCount: 0,
          citationCount: 0,
          outputFile: '',
          metaFile: '',
          metering,
          error,
        };
        reports.push(errorReport);
        onProgress?.({ providerId: id, event: 'error', report: errorReport });

        // Attempt fallback
        const fallbackReport = await tryFallback(id, errorReport);
        if (fallbackReport) {
          reports.push(fallbackReport);
          recordBudget(fallbackReport);
          if (fallbackReport.status === 'success') {
            onProgress?.({
              providerId: fallbackReport.id,
              event: 'completed',
              report: fallbackReport,
            });
          } else {
            onProgress?.({
              providerId: fallbackReport.id,
              event: 'error',
              report: fallbackReport,
            });
          }
        }
      }
    }),
  );

  await Promise.allSettled(tasks);
  return { reports, results, asyncTasks };
}

/**
 * Normalize usage from a provider result. Adapters that report rich data
 * (totals, direct cost) set result.usage themselves; otherwise the legacy
 * tokenUsage pair is lifted into the normalized shape.
 */
export function normalizeUsage(
  result: Pick<ProviderResult, 'usage' | 'tokenUsage'>,
): ProviderUsage | undefined {
  if (result.usage) return stripUndefinedUsage(result.usage);
  const tokens = result.tokenUsage;
  if (!tokens || (tokens.input === undefined && tokens.output === undefined)) {
    return undefined;
  }
  const usage: ProviderUsage = {};
  if (tokens.input !== undefined) usage.inputTokens = tokens.input;
  if (tokens.output !== undefined) usage.outputTokens = tokens.output;
  if (tokens.input !== undefined && tokens.output !== undefined) {
    usage.totalTokens = tokens.input + tokens.output;
  }
  return usage;
}

/**
 * Drop keys an adapter set to undefined (e.g. a missing total_tokens field)
 * so serialized usage in run.json and .meta.json stays clean.
 */
function stripUndefinedUsage(usage: ProviderUsage): ProviderUsage {
  const clean: ProviderUsage = {};
  for (const [key, value] of Object.entries(usage)) {
    if (value !== undefined) {
      (clean as Record<string, unknown>)[key] = value;
    }
  }
  return clean;
}

function createDispatchResult(
  providerId: string,
  tier: Provider['tier'],
  result: ProviderResult,
  providerConfig: ProviderConfig | undefined,
  fallbackFor?: string,
): ProviderDispatchResult {
  const usage = normalizeUsage(result);
  return {
    provider: providerId,
    tier,
    status: result.error ? 'error' : 'success',
    text: result.content,
    sourceUrls: Array.from(
      new Set(result.citations.map((citation) => citation.url).filter(Boolean)),
    ),
    citations: result.citations,
    durationMs: result.durationMs,
    model: result.model,
    tokenUsage: result.tokenUsage,
    usage,
    metering: buildProviderMetering(providerId, providerConfig, usage),
    error: result.error,
    fallbackFor,
  };
}

function createReport(
  providerId: string,
  tier: Provider['tier'],
  result: ProviderDispatchResult,
): ProviderReport {
  const safeId = sanitizeId(providerId);
  return {
    id: providerId,
    tier,
    status: result.status,
    durationMs: result.durationMs,
    wordCount: result.text.split(/\s+/).filter(Boolean).length,
    citationCount: result.citations.length,
    outputFile:
      result.status === 'success' || result.status === 'error'
        ? `${safeId}.md`
        : '',
    metaFile:
      result.status === 'success' || result.status === 'error'
        ? `${safeId}.meta.json`
        : '',
    usage: result.usage,
    metering: result.metering,
    error: result.error,
    fallbackFor: result.fallbackFor,
  };
}
