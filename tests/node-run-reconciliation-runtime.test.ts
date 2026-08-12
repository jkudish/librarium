import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerProvider } from '../src/adapters/index.js';
import { writeHtmlReportFromSnapshot } from '../src/commands/html-report-v2.js';
import { writeJsonlReportFromSnapshot } from '../src/commands/jsonl-report-v2.js';
import { createRunManifest } from '../src/core/run-manifest.js';
import {
  providerArtifactFileNames,
  RunArtifactRepository,
} from '../src/node-run-artifacts.js';
import { createNodeRunReconciliationRuntime } from '../src/node-run-reconciliation-runtime.js';
import {
  ConfigSchema,
  type Provider,
  type ProviderReport,
} from '../src/types.js';

const runs: string[] = [];

function pending(
  id: string,
  taskId: string,
  taskStatus: 'pending' | 'completed',
): ProviderReport {
  return {
    id,
    tier: 'deep-research',
    status: 'async-pending',
    durationMs: 0,
    wordCount: 0,
    citationCount: 0,
    outputFile: '',
    metaFile: '',
    task: { taskId, submittedAt: 1, status: taskStatus },
  };
}

function backgroundProvider(
  id: string,
  pollStatus: 'pending' | 'completed',
  content: string,
): Provider {
  const result = {
    provider: id,
    tier: 'deep-research' as const,
    content,
    citations: [
      { provider: id, url: `https://${id}.test/source`, title: `${id} source` },
    ],
    durationMs: 9,
  };
  return {
    id,
    displayName: id,
    tier: 'deep-research',
    execution: 'background',
    envVar: '',
    execute: async () => result,
    submit: async (query) => ({
      provider: id,
      taskId: `submitted-${id}`,
      query,
      submittedAt: 1,
      status: 'pending',
    }),
    poll: async () => ({ status: pollStatus }),
    retrieve: async () => result,
  };
}

afterEach(() => {
  for (const runDir of runs.splice(0)) {
    rmSync(runDir, { recursive: true, force: true });
  }
});

describe('Node reconciliation runtime presentation regeneration', () => {
  it('matches direct recovery reports while keeping summary and lifecycle authoritative', async () => {
    const recoveredId = 'runtime-recovery-pending';
    const retrievedId = 'runtime-retrieved';
    const recoveredContent = '# Recovered provider\nlegacy on-disk result';
    const retrievedContent = '# Retrieved provider\nnew committed result';
    registerProvider(
      backgroundProvider(recoveredId, 'pending', recoveredContent),
    );
    registerProvider(
      backgroundProvider(retrievedId, 'completed', retrievedContent),
    );

    const runDir = mkdtempSync(join(tmpdir(), 'librarium-runtime-regen-'));
    runs.push(runDir);
    createRunManifest(runDir, {
      status: 'awaiting_async',
      timestamp: 1,
      slug: 'runtime-regeneration',
      query: 'runtime regeneration query',
      mode: 'async',
      outputDir: '/untrusted/output',
      providers: [
        pending(recoveredId, 'recover-task', 'pending'),
        pending(retrievedId, 'retrieve-task', 'completed'),
      ],
      sources: { total: 0, unique: 0, file: 'sources.json' },
      exitCode: null,
    });
    writeFileSync(join(runDir, `${recoveredId}.md`), recoveredContent);
    writeFileSync(
      join(runDir, `${recoveredId}.meta.json`),
      JSON.stringify({
        provider: recoveredId,
        durationMs: 7,
        citationCount: 1,
        citations: [
          {
            provider: recoveredId,
            url: `https://${recoveredId}.test/source`,
          },
        ],
      }),
    );
    writeFileSync(join(runDir, 'summary.md'), 'stale summary');
    writeFileSync(join(runDir, 'report.html'), 'stale html');
    writeFileSync(join(runDir, 'results.jsonl'), 'stale jsonl');

    const config = ConfigSchema.parse({
      version: 1,
      defaults: {},
      providers: {
        [recoveredId]: { enabled: true },
        [retrievedId]: { enabled: true },
      },
    });
    const repository = new RunArtifactRepository();
    const runtime = createNodeRunReconciliationRuntime(config, repository);

    const result = await runtime.service.reconcileOnce(runDir, {
      retrieve: true,
    });

    expect(result).toMatchObject({ retrieved: 1, regenerated: true });
    const authoritative = repository.readManifest(runDir);
    expect(authoritative).toMatchObject({
      status: 'awaiting_async',
      exitCode: null,
      providers: [
        { id: recoveredId, status: 'async-pending' },
        { id: retrievedId, status: 'success' },
      ],
    });
    expect(authoritative.providers[1]).toMatchObject(
      providerArtifactFileNames(retrievedId),
    );
    const summary = readFileSync(join(runDir, 'summary.md'), 'utf8');
    expect(summary).toContain(`### ${recoveredId} [PENDING]`);
    expect(summary).toContain(`### ${retrievedId} [OK]`);

    const regeneratedHtml = readFileSync(join(runDir, 'report.html'), 'utf8');
    const regeneratedJsonl = readFileSync(
      join(runDir, 'results.jsonl'),
      'utf8',
    );
    expect(regeneratedHtml).toContain('2 succeeded, 0 failed, 0 async pending');
    expect(regeneratedHtml).toContain('<h1>Recovered provider</h1>');
    expect(regeneratedHtml).toContain('legacy on-disk result');
    expect(regeneratedHtml).toContain('<h1>Retrieved provider</h1>');
    expect(regeneratedHtml).toContain('new committed result');
    expect(
      regeneratedJsonl
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string; status?: string })
        .filter((line) => line.type === 'result')
        .map((line) => line.status),
    ).toEqual(['success', 'success']);

    const manifestBeforeDirectReports = readFileSync(
      join(runDir, 'run.json'),
      'utf8',
    );
    const recovery = repository.readSnapshot(runDir, { view: 'recovery' });
    writeHtmlReportFromSnapshot(recovery, repository);
    writeJsonlReportFromSnapshot(recovery, repository);

    expect(readFileSync(join(runDir, 'report.html'), 'utf8')).toBe(
      regeneratedHtml,
    );
    expect(readFileSync(join(runDir, 'results.jsonl'), 'utf8')).toBe(
      regeneratedJsonl,
    );
    expect(readFileSync(join(runDir, 'run.json'), 'utf8')).toBe(
      manifestBeforeDirectReports,
    );
  });
});
