import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isRunManifest } from '../core/run-manifest.js';
import type { RunManifest } from '../types.js';

/**
 * Pure(ish) helpers for `librarium browse`: run manifest discovery and
 * parsing plus preview extraction. No interactive code here so everything
 * stays unit-testable.
 */

export interface RunEntry {
  dir: string;
  manifest: RunManifest;
}

export { isRunManifest } from '../core/run-manifest.js';

/** Parse a single run directory; returns null when there is no valid run.json. */
export function readRunEntry(dir: string): RunEntry | null {
  const manifestPath = join(dir, 'run.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    if (!isRunManifest(parsed)) return null;
    return { dir, manifest: parsed };
  } catch {
    return null;
  }
}

/**
 * Discover recent runs under the output base directory (newest first).
 */
export function discoverRuns(baseDir: string, limit = 20): RunEntry[] {
  if (!existsSync(baseDir)) return [];
  const entries: RunEntry[] = [];
  for (const name of readdirSync(baseDir)) {
    const dir = join(baseDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const entry = readRunEntry(dir);
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => b.manifest.timestamp - a.manifest.timestamp);
  return entries.slice(0, limit);
}

/** Format a manifest timestamp (seconds) as a local date-time label. */
export function formatRunDate(timestampSeconds: number): string {
  const date = new Date(timestampSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Per-status tallies for a run, e.g. "4 ok, 1 failed, 1 pending". */
export function runTallies(manifest: RunManifest): string {
  const ok = manifest.providers.filter((p) => p.status === 'success').length;
  const failed = manifest.providers.filter((p) => p.status === 'error').length;
  const pending = manifest.providers.filter(
    (p) => p.status === 'async-pending',
  ).length;
  const parts = [`${ok} ok`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (pending > 0) parts.push(`${pending} pending`);
  return parts.join(', ');
}

/** Selectable label and hint for a run entry. */
export function describeRun(entry: RunEntry): { label: string; hint: string } {
  const query =
    entry.manifest.query.length > 60
      ? `${entry.manifest.query.slice(0, 59)}…`
      : entry.manifest.query;
  return {
    label: `${formatRunDate(entry.manifest.timestamp)}  ${query}`,
    hint: runTallies(entry.manifest),
  };
}

/**
 * Extract the first lines of a provider's markdown output for the inline
 * preview. Leading blank lines are dropped; a trailing ellipsis line marks
 * truncated content.
 */
export function extractPreview(content: string, maxLines = 25): string[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && (lines[0] as string).trim() === '') {
    lines.shift();
  }
  while (lines.length > 0 && (lines.at(-1) as string).trim() === '') {
    lines.pop();
  }
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), '…'];
}
