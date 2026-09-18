import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse, resolve, sep } from 'node:path';
import { RunArtifactRepository } from '../node-run-artifacts.js';

/**
 * Pure helpers for `librarium cleanup` / `librarium clear`: candidate
 * discovery, size computation, path-safety guards, and pending-async
 * detection. No interactive or filesystem-mutating code lives here so all
 * of it stays unit-testable.
 */

export interface CleanupCandidate {
  /** Absolute path to the run directory. */
  dir: string;
  /** Directory basename. */
  name: string;
  /** Run timestamp in ms (from dir name, falling back to mtime). */
  timeMs: number;
  /** Whole-day age relative to now. */
  ageDays: number;
  /** Total size on disk in bytes. */
  size: number;
  /** Query string when a run.json manifest was parseable, else null. */
  query: string | null;
  /** True when the run still has pending/running async tasks. */
  pendingAsync: boolean;
}

/**
 * Recursively sum the size in bytes of all files under a directory.
 */
export function getDirSize(dirPath: string): number {
  let size = 0;
  try {
    for (const entry of readdirSync(dirPath)) {
      const fullPath = join(dirPath, entry);
      try {
        const stat = lstatSync(fullPath);
        if (stat.isFile()) {
          size += stat.size;
        } else if (stat.isDirectory()) {
          size += getDirSize(fullPath);
        }
      } catch {
        // Skip unreadable entries.
      }
    }
  } catch {
    // Skip unreadable directory.
  }
  return size;
}

/** Human-readable byte size, e.g. "1.4 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Detect whether the authoritative run manifest has pending/running tasks.
 */
export function hasPendingAsync(
  dir: string,
  repository: RunArtifactRepository = new RunArtifactRepository(),
): boolean {
  const manifestPath = join(dir, 'run.json');
  if (!existsSync(manifestPath)) return false;
  const manifest = repository.tryReadManifest(dir);
  // A corrupt, unreadable, or unsupported authoritative manifest may contain
  // the only remote handle, so never infer terminal state from recovered files.
  if (!manifest) return true;
  return (
    manifest.status === 'awaiting_async' ||
    manifest.providers.some(
      (provider) =>
        provider.task !== undefined &&
        provider.task.retrievedAt === undefined &&
        ['pending', 'running', 'completed'].includes(provider.task.status),
    )
  );
}

function readQuery(
  dir: string,
  repository: RunArtifactRepository,
): string | null {
  return repository.tryReadManifest(dir)?.query ?? null;
}

export interface DiscoverOptions {
  /** When true, every run directory is a candidate regardless of age. */
  all?: boolean;
  /** Age threshold in days; only used when `all` is false. */
  days?: number;
  /** Clock injection for deterministic tests. */
  now?: number;
}

/**
 * Discover run directories under the resolved base dir. With `all`, every
 * directory qualifies; otherwise only directories older than `days`.
 * Sorted newest first.
 */
export function discoverCandidates(
  baseDir: string,
  opts: DiscoverOptions = {},
  repository: RunArtifactRepository = new RunArtifactRepository(),
): CleanupCandidate[] {
  if (!existsSync(baseDir)) return [];
  try {
    const baseStat = lstatSync(baseDir);
    if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) return [];
  } catch {
    return [];
  }
  const now = opts.now ?? Date.now();
  const all = opts.all ?? false;
  const days = opts.days ?? 30;
  const cutoffMs = now - days * 24 * 60 * 60 * 1000;

  const candidates: CleanupCandidate[] = [];
  for (const name of readdirSync(baseDir)) {
    const dir = join(baseDir, name);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    // Run dirs are named "{unix-seconds}-{slug}".
    const match = name.match(/^(\d+)-/);
    const timeMs = match ? Number.parseInt(match[1], 10) * 1000 : stat.mtimeMs;

    if (!all && timeMs >= cutoffMs) continue;

    candidates.push({
      dir,
      name,
      timeMs,
      ageDays: Math.floor((now - timeMs) / (24 * 60 * 60 * 1000)),
      size: getDirSize(dir),
      query: readQuery(dir, repository),
      pendingAsync: hasPendingAsync(dir, repository),
    });
  }

  candidates.sort((a, b) => b.timeMs - a.timeMs);
  return candidates;
}

/** Summary stats for a set of candidates (count, total size, age range). */
export interface CandidateSummary {
  count: number;
  totalSize: number;
  oldest: CleanupCandidate | null;
  newest: CleanupCandidate | null;
  pendingAsyncCount: number;
}

export function summarizeCandidates(
  candidates: CleanupCandidate[],
): CandidateSummary {
  if (candidates.length === 0) {
    return {
      count: 0,
      totalSize: 0,
      oldest: null,
      newest: null,
      pendingAsyncCount: 0,
    };
  }
  let totalSize = 0;
  let oldest = candidates[0];
  let newest = candidates[0];
  let pendingAsyncCount = 0;
  for (const c of candidates) {
    totalSize += c.size;
    if (c.timeMs < oldest.timeMs) oldest = c;
    if (c.timeMs > newest.timeMs) newest = c;
    if (c.pendingAsync) pendingAsyncCount += 1;
  }
  return {
    count: candidates.length,
    totalSize,
    oldest,
    newest,
    pendingAsyncCount,
  };
}

/**
 * Refuse to operate when the resolved base dir is the user's home directory
 * or a filesystem root. Returns a reason string when unsafe, else null.
 */
export function unsafeBaseDirReason(baseDir: string): string | null {
  const resolved = resolve(baseDir);
  const root = parse(resolved).root;
  // Normalize away a trailing separator before comparing.
  const normalized =
    resolved.length > root.length && resolved.endsWith(sep)
      ? resolved.slice(0, -sep.length)
      : resolved;

  if (normalized === root) {
    return `Refusing to operate on a filesystem root (${resolved}).`;
  }
  if (normalized === resolve(homedir())) {
    return `Refusing to operate on the home directory (${resolved}).`;
  }
  try {
    if (lstatSync(resolved).isSymbolicLink()) {
      return `Refusing to operate through a symbolic-link base directory (${resolved}).`;
    }
  } catch {
    // A missing output directory has nothing to clean.
  }
  return null;
}

/**
 * Verify a candidate path is strictly inside the resolved base dir. Guards
 * against traversal (e.g. "../../etc") and symlink-style escapes by string
 * containment after resolution. Returns true only when `candidate` is a
 * proper descendant of `baseDir`.
 */
export function isInsideBaseDir(baseDir: string, candidate: string): boolean {
  const base = resolve(baseDir);
  const target = resolve(candidate);
  if (target === base) return false; // never delete the base dir itself
  const prefix = base.endsWith(sep) ? base : base + sep;
  if (!target.startsWith(prefix)) return false;

  try {
    const baseStat = lstatSync(base);
    if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) return false;
    const targetStat = lstatSync(target);
    if (targetStat.isSymbolicLink()) return false;
    const realBase = realpathSync(base);
    const realTarget = realpathSync(target);
    const realPrefix = realBase.endsWith(sep) ? realBase : realBase + sep;
    return realTarget !== realBase && realTarget.startsWith(realPrefix);
  } catch {
    // Preserve the pure lexical predicate for a not-yet-created descendant.
    // Deletion candidates exist and therefore always take the realpath branch.
    return true;
  }
}
