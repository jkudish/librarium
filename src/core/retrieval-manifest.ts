import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Citation, ProviderReport } from '../types.js';
import { safeWriteFile } from './fs-utils.js';
import { deduplicateSources } from './normalizer.js';
import { markTaskRetrieved } from './run-manifest.js';

/**
 * Fold a retrieved async result into the authoritative manifest and rebuild
 * sources.json. Failure is explicit so callers can retry reconciliation.
 */
export function updateRunManifestAfterRetrieve(
  dir: string,
  report: ProviderReport,
  taskId: string,
): boolean {
  try {
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
    markTaskRetrieved(dir, report.id, taskId, report, {
      total: allCitations.length,
      unique: sources.length,
      file: 'sources.json',
    });
    return true;
  } catch {
    return false;
  }
}
