import {
  createRunManifest,
  mutateRunManifest,
  toRunTaskState,
  tryReadRunManifest,
} from '../../src/core/run-manifest.js';
import type { AsyncTaskHandle, ProviderReport } from '../../src/types.js';

/** Seed schema-v2 run artifacts for compatibility-reader tests. */
export function seedHistoricalV2AsyncTasks(
  outputDir: string,
  tasks: AsyncTaskHandle[],
): void {
  const providers: ProviderReport[] = tasks.map((task) => ({
    id: task.provider,
    tier: 'deep-research',
    status: 'async-pending',
    durationMs: 0,
    wordCount: 0,
    citationCount: 0,
    outputFile: '',
    metaFile: '',
    task: toRunTaskState(task),
  }));
  if (!tryReadRunManifest(outputDir)) {
    createRunManifest(outputDir, {
      status: 'awaiting_async',
      timestamp: Math.floor(Date.now() / 1000),
      slug: 'historical-async-run',
      query: tasks[0]?.query ?? '',
      mode: 'async',
      outputDir,
      providers,
      sources: { total: 0, unique: 0, file: 'sources.json' },
      exitCode: null,
    });
    return;
  }
  mutateRunManifest(outputDir, (manifest) => {
    manifest.providers = providers;
    manifest.status = 'awaiting_async';
    manifest.exitCode = null;
  });
}
