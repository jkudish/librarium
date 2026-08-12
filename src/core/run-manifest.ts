import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  AsyncTaskHandle,
  AsyncTaskStatus,
  ProviderReport,
  RunManifest,
  RunStatus,
  RunTaskState,
} from '../types.js';
import { safeWriteFile } from './fs-utils.js';

export const RUN_MANIFEST_FILE = 'run.json';
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 20;
const WINDOWS_LOCK_TRANSIENT_RETRIES = 5;
const lockWaitArray = new Int32Array(new SharedArrayBuffer(4));

export class RunManifestError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message}: ${path}`);
    this.name = 'RunManifestError';
  }
}

export class RunManifestRevisionError extends RunManifestError {
  constructor(path: string, expected: number, actual: number) {
    super(
      `Run manifest revision conflict (expected ${expected}, found ${actual})`,
      path,
    );
    this.name = 'RunManifestRevisionError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTaskState(value: unknown): value is RunTaskState {
  if (!isRecord(value)) return false;
  return (
    typeof value.taskId === 'string' &&
    typeof value.submittedAt === 'number' &&
    ['pending', 'running', 'completed', 'failed', 'cancelled'].includes(
      String(value.status),
    )
  );
}

function isProviderReport(value: unknown): value is ProviderReport {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.tier === 'string' &&
    typeof value.status === 'string' &&
    typeof value.durationMs === 'number' &&
    typeof value.wordCount === 'number' &&
    typeof value.citationCount === 'number' &&
    typeof value.outputFile === 'string' &&
    typeof value.metaFile === 'string' &&
    (value.task === undefined || isTaskState(value.task))
  );
}

/** Strict v2 check. Legacy manifests are intentionally not accepted. */
export function isRunManifest(value: unknown): value is RunManifest {
  if (!isRecord(value)) return false;
  const statuses: RunStatus[] = [
    'running',
    'awaiting_async',
    'completed',
    'partial',
    'failed',
    'cancelled',
  ];
  return (
    value.schemaVersion === 2 &&
    Number.isInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    statuses.includes(value.status as RunStatus) &&
    typeof value.timestamp === 'number' &&
    typeof value.slug === 'string' &&
    typeof value.query === 'string' &&
    ['sync', 'async', 'mixed'].includes(String(value.mode)) &&
    typeof value.outputDir === 'string' &&
    Array.isArray(value.providers) &&
    value.providers.every(isProviderReport) &&
    isRecord(value.sources) &&
    typeof value.sources.total === 'number' &&
    typeof value.sources.unique === 'number' &&
    typeof value.sources.file === 'string' &&
    (value.exitCode === null || typeof value.exitCode === 'number')
  );
}

export function readRunManifest(outputDir: string): RunManifest {
  const path = join(outputDir, RUN_MANIFEST_FILE);
  if (!existsSync(path)) {
    throw new RunManifestError('Run manifest does not exist', path);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new RunManifestError(
      `Run manifest is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      path,
    );
  }
  if (!isRunManifest(parsed)) {
    throw new RunManifestError(
      'Run manifest is not a supported schemaVersion 2 manifest',
      path,
    );
  }
  return parsed;
}

export function tryReadRunManifest(outputDir: string): RunManifest | null {
  try {
    return readRunManifest(outputDir);
  } catch {
    return null;
  }
}

export function createRunManifest(
  outputDir: string,
  manifest: Omit<RunManifest, 'schemaVersion' | 'revision'>,
): RunManifest {
  const path = join(outputDir, RUN_MANIFEST_FILE);
  if (existsSync(path)) {
    throw new RunManifestError(
      'Refusing to overwrite an existing run manifest',
      path,
    );
  }
  const created: RunManifest = {
    schemaVersion: 2,
    revision: 0,
    ...manifest,
  };
  if (!isRunManifest(created)) {
    throw new RunManifestError(
      'Refusing to write an invalid run manifest',
      path,
    );
  }
  safeWriteFile(path, JSON.stringify(created, null, 2));
  return created;
}

/**
 * Atomically mutate the latest manifest. Callers holding a prior snapshot can
 * supply its revision to reject stale writes instead of silently losing data.
 */
export function mutateRunManifest(
  outputDir: string,
  mutate: (manifest: RunManifest) => void,
  expectedRevision?: number,
): RunManifest {
  const path = join(outputDir, RUN_MANIFEST_FILE);
  return withRunManifestLock(path, () => {
    const current = readRunManifest(outputDir);
    if (
      expectedRevision !== undefined &&
      current.revision !== expectedRevision
    ) {
      throw new RunManifestRevisionError(
        path,
        expectedRevision,
        current.revision,
      );
    }
    const next = structuredClone(current);
    mutate(next);
    next.revision = current.revision + 1;
    if (!isRunManifest(next)) {
      throw new RunManifestError(
        'Mutation produced an invalid run manifest',
        path,
      );
    }
    safeWriteFile(path, JSON.stringify(next, null, 2));
    return next;
  });
}

/**
 * Serialize atomic run.json mutations across processes.
 *
 * Canonical v3 persistence reuses this lock so schema versions cannot acquire
 * the same path through competing lock implementations.
 */
export function withRunManifestLock<T>(
  manifestPath: string,
  action: () => T,
): T {
  const lockPath = `${manifestPath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const token = randomUUID();
  let descriptor: number | undefined;
  let windowsTransientRetries = 0;
  while (descriptor === undefined) {
    try {
      const candidate = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(
          candidate,
          JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }),
        );
        descriptor = candidate;
      } catch (error) {
        closeSync(candidate);
        try {
          unlinkSync(lockPath);
        } catch {}
        throw error;
      }
    } catch (error) {
      const lockError = error as NodeJS.ErrnoException;
      const code = lockError.code;
      const windowsTransient =
        process.platform === 'win32' &&
        code === 'EPERM' &&
        lockError.syscall === 'open' &&
        windowsTransientRetries < WINDOWS_LOCK_TRANSIENT_RETRIES;
      if (code !== 'EEXIST' && !windowsTransient) throw error;
      if (windowsTransient) windowsTransientRetries += 1;
      if (Date.now() >= deadline) {
        throw new RunManifestError(
          'Timed out waiting for the run manifest mutation lock; if the recorded owner crashed, remove this lock file manually after confirming no Librarium process is using the run',
          manifestPath,
        );
      }
      Atomics.wait(lockWaitArray, 0, 0, LOCK_POLL_MS);
    }
  }
  try {
    return action();
  } finally {
    closeSync(descriptor);
    try {
      const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        token?: string;
      };
      if (owner.token === token) unlinkSync(lockPath);
    } catch {
      // A dead-owner recovery or manual cleanup may already have removed it.
    }
  }
}

function reportIdentity(report: ProviderReport): string {
  return `${report.id}\0${report.fallbackFor ?? ''}`;
}

export function replaceProviderReports(
  outputDir: string,
  reports: ProviderReport[],
): RunManifest {
  return mutateRunManifest(outputDir, (manifest) => {
    const tasks = new Map(
      manifest.providers
        .filter((provider) => provider.task)
        .map((provider) => [reportIdentity(provider), provider.task]),
    );
    manifest.providers = reports.map((report) => ({
      ...report,
      ...((report.task ?? tasks.get(reportIdentity(report)))
        ? { task: report.task ?? tasks.get(reportIdentity(report)) }
        : {}),
    }));
  });
}

export function upsertProviderReport(
  outputDir: string,
  report: ProviderReport,
  task?: AsyncTaskHandle,
): RunManifest {
  return mutateRunManifest(outputDir, (manifest) => {
    const key = reportIdentity(report);
    const index = manifest.providers.findIndex(
      (candidate) => reportIdentity(candidate) === key,
    );
    const persistedTask = task ? toRunTaskState(task) : undefined;
    const previousTask =
      index >= 0 ? manifest.providers[index]?.task : undefined;
    const next = {
      ...report,
      ...((report.task ?? persistedTask ?? previousTask)
        ? { task: report.task ?? persistedTask ?? previousTask }
        : {}),
    };
    if (index >= 0) manifest.providers[index] = next;
    else manifest.providers.push(next);
  });
}

export function toRunTaskState(task: AsyncTaskHandle): RunTaskState {
  return {
    taskId: task.taskId,
    submittedAt: task.submittedAt,
    status: task.status,
    ...(task.lastPolledAt !== undefined
      ? { lastPolledAt: task.lastPolledAt }
      : {}),
    ...(task.completedAt !== undefined
      ? { completedAt: task.completedAt }
      : {}),
    ...(task.providerStatus !== undefined
      ? { providerStatus: task.providerStatus }
      : {}),
    ...(task.lastPollError !== undefined
      ? { lastPollError: task.lastPollError }
      : {}),
  };
}

export function loadRunTasks(outputDir: string): AsyncTaskHandle[] {
  const manifest = readRunManifest(outputDir);
  return manifest.providers.flatMap((provider) => {
    if (!provider.task || provider.task.retrievedAt !== undefined) return [];
    return [
      {
        provider: provider.id,
        taskId: provider.task.taskId,
        query: manifest.query,
        submittedAt: provider.task.submittedAt,
        status: provider.task.status,
        outputDir,
        ...(provider.task.lastPolledAt !== undefined
          ? { lastPolledAt: provider.task.lastPolledAt }
          : {}),
        ...(provider.task.completedAt !== undefined
          ? { completedAt: provider.task.completedAt }
          : {}),
        ...(provider.task.providerStatus !== undefined
          ? { providerStatus: provider.task.providerStatus }
          : {}),
        ...(provider.task.lastPollError !== undefined
          ? { lastPollError: provider.task.lastPollError }
          : {}),
      },
    ];
  });
}

export function updateRunTask(
  outputDir: string,
  providerId: string,
  taskId: string,
  updates: Partial<RunTaskState>,
): AsyncTaskHandle | null {
  let found = false;
  mutateRunManifest(outputDir, (manifest) => {
    const provider = manifest.providers.find(
      (candidate) =>
        candidate.id === providerId && candidate.task?.taskId === taskId,
    );
    if (!provider?.task) return;
    provider.task = { ...provider.task, ...updates };
    if (
      provider.task.status === 'failed' ||
      provider.task.status === 'cancelled'
    ) {
      provider.status = 'error';
      provider.error =
        provider.task.lastPollError ??
        (provider.task.status === 'cancelled'
          ? 'Task was cancelled'
          : 'Task failed');
    }
    found = true;
    applyRunLifecycle(manifest);
  });
  if (!found) return null;
  return (
    loadRunTasks(outputDir).find(
      (task) => task.provider === providerId && task.taskId === taskId,
    ) ?? null
  );
}

export function markRunFailed(
  outputDir: string,
  error: string,
  now = Date.now(),
): RunManifest {
  return mutateRunManifest(outputDir, (manifest) => {
    manifest.error = error;
    const waiting = manifest.providers.some(
      (provider) =>
        provider.task !== undefined &&
        provider.task.retrievedAt === undefined &&
        ['pending', 'running', 'completed'].includes(provider.task.status),
    );
    if (waiting) {
      manifest.status = 'awaiting_async';
      manifest.exitCode = null;
      delete manifest.completedAt;
      return;
    }
    const succeeded = manifest.providers.some(
      (provider) => provider.status === 'success',
    );
    manifest.status = succeeded ? 'partial' : 'failed';
    manifest.exitCode = succeeded ? 1 : 2;
    manifest.completedAt = now;
  });
}

export function markTaskRetrieved(
  outputDir: string,
  providerId: string,
  taskId: string,
  report: ProviderReport,
  sources?: RunManifest['sources'],
  now = Date.now(),
): RunManifest {
  return mutateRunManifest(outputDir, (manifest) => {
    const index = manifest.providers.findIndex(
      (candidate) =>
        candidate.id === providerId && candidate.task?.taskId === taskId,
    );
    if (index < 0) {
      throw new Error(
        `Task ${providerId}/${taskId} is not recorded in run.json`,
      );
    }
    const task = manifest.providers[index]?.task;
    manifest.providers[index] = {
      ...report,
      ...(task
        ? {
            task: {
              ...task,
              status: 'completed',
              completedAt: task.completedAt ?? now,
              retrievedAt: now,
              lastPollError: undefined,
            },
          }
        : {}),
    };
    if (sources) manifest.sources = sources;
    applyRunLifecycle(manifest, now);
  });
}

export function applyRunLifecycle(
  manifest: RunManifest,
  now = Date.now(),
): void {
  const waiting = manifest.providers.some((provider) => {
    const task = provider.task;
    return (
      task !== undefined &&
      task.retrievedAt === undefined &&
      (task.status === 'pending' ||
        task.status === 'running' ||
        task.status === 'completed')
    );
  });
  if (waiting) {
    manifest.status = 'awaiting_async';
    manifest.exitCode = null;
    delete manifest.completedAt;
    return;
  }

  const recoveredPrimaries = new Set(
    manifest.providers
      .filter((report) => report.fallbackFor && report.status === 'success')
      .map((report) => report.fallbackFor as string),
  );
  const effective = manifest.providers.filter(
    (report) => !recoveredPrimaries.has(report.id),
  );
  const succeeded = effective.filter(
    (report) => report.status === 'success',
  ).length;
  const cancelled = effective.filter(
    (report) => report.task?.status === 'cancelled',
  ).length;
  const unsuccessful = effective.length - succeeded;

  if (effective.length > 0 && succeeded === effective.length) {
    manifest.status = 'completed';
    manifest.exitCode = 0;
  } else if (succeeded > 0 && unsuccessful > 0) {
    manifest.status = 'partial';
    manifest.exitCode = 1;
  } else if (effective.length > 0 && cancelled === effective.length) {
    manifest.status = 'cancelled';
    manifest.exitCode = 130;
  } else {
    manifest.status = 'failed';
    manifest.exitCode = 2;
  }
  manifest.completedAt = now;
}

export function discoverRunTasks(
  baseOutputDir: string,
  statuses?: ReadonlySet<AsyncTaskStatus>,
): AsyncTaskHandle[] {
  if (!existsSync(baseOutputDir)) return [];
  const tasks: AsyncTaskHandle[] = [];
  for (const entry of readdirSync(baseOutputDir)) {
    const dir = join(baseOutputDir, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
      for (const task of loadRunTasks(dir)) {
        if (!statuses || statuses.has(task.status)) tasks.push(task);
      }
    } catch {
      // Ignore directories without a valid schemaVersion 2 manifest.
    }
  }
  return tasks;
}
