import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
