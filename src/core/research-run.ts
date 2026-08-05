import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ProviderBase } from '../adapters/base.js';
import { getAllProviders, getProvider } from '../adapters/index.js';
import type {
  Citation,
  Config,
  DeduplicatedSource,
  ProgressEvent,
  Provider,
  ProviderDispatchResult,
  ProviderReport,
  RunManifest,
} from '../types.js';
import type { BudgetTracker, EstimateBudgetTracker } from './budget.js';
import type { CredentialContext } from './credentials.js';
import {
  type DispatchOptions,
  type DispatchResult,
  dispatch,
  type ProviderLookup,
} from './dispatcher.js';
import { safeWriteFile } from './fs-utils.js';
import type { HttpClient } from './http-client.js';
import { deduplicateSources } from './normalizer.js';
import { buildPrompt } from './prompt-builder.js';
import {
  applyRunLifecycle,
  createRunManifest,
  markRunFailed,
  mutateRunManifest,
  toRunTaskState,
  upsertProviderReport,
} from './run-manifest.js';
import { generateSummary } from './synthesis.js';

export interface ProviderRegistry extends ProviderLookup {
  getAllProviders(): Provider[];
  configureHttpClient?(httpClient: HttpClient): void;
}

export const defaultProviderRegistry: ProviderRegistry = {
  getProvider,
  getAllProviders,
  configureHttpClient: (httpClient) => {
    for (const provider of getAllProviders()) {
      if (provider instanceof ProviderBase) provider.setHttpClient(httpClient);
    }
  },
};

export interface RunManifestStore {
  create: typeof createRunManifest;
  mutate: typeof mutateRunManifest;
  upsertProviderReport: typeof upsertProviderReport;
  markFailed: typeof markRunFailed;
}

export const defaultRunManifestStore: RunManifestStore = {
  create: createRunManifest,
  mutate: mutateRunManifest,
  upsertProviderReport,
  markFailed: markRunFailed,
};

export type ResearchRunEvent =
  | { type: 'manifest-created'; manifest: RunManifest }
  | { type: 'dispatch-progress'; progress: ProgressEvent }
  | { type: 'post-dispatch-warning'; message: string }
  | { type: 'completed'; manifest: RunManifest }
  | { type: 'failed'; outputDir: string; error: Error };

export interface ResearchRunPostDispatchContext {
  query: string;
  config: Config;
  results: ProviderDispatchResult[];
  reports: ProviderReport[];
  sources: DeduplicatedSource[];
  outputDir: string;
}

export interface ResearchRunPostDispatchResult {
  manifestExtra?: Partial<Pick<RunManifest, 'answer' | 'verification'>>;
  answerText?: string;
}

export interface ExecuteResearchRunRequest {
  query: string;
  config: Config;
  providerIds: string[];
  outputDir: string;
  slug: string;
  credentials?: CredentialContext;
  tierQueries?: Partial<Record<Provider['tier'], string>>;
  budget?: BudgetTracker;
  estimatedBudget?: EstimateBudgetTracker;
  allowFallbacks?: boolean;
  onEvent?: (event: ResearchRunEvent) => void;
  postDispatch?: (
    context: ResearchRunPostDispatchContext,
  ) => Promise<ResearchRunPostDispatchResult | undefined>;
}

export interface ExecuteResearchRunDependencies {
  providerRegistry?: ProviderRegistry;
  taskStore?: RunManifestStore;
  httpClient?: HttpClient;
  dispatch?: (options: DispatchOptions) => Promise<DispatchResult>;
  now?: () => number;
}

export interface ResearchRunResult {
  manifest: RunManifest;
  reports: ProviderReport[];
  results: ProviderDispatchResult[];
  asyncTasks: DispatchResult['asyncTasks'];
  sources: DeduplicatedSource[];
  totalCitations: number;
  totalDurationMs: number;
}

/**
 * Execute the durable, presentation-free portion of a research run.
 *
 * Callers own configuration, provider selection, consent, and presentation.
 * This service owns the write-ahead manifest, dispatch, artifacts, lifecycle,
 * and structured events. All dependencies have production defaults and may be
 * overridden independently for embedding and tests.
 */
export async function executeResearchRun(
  request: ExecuteResearchRunRequest,
  dependencies: ExecuteResearchRunDependencies = {},
): Promise<ResearchRunResult> {
  const providerRegistry =
    dependencies.providerRegistry ?? defaultProviderRegistry;
  const taskStore = dependencies.taskStore ?? defaultRunManifestStore;
  const dispatchRun = dependencies.dispatch ?? dispatch;
  const now = dependencies.now ?? Date.now;
  const emit = (event: ResearchRunEvent): void => {
    try {
      request.onEvent?.(event);
    } catch {
      // Observers are presentation adapters and cannot compromise persistence.
    }
  };

  mkdirSync(request.outputDir, { recursive: true });
  let prompt = buildPrompt(request.query);
  if (request.tierQueries) {
    prompt += '\n\n## Refined Query Variants\n';
    for (const tier of [
      'deep-research',
      'ai-grounded',
      'raw-search',
      'llm',
    ] as const) {
      const variant = request.tierQueries[tier];
      if (variant) prompt += `\n- ${tier}: ${variant}`;
    }
    prompt += '\n';
  }
  safeWriteFile(join(request.outputDir, 'prompt.md'), prompt);

  const timestamp = Math.floor(now() / 1000);
  const created = taskStore.create(request.outputDir, {
    status: 'running',
    timestamp,
    slug: request.slug,
    query: request.query,
    mode: request.config.defaults.mode,
    outputDir: request.outputDir,
    providers: [],
    sources: { total: 0, unique: 0, file: 'sources.json' },
    exitCode: null,
    refinedQueries: request.tierQueries,
  });
  emit({ type: 'manifest-created', manifest: created });

  try {
    if (dependencies.httpClient) {
      if (providerRegistry.configureHttpClient) {
        providerRegistry.configureHttpClient(dependencies.httpClient);
      } else {
        for (const provider of providerRegistry.getAllProviders()) {
          if (provider instanceof ProviderBase) {
            provider.setHttpClient(dependencies.httpClient);
          }
        }
      }
    }

    const dispatchStartedAt = now();
    const { reports, results, asyncTasks } = await dispatchRun({
      config: request.config,
      providerIds: request.providerIds,
      query: request.query,
      tierQueries: request.tierQueries,
      mode: request.config.defaults.mode,
      credentials: request.credentials,
      budget: request.budget,
      estimatedBudget: request.estimatedBudget,
      allowFallbacks: request.allowFallbacks,
      providerRegistry,
      onProgress: (progress) => {
        if (progress.report) {
          taskStore.upsertProviderReport(
            request.outputDir,
            progress.report,
            progress.task,
          );
        }
        emit({ type: 'dispatch-progress', progress });
      },
    });
    const totalDurationMs = now() - dispatchStartedAt;

    writeProviderOutputs(request.outputDir, reports, results);
    const allCitations: Citation[] = results.flatMap((result) =>
      result.status === 'success' ? result.citations : [],
    );
    const sources = deduplicateSources(allCitations);
    safeWriteFile(
      join(request.outputDir, 'sources.json'),
      JSON.stringify(sources, null, 2),
    );

    let manifestExtra: ResearchRunPostDispatchResult['manifestExtra'] = {};
    if (request.postDispatch) {
      try {
        manifestExtra =
          (
            await request.postDispatch({
              query: request.query,
              config: request.config,
              results,
              reports,
              sources,
              outputDir: request.outputDir,
            })
          )?.manifestExtra ?? {};
      } catch (error) {
        emit({
          type: 'post-dispatch-warning',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const taskByProvider = new Map(
      asyncTasks.map((task) => [task.provider, toRunTaskState(task)]),
    );
    const manifest = taskStore.mutate(request.outputDir, (current) => {
      const persistedTasks = new Map(
        current.providers
          .filter((provider) => provider.task)
          .map((provider) => [provider.id, provider.task]),
      );
      current.providers = reports.map((report) => ({
        ...report,
        ...((report.task ??
        taskByProvider.get(report.id) ??
        persistedTasks.get(report.id))
          ? {
              task:
                report.task ??
                taskByProvider.get(report.id) ??
                persistedTasks.get(report.id),
            }
          : {}),
      }));
      current.sources = {
        total: allCitations.length,
        unique: sources.length,
        file: 'sources.json',
      };
      Object.assign(current, manifestExtra);
      applyRunLifecycle(current, now());
    });

    safeWriteFile(
      join(request.outputDir, 'summary.md'),
      generateSummary({
        query: request.query,
        reports,
        sources,
        asyncTasks,
        timestamp,
      }),
    );
    emit({ type: 'completed', manifest });

    return {
      manifest,
      reports,
      results,
      asyncTasks,
      sources,
      totalCitations: allCitations.length,
      totalDurationMs,
    };
  } catch (error) {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    try {
      taskStore.markFailed(request.outputDir, normalized.message, now());
    } catch {
      // Preserve the original orchestration failure.
    }
    emit({ type: 'failed', outputDir: request.outputDir, error: normalized });
    throw error;
  }
}

function writeProviderOutputs(
  outputDir: string,
  reports: ProviderReport[],
  results: ProviderDispatchResult[],
): void {
  for (const result of results) {
    const report = reports.find(
      (candidate) =>
        candidate.id === result.provider &&
        candidate.fallbackFor === result.fallbackFor,
    );
    if (!report?.outputFile || !report.metaFile) continue;

    safeWriteFile(join(outputDir, report.outputFile), result.text);
    safeWriteFile(
      join(outputDir, report.metaFile),
      JSON.stringify(
        {
          provider: result.provider,
          tier: result.tier,
          model: result.model,
          durationMs: result.durationMs,
          citationCount: result.citations.length,
          tokenUsage: result.tokenUsage,
          usage: result.usage,
          metering: result.metering,
          citations: result.citations,
        },
        null,
        2,
      ),
    );
  }
}
