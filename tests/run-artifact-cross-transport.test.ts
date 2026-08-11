import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shapeBrowseRunSnapshot } from '../src/commands/browse-data.js';
import { writeHtmlReportFromSnapshot } from '../src/commands/html-report.js';
import { writeJsonlReportFromSnapshot } from '../src/commands/jsonl-report.js';
import {
  CONTENT_DELIMITER_BEGIN,
  CONTENT_DELIMITER_END,
  shapeRunResultsSnapshot,
} from '../src/mcp/shaping.js';
import { projectRunArtifactSnapshot } from '../src/node-run-artifact-presentation.js';
import { RunArtifactRepository } from '../src/node-run-artifacts.js';
import {
  type DerivedArtifactRegeneratorInput,
  type ReconciliationBackgroundProvider,
  RunReconciliationService,
} from '../src/node-run-reconciliation.js';
import type { ProviderReport, RunManifest } from '../src/types.js';

const fixtureDir = fileURLToPath(
  new URL('./fixtures/v1/artifacts/', import.meta.url),
);
const temporaryRuns: string[] = [];

function readFixture(name: string): { raw: string; manifest: RunManifest } {
  const raw = readFileSync(join(fixtureDir, name), 'utf8');
  return { raw, manifest: JSON.parse(raw) as RunManifest };
}

function makeRun(manifest: RunManifest): string {
  const runDir = mkdtempSync(join(tmpdir(), 'librarium-cross-transport-'));
  temporaryRuns.push(runDir);
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(manifest, null, 2));
  return runDir;
}

function normalizedDurableFacts(manifest: Readonly<RunManifest>): unknown {
  return {
    schemaVersion: manifest.schemaVersion,
    status: manifest.status,
    query: manifest.query,
    mode: manifest.mode,
    providers: manifest.providers.map((report) => ({
      id: report.id,
      tier: report.tier,
      status: report.status,
      durationMs: report.durationMs,
      wordCount: report.wordCount,
      citationCount: report.citationCount,
      outputFile: report.outputFile ? '<provider-output>' : '',
      metaFile: report.metaFile ? '<provider-meta>' : '',
      task: report.task
        ? {
            taskId: report.task.taskId,
            status: report.task.status,
            providerStatus: report.task.providerStatus,
            submittedAt: '<timestamp>',
            ...(report.task.lastPolledAt === undefined
              ? {}
              : { lastPolledAt: '<timestamp>' }),
            ...(report.task.completedAt === undefined
              ? {}
              : { completedAt: '<timestamp>' }),
            ...(report.task.retrievedAt === undefined
              ? {}
              : { retrievedAt: '<timestamp>' }),
          }
        : undefined,
    })),
    sources: manifest.sources,
    exitCode: manifest.exitCode,
  };
}

function providerFacts(
  report: Readonly<ProviderReport>,
  content: string,
  sources: { readonly total: number; readonly unique: number },
): unknown {
  return {
    id: report.id,
    tier: report.tier,
    status: report.status,
    durationMs: report.durationMs,
    wordCount: report.wordCount,
    citationCount: report.citationCount,
    content,
    sources,
  };
}

afterEach(() => {
  for (const runDir of temporaryRuns.splice(0)) {
    rmSync(runDir, { recursive: true, force: true });
  }
});

describe('run artifact cross-transport projection', () => {
  it('keeps reconciliation and every presentation transport on one durable result', async () => {
    const pendingFixture = readFixture('background-pending-run.json');
    const retrievedFixture = readFixture('background-retrieved-run.json');
    const runDir = makeRun(pendingFixture.manifest);
    writeFileSync(join(runDir, 'summary.md'), 'stale summary');
    writeFileSync(join(runDir, 'report.html'), 'stale html');

    const providerId = pendingFixture.manifest.providers[0]?.id;
    expect(providerId).toBe('perplexity-sonar-deep');
    const content = Array.from(
      { length: 42 },
      (_, index) => `retrieved-word-${index + 1}`,
    ).join(' ');
    expect(content.split(/\s+/)).toHaveLength(42);
    const citations = [
      {
        provider: providerId as string,
        url: 'https://example.test/first',
        title: 'First source',
      },
      {
        provider: providerId as string,
        url: 'https://example.test/second',
        title: 'Second source',
      },
    ];
    const backgroundProvider: ReconciliationBackgroundProvider = {
      execution: 'background',
      poll: async () => ({ status: 'completed', rawStatus: 'COMPLETED' }),
      retrieve: async () => ({
        provider: providerId as string,
        tier: 'deep-research',
        content,
        citations,
        durationMs: 0,
      }),
    };
    const repository = new RunArtifactRepository();
    const commit = vi.spyOn(repository, 'commitRetrieved');
    const regeneration = vi.fn(
      async (input: DerivedArtifactRegeneratorInput) => {
        if (input.refreshSummary) {
          repository.writeSummary(input.runDir, '# refreshed summary');
        }
        if (input.refreshHtml) {
          writeHtmlReportFromSnapshot(input.snapshot, repository);
        }
        if (input.refreshJsonl) {
          writeJsonlReportFromSnapshot(input.snapshot, repository);
        }
      },
    );
    const times = [1_700_000_001_000, 1_700_000_003_000];
    const service = new RunReconciliationService({
      repository,
      resolveBackgroundProvider: (id) =>
        id === providerId ? backgroundProvider : undefined,
      getProviderConfig: () => undefined,
      now: () => times.shift() ?? 1_700_000_003_000,
      regenerateDerivedArtifacts: regeneration,
    });

    const first = await service.reconcileOnce(runDir, { retrieve: true });
    const repeated = await service.reconcileOnce(runDir, { retrieve: true });

    expect(first).toMatchObject({ retrieved: 1, regenerated: true });
    expect(repeated).toMatchObject({ retrieved: 0, regenerated: false });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.results[0]?.value).toMatchObject({ committed: true });
    expect(regeneration).toHaveBeenCalledTimes(1);
    expect(regeneration.mock.calls[0]?.[0]).toMatchObject({
      refreshSummary: true,
      refreshHtml: true,
      refreshJsonl: false,
    });
    expect(readFileSync(join(runDir, 'summary.md'), 'utf8')).toBe(
      '# refreshed summary',
    );
    expect(readFileSync(join(runDir, 'report.html'), 'utf8')).toContain(
      content,
    );
    expect(existsSync(join(runDir, 'results.jsonl'))).toBe(false);

    const durableBeforePresentation = readFileSync(
      join(runDir, 'run.json'),
      'utf8',
    );
    const snapshot = repository.readSnapshot(runDir, { view: 'recovery' });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(normalizedDurableFacts(snapshot.manifest)).toEqual(
      normalizedDurableFacts(retrievedFixture.manifest),
    );

    const report = snapshot.reports[0];
    expect(report).toBeDefined();
    const artifact = snapshot.providerArtifacts[providerId as string];
    expect(artifact?.content).toBe(content);
    const expectedFacts = providerFacts(
      report as Readonly<ProviderReport>,
      content,
      { total: 2, unique: 2 },
    );

    const browse = shapeBrowseRunSnapshot(snapshot);
    const browseProvider = browse.providers[0];
    expect(
      providerFacts(
        browseProvider?.report as Readonly<ProviderReport>,
        browseProvider?.content ?? '',
        browse.sources,
      ),
    ).toEqual(expectedFacts);

    const mcp = shapeRunResultsSnapshot(snapshot);
    const mcpProvider = mcp.summary.providers[0];
    const mcpResult = mcp.results[0];
    expect(mcpResult?.content.startsWith(CONTENT_DELIMITER_BEGIN)).toBe(true);
    expect(mcpResult?.content.endsWith(CONTENT_DELIMITER_END)).toBe(true);
    const unwrappedMcpContent = mcpResult?.content
      .slice(CONTENT_DELIMITER_BEGIN.length, -CONTENT_DELIMITER_END.length)
      .trim();
    expect(
      providerFacts(
        mcpProvider as Readonly<ProviderReport>,
        unwrappedMcpContent ?? '',
        mcp.summary.sources,
      ),
    ).toEqual(expectedFacts);

    const htmlPath = writeHtmlReportFromSnapshot(snapshot, repository);
    const html = readFileSync(htmlPath, 'utf8');
    expect(html).toContain('1 succeeded, 0 failed, 0 async pending');
    expect(html).toContain('2 unique sources after dedupe (2 total citations)');
    expect(html).toContain(content);

    const jsonlPath = writeJsonlReportFromSnapshot(snapshot, repository);
    const jsonl = readFileSync(jsonlPath, 'utf8')
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const runLine = jsonl.find((line) => line.type === 'run');
    const resultLine = jsonl.find((line) => line.type === 'result');
    expect(runLine).toMatchObject({
      succeeded: 1,
      failed: 0,
      pending: 0,
      uniqueSources: 2,
      totalCitations: 2,
    });
    expect(resultLine).toMatchObject({
      id: providerId,
      tier: 'deep-research',
      status: 'success',
      durationMs: 0,
      citationCount: 2,
      content,
    });

    expect(readFileSync(join(runDir, 'run.json'), 'utf8')).toBe(
      durableBeforePresentation,
    );
    expect(
      readFileSync(join(fixtureDir, 'background-pending-run.json'), 'utf8'),
    ).toBe(pendingFixture.raw);
    expect(
      readFileSync(join(fixtureDir, 'background-retrieved-run.json'), 'utf8'),
    ).toBe(retrievedFixture.raw);
  });

  it('preserves an own provider content entry named __proto__', () => {
    const fixture = readFixture('background-retrieved-run.json');
    const manifest = structuredClone(fixture.manifest);
    const report = manifest.providers[0];
    expect(report).toBeDefined();
    if (!report) return;
    report.outputFile = '__proto__';
    report.metaFile = '';
    const runDir = makeRun(manifest);
    writeFileSync(join(runDir, '__proto__'), 'prototype-safe content');
    const snapshot = new RunArtifactRepository().readSnapshot(runDir, {
      view: 'recovery',
    });

    const presentation = projectRunArtifactSnapshot(snapshot);

    expect(Object.hasOwn(presentation.providerContents, '__proto__')).toBe(
      true,
    );
    expect(
      Object.getOwnPropertyDescriptor(
        presentation.providerContents,
        '__proto__',
      )?.value,
    ).toBe('prototype-safe content');
    expect(Object.getPrototypeOf(presentation.providerContents)).toBe(
      Object.prototype,
    );
  });

  it('does not inherit content for a missing constructor artifact', () => {
    const fixture = readFixture('background-retrieved-run.json');
    const manifest = structuredClone(fixture.manifest);
    const report = manifest.providers[0];
    expect(report).toBeDefined();
    if (!report) return;
    report.outputFile = 'constructor';
    report.metaFile = '';
    const runDir = makeRun(manifest);
    const repository = new RunArtifactRepository();
    const snapshot = repository.readSnapshot(runDir, { view: 'recovery' });

    const html = readFileSync(
      writeHtmlReportFromSnapshot(snapshot, repository),
      'utf8',
    );
    const jsonl = readFileSync(
      writeJsonlReportFromSnapshot(snapshot, repository),
      'utf8',
    )
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(html).toContain('No output file found for this provider');
    expect(jsonl.find((line) => line.type === 'result')).toMatchObject({
      content: null,
    });
  });

  it('uses one persisted-source summary across presentation transports', () => {
    const fixture = readFixture('background-retrieved-run.json');
    const manifest = structuredClone(fixture.manifest);
    manifest.sources = { total: 0, unique: 0, file: 'sources.json' };
    const runDir = makeRun(manifest);
    const repository = new RunArtifactRepository();
    repository.writeSources(runDir, [
      {
        url: 'https://example.test/first',
        normalizedUrl: 'https://example.test/first',
        providers: ['perplexity-sonar-deep'],
        citationCount: 2,
      },
      {
        url: 'https://example.test/second',
        normalizedUrl: 'https://example.test/second',
        providers: ['perplexity-sonar-deep'],
        citationCount: 1,
      },
    ]);
    const snapshot = repository.readSnapshot(runDir, { view: 'recovery' });

    const browse = shapeBrowseRunSnapshot(snapshot);
    const mcp = shapeRunResultsSnapshot(snapshot);
    const html = readFileSync(
      writeHtmlReportFromSnapshot(snapshot, repository),
      'utf8',
    );
    const jsonlRun = JSON.parse(
      readFileSync(
        writeJsonlReportFromSnapshot(snapshot, repository),
        'utf8',
      ).split('\n')[0] as string,
    ) as Record<string, unknown>;

    expect(snapshot.manifest.sources).toEqual({
      total: 0,
      unique: 0,
      file: 'sources.json',
    });
    expect(browse.sources).toEqual({ total: 3, unique: 2 });
    expect(mcp.summary.sources).toEqual({ total: 3, unique: 2 });
    expect(html).toContain('2 unique sources after dedupe (3 total citations)');
    expect(jsonlRun).toMatchObject({
      uniqueSources: 2,
      totalCitations: 3,
    });
  });
});
