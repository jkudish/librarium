import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRunLifecycle,
  createRunManifest,
  loadRunTasks,
  markTaskRetrieved,
  mutateRunManifest,
  RunManifestError,
  RunManifestRevisionError,
  readRunManifest,
  updateRunTask,
  upsertProviderReport,
} from '../src/core/run-manifest.js';
import type { ProviderReport } from '../src/types.js';

let dir: string;

const fsFault = vi.hoisted(() => ({
  code: undefined as string | undefined,
  remaining: 0,
  syscall: 'open',
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (
        fsFault.remaining > 0 &&
        args[1] === 'wx' &&
        String(args[0]).endsWith('run.json.lock')
      ) {
        fsFault.remaining -= 1;
        throw Object.assign(new Error(`injected ${fsFault.code}`), {
          code: fsFault.code,
          syscall: fsFault.syscall,
        });
      }
      return actual.openSync(...args);
    },
  };
});

const pendingReport: ProviderReport = {
  id: 'openai-research',
  tier: 'deep-research',
  status: 'async-pending',
  durationMs: 0,
  wordCount: 0,
  citationCount: 0,
  outputFile: '',
  metaFile: '',
};

beforeEach(() => {
  dir = join(tmpdir(), `librarium-manifest-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  fsFault.code = undefined;
  fsFault.remaining = 0;
  fsFault.syscall = 'open';
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function create(): void {
  createRunManifest(dir, {
    status: 'running',
    timestamp: 1,
    slug: 'query',
    query: 'query',
    mode: 'mixed',
    outputDir: dir,
    providers: [],
    sources: { total: 0, unique: 0, file: 'sources.json' },
    exitCode: null,
  });
}

describe('run manifest v2 store', () => {
  it('rejects legacy v1 artifacts', () => {
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ version: 1 }));
    expect(() => readRunManifest(dir)).toThrow(RunManifestError);
  });

  it('increments revisions and rejects stale compare-and-swap writes', () => {
    create();
    const updated = mutateRunManifest(
      dir,
      (manifest) => {
        manifest.query = 'updated';
      },
      0,
    );
    expect(updated.revision).toBe(1);
    expect(() => mutateRunManifest(dir, () => {}, 0)).toThrow(
      RunManifestRevisionError,
    );
  });

  it.each([1, 5])(
    'retries %i transient Windows lock permission errors',
    (failures) => {
      create();
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      fsFault.code = 'EPERM';
      fsFault.remaining = failures;

      expect(
        mutateRunManifest(dir, (manifest) => (manifest.query = 'updated')),
      ).toMatchObject({ revision: 1, query: 'updated' });
      expect(existsSync(join(dir, 'run.json.lock'))).toBe(false);
    },
  );

  it.each([
    ['darwin', 'EPERM', 'open', 1],
    ['win32', 'EPERM', 'write', 1],
    ['win32', 'EPERM', 'open', 6],
    ['win32', 'ENOENT', 'open', 1],
  ] as const)(
    'does not retry %s lock errors with code %s from %s after %i failures',
    (platform, code, syscall, failures) => {
      create();
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
      fsFault.code = code;
      fsFault.remaining = failures;
      fsFault.syscall = syscall;

      expect(() => mutateRunManifest(dir, () => {})).toThrow(
        `injected ${code}`,
      );
    },
  );

  it('serializes mutations across processes without losing revisions', async () => {
    create();
    const workers = 4;
    const iterations = 20;
    const fixture = join(
      process.cwd(),
      'tests/fixtures/mutate-run-manifest.ts',
    );
    const workerBundle = join(dir, 'mutation-worker.mjs');
    buildSync({
      entryPoints: [fixture],
      outfile: workerBundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22.12',
    });
    await Promise.all(
      Array.from(
        { length: workers },
        (_, index) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [workerBundle, dir, String(index), String(iterations)],
              { stdio: 'pipe' },
            );
            let stderr = '';
            child.stderr.on('data', (chunk) => {
              stderr += String(chunk);
            });
            child.on('error', reject);
            child.on('exit', (code) => {
              if (code === 0) resolve();
              else
                reject(new Error(`mutation worker exited ${code}: ${stderr}`));
            });
          }),
      ),
    );
    const manifest = readRunManifest(dir);
    expect(manifest.revision).toBe(workers * iterations);
    expect(manifest.query).toHaveLength('query'.length + workers * iterations);
  });

  it('persists a submitted task inside its provider before reconciliation', () => {
    create();
    upsertProviderReport(dir, pendingReport, {
      provider: 'openai-research',
      taskId: 'task-1',
      query: 'query',
      submittedAt: 10,
      status: 'pending',
    });
    const manifest = readRunManifest(dir);
    expect(manifest.providers[0]?.task).toEqual({
      taskId: 'task-1',
      submittedAt: 10,
      status: 'pending',
    });
    expect(loadRunTasks(dir)[0]).toMatchObject({
      provider: 'openai-research',
      query: 'query',
      outputDir: dir,
    });
  });

  it('uses provider plus task id as the task identity', () => {
    create();
    for (const provider of ['provider-a', 'provider-b']) {
      upsertProviderReport(
        dir,
        { ...pendingReport, id: provider },
        {
          provider,
          taskId: 'shared-native-id',
          query: 'query',
          submittedAt: 10,
          status: 'running',
        },
      );
    }
    updateRunTask(dir, 'provider-b', 'shared-native-id', {
      status: 'completed',
    });
    const manifest = readRunManifest(dir);
    expect(manifest.providers[0]?.task?.status).toBe('running');
    expect(manifest.providers[1]?.task?.status).toBe('completed');
  });

  it('reconciles terminal task state into the provider-facing report', () => {
    create();
    upsertProviderReport(dir, pendingReport, {
      provider: pendingReport.id,
      taskId: 'task-failed',
      query: 'query',
      submittedAt: 10,
      status: 'running',
    });
    updateRunTask(dir, pendingReport.id, 'task-failed', {
      status: 'failed',
      lastPollError: 'remote task failed',
    });
    const manifest = readRunManifest(dir);
    expect(manifest).toMatchObject({ status: 'failed', exitCode: 2 });
    expect(manifest.providers[0]).toMatchObject({
      status: 'error',
      error: 'remote task failed',
      task: { status: 'failed' },
    });
  });

  it('retains compact task audit data after retrieval', () => {
    create();
    upsertProviderReport(dir, pendingReport, {
      provider: 'openai-research',
      taskId: 'task-1',
      query: 'query',
      submittedAt: 10,
      status: 'completed',
    });
    markTaskRetrieved(
      dir,
      'openai-research',
      'task-1',
      {
        ...pendingReport,
        status: 'success',
        outputFile: 'openai-research.md',
        metaFile: 'openai-research.meta.json',
      },
      { total: 2, unique: 1, file: 'sources.json' },
      20,
    );
    const manifest = readRunManifest(dir);
    expect(manifest).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(manifest.providers[0]?.task).toEqual({
      taskId: 'task-1',
      submittedAt: 10,
      status: 'completed',
      completedAt: 20,
      retrievedAt: 20,
    });
    expect(loadRunTasks(dir)).toEqual([]);
  });

  it('derives awaiting, partial, failed, and cancelled run outcomes', () => {
    create();
    const manifest = readRunManifest(dir);
    manifest.providers = [
      {
        ...pendingReport,
        task: { taskId: 't', submittedAt: 1, status: 'running' },
      },
    ];
    applyRunLifecycle(manifest, 2);
    expect(manifest).toMatchObject({
      status: 'awaiting_async',
      exitCode: null,
    });

    manifest.providers = [
      { ...pendingReport, status: 'success' },
      { ...pendingReport, id: 'failed', status: 'error' },
    ];
    applyRunLifecycle(manifest, 3);
    expect(manifest).toMatchObject({ status: 'partial', exitCode: 1 });

    manifest.providers = [{ ...pendingReport, status: 'error' }];
    applyRunLifecycle(manifest, 4);
    expect(manifest).toMatchObject({ status: 'failed', exitCode: 2 });

    manifest.providers = [
      {
        ...pendingReport,
        task: { taskId: 't', submittedAt: 1, status: 'cancelled' },
      },
    ];
    applyRunLifecycle(manifest, 5);
    expect(manifest).toMatchObject({ status: 'cancelled', exitCode: 130 });
  });
});
