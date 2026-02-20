import { join } from 'node:path';
import pLimit from 'p-limit';
import { getProvider } from '../adapters/index.js';
import { sanitizeId } from '../constants.js';
import type {
  AsyncTaskHandle,
  Config,
  ProgressEvent,
  ProviderReport,
} from '../types.js';
import { safeWriteFile } from './fs-utils.js';

export interface DispatchOptions {
  config: Config;
  providerIds: string[];
  query: string;
  outputDir: string;
  mode: 'sync' | 'async' | 'mixed';
  onProgress?: (event: ProgressEvent) => void;
}

export interface DispatchResult {
  reports: ProviderReport[];
  asyncTasks: AsyncTaskHandle[];
}

export async function dispatch(
  options: DispatchOptions,
): Promise<DispatchResult> {
  const { config, providerIds, query, outputDir, mode, onProgress } = options;
  const limit = pLimit(config.defaults.maxParallel);
  const reports: ProviderReport[] = [];
  const asyncTasks: AsyncTaskHandle[] = [];

  const tasks = providerIds.map((id) =>
    limit(async (): Promise<void> => {
      const provider = getProvider(id);
      if (!provider) {
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
          const handle = await provider.submit(query, {
            timeout: config.defaults.asyncTimeout,
          });
          handle.outputDir = outputDir;

          // If submit already completed (e.g. Gemini/Perplexity wrap execute),
          // retrieve immediately and treat as sync result
          if (
            (handle.status === 'completed' || handle.status === 'failed') &&
            provider.retrieve
          ) {
            const result = await provider.retrieve(handle);
            const safeId = sanitizeId(id);
            const outputFile = `${safeId}.md`;
            const metaFile = `${safeId}.meta.json`;

            safeWriteFile(join(outputDir, outputFile), result.content);
            safeWriteFile(
              join(outputDir, metaFile),
              JSON.stringify(
                {
                  provider: result.provider,
                  tier: result.tier,
                  model: result.model,
                  durationMs: result.durationMs,
                  citationCount: result.citations.length,
                  tokenUsage: result.tokenUsage,
                  citations: result.citations,
                },
                null,
                2,
              ),
            );

            const report: ProviderReport = {
              id,
              tier: provider.tier,
              status: result.error ? 'error' : 'success',
              durationMs: result.durationMs,
              wordCount: result.content.split(/\s+/).filter(Boolean).length,
              citationCount: result.citations.length,
              outputFile,
              metaFile,
              error: result.error,
            };
            reports.push(report);
            onProgress?.({ providerId: id, event: 'completed', report });
            return;
          }

          // Truly async — add to pending queue
          asyncTasks.push(handle);
          reports.push({
            id,
            tier: provider.tier,
            status: 'async-pending',
            durationMs: 0,
            wordCount: 0,
            citationCount: 0,
            outputFile: '',
            metaFile: '',
          });
          onProgress?.({ providerId: id, event: 'async-submitted' });
          return;
        } catch {
          // Fall through to sync execution
        }
      }

      // Sync execution
      try {
        const result = await provider.execute(query, {
          timeout: config.defaults.timeout,
        });

        const safeId = sanitizeId(id);
        const outputFile = `${safeId}.md`;
        const metaFile = `${safeId}.meta.json`;

        // Write provider output
        safeWriteFile(join(outputDir, outputFile), result.content);
        safeWriteFile(
          join(outputDir, metaFile),
          JSON.stringify(
            {
              provider: result.provider,
              tier: result.tier,
              model: result.model,
              durationMs: result.durationMs,
              citationCount: result.citations.length,
              tokenUsage: result.tokenUsage,
              citations: result.citations,
            },
            null,
            2,
          ),
        );

        const report: ProviderReport = {
          id,
          tier: provider.tier,
          status: result.error ? 'error' : 'success',
          durationMs: result.durationMs,
          wordCount: result.content.split(/\s+/).filter(Boolean).length,
          citationCount: result.citations.length,
          outputFile,
          metaFile,
          error: result.error,
        };

        reports.push(report);
        onProgress?.({ providerId: id, event: 'completed', report });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        reports.push({
          id,
          tier: provider.tier,
          status: 'error',
          durationMs: 0,
          wordCount: 0,
          citationCount: 0,
          outputFile: '',
          metaFile: '',
          error,
        });
        onProgress?.({ providerId: id, event: 'error' });
      }
    }),
  );

  await Promise.allSettled(tasks);
  return { reports, asyncTasks };
}
