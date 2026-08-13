/**
 * Read-only v3 reporting loader. Canonical run.json remains the only lifecycle
 * authority; this module never consults or trusts derived sidecars.
 */
import { basename, dirname, resolve } from 'node:path';
import { generateSummary } from './core/synthesis.js';
import {
  type CanonicalRunPresentation,
  projectCanonicalRunPresentation,
} from './node-canonical-presentation.js';
import type { CanonicalRunManifestV3 } from './node-canonical-run.js';
import {
  readCanonicalRunManifest,
  readRunJsonSchemaVersion,
} from './node-canonical-run.js';

export interface CanonicalRunReportingView {
  readonly runDir: string;
  readonly manifest: CanonicalRunManifestV3;
  readonly presentation: CanonicalRunPresentation;
  readonly summary: string;
}

/**
 * Read a v3 run into a one-way report view without mutating lifecycle state.
 * A non-v3 or invalid run intentionally returns null so callers can dispatch
 * to the historical reader rather than guessing a version.
 */
export function readCanonicalRunReportingView(
  runDirInput: string,
): CanonicalRunReportingView | null {
  const runDir = resolve(runDirInput);
  const runsRoot = dirname(runDir);
  try {
    if (readRunJsonSchemaVersion(runsRoot, runDir) !== 3) return null;
    const manifest = readCanonicalRunManifest(runsRoot, runDir);
    const presentation = projectCanonicalRunPresentation(
      manifest,
      runDir,
      basename(runDir),
    );
    return {
      runDir,
      manifest,
      presentation,
      summary: generateSummary({
        query: manifest.request.query,
        reports: presentation.reports,
        sources: presentation.sources,
        asyncTasks: [],
        timestamp: Math.floor(Date.parse(manifest.generated_at) / 1_000),
      }),
    };
  } catch {
    return null;
  }
}
