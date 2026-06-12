import pLimit from 'p-limit';
import { getProvider } from '../adapters/index.js';
import { sanitizeId } from '../constants.js';
import type {
  AsyncTaskHandle,
  Config,
  ProgressEvent,
  Provider,
  ProviderDispatchResult,
  ProviderReport,
  ProviderResult,
  ProviderUsage,
} from '../types.js';
import type { CredentialContext } from './credentials.js';
import { hasCredential } from './credentials.js';

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
}

export interface DispatchResult {
  reports: ProviderReport[];
  results: ProviderDispatchResult[];
  asyncTasks: AsyncTaskHandle[];
}

export async function dispatch(
  options: DispatchOptions,
): Promise<DispatchResult> {
  const { config, providerIds, query, mode, credentials, onProgress } = options;
  const queryForTier = (tier: Provider['tier']): string =>
    options.tierQueries?.[tier] ?? query;
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
          timeout: config.defaults.timeout,
        },
      );
      const structured = createDispatchResult(
        fallbackId,
        fallbackProvider.tier,
        result,
        originalId,
      );
      results.push(structured);

      return createReport(fallbackId, fallbackProvider.tier, structured);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      results.push({
        provider: fallbackId,
        tier: fallbackProvider.tier,
        status: 'error',
        text: '',
        sourceUrls: [],
        citations: [],
        durationMs: 0,
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
    const fallbackId = config.providers[id]?.fallback;
    if (!fallbackId) return null;

    const fallbackProvider = getProvider(fallbackId);
    if (!fallbackProvider) return null;

    const fallbackConfig = config.providers[fallbackId];
    if (!fallbackConfig || !hasCredential(fallbackConfig.apiKey, credentials)) {
      return null;
    }

    // Don't use a fallback that's already running as a primary in this dispatch
    if (providerIds.includes(fallbackId)) return null;

    // Claim this fallback atomically (synchronous check+add before any await)
    // to prevent two concurrently failing providers from both triggering the
    // same fallback target.
    if (usedFallbacks.has(fallbackId)) return null;
    usedFallbacks.add(fallbackId);

    // Note: enabled is intentionally not checked here — fallback providers may
    // be configured with enabled: false so they only activate as backups.

    onProgress?.({
      providerId: fallbackId,
      event: 'fallback-started',
      report: errorReport,
    });

    return executeFallback(fallbackId, id, fallbackProvider);
  }

  const tasks = providerIds.map((id) =>
    limit(async (): Promise<void> => {
      const provider = getProvider(id);
      if (!provider) {
        results.push({
          provider: id,
          tier: 'raw-search',
          status: 'error',
          text: '',
          sourceUrls: [],
          citations: [],
          durationMs: 0,
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
          error: `Provider "${id}" not found`,
        });
        return;
      }

      const providerConfig = config.providers[id];
      if (!providerConfig?.enabled) {
        results.push({
          provider: id,
          tier: provider.tier,
          status: 'skipped',
          text: '',
          sourceUrls: [],
          citations: [],
          durationMs: 0,
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
          error: 'Provider not enabled',
        });
        return;
      }

      onProgress?.({ providerId: id, event: 'started' });

      // For deep-research providers in async/mixed mode, use submit
      if (
        provider.tier === 'deep-research' &&
        mode !== 'sync' &&
        provider.submit
      ) {
        try {
          const handle = await provider.submit(queryForTier(provider.tier), {
            timeout: config.defaults.asyncTimeout,
          });

          // If submit already completed (e.g. Gemini/Perplexity wrap execute),
          // retrieve immediately and treat as sync result
          if (
            (handle.status === 'completed' || handle.status === 'failed') &&
            provider.retrieve
          ) {
            const result = await provider.retrieve(handle);
            const structured = createDispatchResult(id, provider.tier, result);
            results.push(structured);
            const report = createReport(id, provider.tier, structured);
            reports.push(report);

            if (result.error) {
              onProgress?.({ providerId: id, event: 'error', report });
              const fallbackReport = await tryFallback(id, report);
              if (fallbackReport) {
                reports.push(fallbackReport);
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
          });
          const pendingReport: ProviderReport = {
            id,
            tier: provider.tier,
            status: 'async-pending',
            durationMs: 0,
            wordCount: 0,
            citationCount: 0,
            outputFile: '',
            metaFile: '',
          };
          reports.push(pendingReport);
          onProgress?.({
            providerId: id,
            event: 'async-submitted',
            report: pendingReport,
          });
          return;
        } catch {
          // Fall through to sync execution
        }
      }

      // Sync execution
      try {
        const result = await provider.execute(queryForTier(provider.tier), {
          timeout: config.defaults.timeout,
        });
        const structured = createDispatchResult(id, provider.tier, result);
        results.push(structured);
        const report = createReport(id, provider.tier, structured);

        reports.push(report);

        // If provider returned an error result (e.g. 401/403), attempt fallback
        if (result.error) {
          onProgress?.({ providerId: id, event: 'error', report });
          const fallbackReport = await tryFallback(id, report);
          if (fallbackReport) {
            reports.push(fallbackReport);
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
        results.push({
          provider: id,
          tier: provider.tier,
          status: 'error',
          text: '',
          sourceUrls: [],
          citations: [],
          durationMs: 0,
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
          error,
        };
        reports.push(errorReport);
        onProgress?.({ providerId: id, event: 'error', report: errorReport });

        // Attempt fallback
        const fallbackReport = await tryFallback(id, errorReport);
        if (fallbackReport) {
          reports.push(fallbackReport);
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
  if (result.usage) return result.usage;
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

function createDispatchResult(
  providerId: string,
  tier: Provider['tier'],
  result: ProviderResult,
  fallbackFor?: string,
): ProviderDispatchResult {
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
    usage: normalizeUsage(result),
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
    error: result.error,
    fallbackFor: result.fallbackFor,
  };
}
