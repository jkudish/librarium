import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Citation, ProviderReport, RunManifest } from '../types.js';
import { safeWriteFile } from './fs-utils.js';
import { deduplicateSources } from './normalizer.js';

/**
 * Fold a retrieved async result into both manifest views. Failure is explicit
 * so callers can retain the task handle for a repair/retry instead of leaving
 * run.json and async-tasks.json contradictory.
 */
export function updateRunManifestAfterRetrieve(
  dir: string,
  report: ProviderReport,
  taskId: string,
): boolean {
  const manifestPath = join(dir, 'run.json');
  if (!existsSync(manifestPath)) return true;

  try {
    const manifest = JSON.parse(
      readFileSync(manifestPath, 'utf8'),
    ) as RunManifest;
    const index = manifest.providers.findIndex(
      (provider) =>
        provider.id === report.id && provider.status === 'async-pending',
    );
    if (index >= 0) manifest.providers[index] = report;
    manifest.asyncTasks = Array.isArray(manifest.asyncTasks)
      ? manifest.asyncTasks.filter((task) => task.taskId !== taskId)
      : [];

    const allCitations: Citation[] = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.meta.json')) continue;
      try {
        const meta = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as {
          citations?: Citation[];
        };
        if (Array.isArray(meta.citations)) allCitations.push(...meta.citations);
      } catch {}
    }
    const sources = deduplicateSources(allCitations);
    safeWriteFile(join(dir, 'sources.json'), JSON.stringify(sources, null, 2));
    manifest.sources = {
      total: allCitations.length,
      unique: sources.length,
      file: 'sources.json',
    };
    safeWriteFile(manifestPath, JSON.stringify(manifest, null, 2));
    return true;
  } catch {
    return false;
  }
}
