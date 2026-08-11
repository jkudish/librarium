import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRunManifest,
  type RunManifest,
  RunManifestError,
  readRunManifest,
} from '../src/core/run-manifest.js';
import {
  providerArtifactFileNames,
  RunArtifactRepository,
  resolveContainedPath,
  resolveRunDirectory,
} from '../src/node-run-artifacts.js';
import type { ProviderReport } from '../src/types.js';

const runs: string[] = [];

afterEach(() => {
  for (const dir of runs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function makeRun(
  providers: ProviderReport[],
  overrides: Partial<RunManifest> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'librarium-artifacts-'));
  runs.push(dir);
  createRunManifest(dir, {
    status: 'awaiting_async',
    timestamp: 1,
    slug: 'artifact-test',
    query: 'artifact test',
    mode: 'async',
    outputDir: '/untrusted/from-manifest',
    providers,
    sources: { total: 0, unique: 0, file: 'sources.json' },
    exitCode: null,
    ...overrides,
  });
  return dir;
}

function pending(provider = 'provider-a', taskId = 'task-a'): ProviderReport {
  return {
    id: provider,
    tier: 'deep-research',
    status: 'async-pending',
    durationMs: 0,
    wordCount: 0,
    citationCount: 0,
    outputFile: '',
    metaFile: '',
    task: { taskId, submittedAt: 1, status: 'completed' },
  };
}

function success(
  provider: string,
  taskId: string,
  outputFile = `${provider}.md`,
  metaFile = `${provider}.meta.json`,
): ProviderReport {
  const generated = providerArtifactFileNames(provider);
  return {
    id: provider,
    tier: 'deep-research',
    status: 'success',
    durationMs: 10,
    wordCount: 2,
    citationCount: 1,
    outputFile:
      outputFile === `${provider}.md` ? generated.outputFile : outputFile,
    metaFile:
      metaFile === `${provider}.meta.json` ? generated.metaFile : metaFile,
    task: { taskId, submittedAt: 1, status: 'completed' },
  };
}

const citation = (
  provider: string,
  url = `https://${provider}.test`,
): {
  url: string;
  provider: string;
} => ({ url, provider });

describe('RunArtifactRepository', () => {
  it('keeps strict manifest errors separate from best-effort discovery', () => {
    const dir = makeRun([]);
    const repository = new RunArtifactRepository();
    expect(repository.readManifest(dir).schemaVersion).toBe(2);

    writeFileSync(join(dir, 'run.json'), '{not-json');
    expect(() => repository.readManifest(dir)).toThrow(RunManifestError);
    expect(repository.tryReadManifest(dir)).toBeNull();

    const base = mkdtempSync(join(tmpdir(), 'librarium-discovery-'));
    runs.push(base);
    mkdirSync(join(base, 'malformed'));
    writeFileSync(join(base, 'malformed', 'run.json'), '{not-json');
    expect(repository.discoverRuns(base)).toEqual([]);
  });

  it('centralizes contained paths and rejects traversal and symlink escapes', () => {
    const dir = makeRun([]);
    expect(resolveContainedPath(dir, 'safe.md')).toBe(join(dir, 'safe.md'));
    expect(() => resolveContainedPath(dir, '../outside.md')).toThrow();
    expect(() => resolveContainedPath(dir, '/tmp/outside.md')).toThrow();

    const outside = mkdtempSync(join(tmpdir(), 'librarium-outside-'));
    runs.push(outside);
    writeFileSync(join(outside, 'secret.md'), 'secret');
    symlinkSync(join(outside, 'secret.md'), join(dir, 'escape.md'));
    expect(() => resolveContainedPath(dir, 'escape.md')).toThrow(/Symlink/);
    expect(resolveRunDirectory(dirname(dir), dir)).toBe(realpathSync(dir));
  });

  it('projects recovery without mutating the authoritative manifest or inventing facts', () => {
    const dir = makeRun([pending('provider-a')]);
    writeFileSync(join(dir, 'provider-a.md'), '# recovered\ntext');
    const before = readFileSync(join(dir, 'run.json'), 'utf8');
    const repository = new RunArtifactRepository();
    const snapshot = repository.readSnapshot(dir, { view: 'recovery' });

    expect(snapshot.manifest.providers[0]?.status).toBe('async-pending');
    expect(snapshot.reports[0]).toMatchObject({
      id: 'provider-a',
      status: 'success',
      outputFile: 'provider-a.md',
      metaFile: '',
      wordCount: 3,
    });
    expect(snapshot.providerArtifacts['provider-a']).toEqual({
      content: '# recovered\ntext',
      recovered: true,
    });
    expect(snapshot.manifest.providers[0]?.task?.retrievedAt).toBeUndefined();
    expect(readFileSync(join(dir, 'run.json'), 'utf8')).toBe(before);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.manifest)).toBe(true);

    writeFileSync(
      join(dir, 'provider-a.meta.json'),
      JSON.stringify({
        provider: 'other-provider',
        citations: [citation('other-provider')],
      }),
    );
    const mismatched = repository.readSnapshot(dir, { view: 'recovery' });
    expect(mismatched.providerArtifacts['provider-a']?.meta).toBeUndefined();
  });

  it('derives recovered citation counts from validated citations', () => {
    const dir = makeRun([pending('provider-a')]);
    writeFileSync(join(dir, 'provider-a.md'), 'recovered content');
    writeFileSync(
      join(dir, 'provider-a.meta.json'),
      JSON.stringify({
        provider: 'provider-a',
        citationCount: 99,
        citations: [citation('provider-a')],
      }),
    );

    const snapshot = new RunArtifactRepository().readSnapshot(dir, {
      view: 'recovery',
    });

    expect(snapshot.providerArtifacts['provider-a']?.meta?.citationCount).toBe(
      1,
    );
    expect(snapshot.reports[0]?.citationCount).toBe(1);
  });

  it('preserves persisted source accounting and opaque provider keys in recovery', () => {
    const opaque = ['__proto__', 'constructor', 'prototype'];
    const dir = makeRun(
      opaque.map((provider) => pending(provider, `task-${provider}`)),
      { sources: { total: 5, unique: 1, file: 'sources.json' } },
    );
    writeFileSync(join(dir, '__proto__.md'), 'recovered');
    writeFileSync(
      join(dir, '__proto__.meta.json'),
      JSON.stringify({
        provider: '__proto__',
        citations: [
          {
            url: 'https://new.test',
            provider: '__proto__',
            title: 'kept',
            raw_vendor_payload: { secret: true },
          },
        ],
      }),
    );
    const persisted = [
      {
        url: 'https://persisted.test',
        normalizedUrl: 'persisted.test',
        providers: ['__proto__'],
        citationCount: 5,
      },
    ];
    writeFileSync(join(dir, 'sources.json'), JSON.stringify(persisted));

    const snapshot = new RunArtifactRepository().readSnapshot(dir, {
      view: 'recovery',
    });
    for (const provider of opaque) {
      expect(Object.hasOwn(snapshot.providerArtifacts, provider)).toBe(true);
      expect(Object.isFrozen(snapshot.providerArtifacts[provider])).toBe(true);
    }
    expect(Object.prototype.polluted).toBeUndefined();
    expect(snapshot.sources).toEqual(persisted);
    const protoArtifact = Object.getOwnPropertyDescriptor(
      snapshot.providerArtifacts,
      '__proto__',
    )?.value as { meta?: { citations: unknown } } | undefined;
    expect(protoArtifact?.meta?.citations).toEqual([
      { url: 'https://new.test', provider: '__proto__', title: 'kept' },
    ]);

    const collisionDir = makeRun([pending('a:b'), pending('a?b')]);
    writeFileSync(join(collisionDir, 'a_b.md'), 'ambiguous legacy output');
    const collisionSnapshot = new RunArtifactRepository().readSnapshot(
      collisionDir,
      { view: 'recovery' },
    );
    expect(collisionSnapshot.reports.map((report) => report.status)).toEqual([
      'async-pending',
      'async-pending',
    ]);
    expect(providerArtifactFileNames('a:b').outputFile).not.toBe(
      providerArtifactFileNames('a?b').outputFile,
    );

    const caseDir = makeRun([pending('A'), pending('a')]);
    writeFileSync(join(caseDir, 'a.md'), 'case-ambiguous');
    const caseSnapshot = new RunArtifactRepository().readSnapshot(caseDir, {
      view: 'recovery',
    });
    expect(caseSnapshot.reports.map((report) => report.status)).toEqual([
      'async-pending',
      'async-pending',
    ]);
  });

  it('keeps normal retrieved reports authoritative and reads narrow metadata', () => {
    const report = success('provider-a', 'task-a');
    const dir = makeRun([report], {
      status: 'completed',
      mode: 'async',
      exitCode: 0,
      sources: { total: 1, unique: 1, file: 'sources.json' },
    });
    writeFileSync(join(dir, report.outputFile), 'answer text');
    writeFileSync(
      join(dir, report.metaFile),
      JSON.stringify({
        provider: 'provider-a',
        citations: [citation('provider-a')],
      }),
    );
    writeFileSync(
      join(dir, 'sources.json'),
      JSON.stringify([
        {
          url: 'https://provider-a.test',
          normalizedUrl: 'provider-a.test',
          providers: ['provider-a'],
          citationCount: 1,
        },
      ]),
    );
    const snapshot = new RunArtifactRepository().readSnapshot(dir);
    expect(snapshot.reports).toEqual([report]);
    expect(snapshot.providerArtifacts['provider-a']?.recovered).toBe(false);
    expect(snapshot.sources).toHaveLength(1);
    const repository = new RunArtifactRepository();
    expect(repository.readProviderContent(dir, 'provider-a')).toBe(
      'answer text',
    );
    expect(repository.readProviderMeta(dir, 'provider-a')).toMatchObject({
      provider: 'provider-a',
      citations: [citation('provider-a')],
    });
  });

  it('writes output/meta ahead of a serialized commit and retries after commit failure', () => {
    const dir = makeRun([pending('provider-a')]);
    const report = success('provider-a', 'task-a');
    const failing = new RunArtifactRepository({
      mutateManifest: (manifestDir, mutate) => {
        const current = readRunManifest(manifestDir);
        const draft = structuredClone(current);
        mutate(draft);
        throw new Error('injected manifest commit failure');
      },
    });
    const input = {
      runDir: dir,
      providerId: 'provider-a',
      taskId: 'task-a',
      report,
      content: 'answer text',
      meta: { citations: [citation('provider-a')] },
      now: 10,
    } as const;
    expect(() => failing.commitRetrieved(input)).toThrow(
      'injected manifest commit failure',
    );
    expect(
      readRunManifest(dir).providers[0]?.task?.retrievedAt,
    ).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, 'sources.json'), 'utf8'))).toEqual(
      [
        {
          url: 'https://provider-a.test',
          normalizedUrl: 'provider-a.test',
          providers: ['provider-a'],
          citationCount: 1,
        },
      ],
    );

    const committed = new RunArtifactRepository({
      now: () => 10,
    }).commitRetrieved(input);
    expect(committed.committed).toBe(true);
    expect(committed.snapshot.manifest.providers[0]?.task?.retrievedAt).toBe(
      10,
    );
    expect(committed.snapshot.manifest.sources).toEqual({
      total: 1,
      unique: 1,
      file: 'sources.json',
    });

    const alreadyCommitted = new RunArtifactRepository({
      now: () => 11,
    }).commitRetrieved(input);
    expect(alreadyCommitted.committed).toBe(false);
    expect(alreadyCommitted.snapshot.manifest.revision).toBe(
      committed.snapshot.manifest.revision,
    );
  });

  it('rejects malformed commit inputs before write-ahead artifacts', () => {
    const dir = makeRun([pending('provider-a')]);
    const report = success(
      'provider-a',
      'task-a',
      '../escape.md',
      'provider-a.meta.json',
    );
    const repository = new RunArtifactRepository();
    expect(() =>
      repository.commitRetrieved({
        runDir: dir,
        providerId: 'provider-a',
        taskId: 'task-a',
        report,
        content: 'should not write',
        meta: { citations: [citation('provider-a')] },
      }),
    ).toThrow();
    expect(existsSync(join(dir, 'escape.md'))).toBe(false);
    expect(existsSync(join(dir, 'provider-a.meta.json'))).toBe(false);
  });

  it('rejects reserved names and declared-artifact collisions before writes', () => {
    const dir = makeRun([pending('bad\nid', 'task-control')]);
    const repository = new RunArtifactRepository();
    expect(() =>
      repository.commitRetrieved({
        runDir: dir,
        providerId: 'bad\nid',
        taskId: 'task-control',
        report: success('bad\nid', 'task-control'),
        content: 'control collision',
        meta: { citations: [citation('bad\nid')] },
      }),
    ).toThrow(/reserved|collide|generated/);
    expect(
      existsSync(join(dir, providerArtifactFileNames('bad\nid').outputFile)),
    ).toBe(false);

    const collisionDir = makeRun([
      success(
        'other',
        'task-other',
        providerArtifactFileNames('provider-b').outputFile,
        'other-declared.meta.json',
      ),
      pending('provider-b', 'task-b'),
    ]);
    writeFileSync(
      join(collisionDir, 'other-declared.meta.json'),
      JSON.stringify({ provider: 'other', citations: [citation('other')] }),
    );
    expect(() =>
      repository.commitRetrieved({
        runDir: collisionDir,
        providerId: 'provider-b',
        taskId: 'task-b',
        report: success('provider-b', 'task-b'),
        content: 'collision text',
        meta: { citations: [citation('provider-b')] },
      }),
    ).toThrow(/collide/);
    expect(existsSync(join(collisionDir, 'provider-b.meta.json'))).toBe(false);
  });

  it('rejects contradictory or non-closed report facts before any write', () => {
    const mutations: Array<(report: ProviderReport) => void> = [
      (report) => {
        report.durationMs = Number.NaN;
      },
      (report) => {
        report.durationMs = Number.POSITIVE_INFINITY;
      },
      (report) => {
        report.wordCount = -1;
      },
      (report) => {
        report.citationCount = 2;
      },
      (report) => {
        report.tier = 'unknown' as ProviderReport['tier'];
      },
      (report) => {
        (report as ProviderReport & { raw_extra?: unknown }).raw_extra = {
          secret: true,
        };
      },
      (report) => {
        report.usage = { raw: { secret: true } };
      },
    ];
    for (const mutate of mutations) {
      const dir = makeRun([pending('provider-a', 'task-a')]);
      const report = success('provider-a', 'task-a');
      mutate(report);
      const names = providerArtifactFileNames('provider-a');
      expect(() =>
        new RunArtifactRepository().commitRetrieved({
          runDir: dir,
          providerId: 'provider-a',
          taskId: 'task-a',
          report,
          content: 'answer text',
          meta: { citations: [citation('provider-a')] },
        }),
      ).toThrow();
      expect(existsSync(join(dir, names.outputFile))).toBe(false);
      expect(existsSync(join(dir, names.metaFile))).toBe(false);
      expect(readRunManifest(dir).revision).toBe(0);
    }

    const timestampValues = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ];
    for (const now of timestampValues) {
      const dir = makeRun([pending('provider-a', 'task-a')]);
      const report = success('provider-a', 'task-a');
      const names = providerArtifactFileNames('provider-a');
      expect(() =>
        new RunArtifactRepository().commitRetrieved({
          runDir: dir,
          providerId: 'provider-a',
          taskId: 'task-a',
          report,
          content: 'answer text',
          meta: { citations: [citation('provider-a')] },
          now,
        }),
      ).toThrow(/timestamp/);
      expect(existsSync(join(dir, names.outputFile))).toBe(false);
      expect(readRunManifest(dir).revision).toBe(0);
    }
    const clockDir = makeRun([pending('provider-a', 'task-a')]);
    const clockReport = success('provider-a', 'task-a');
    expect(() =>
      new RunArtifactRepository({ now: () => Number.NaN }).commitRetrieved({
        runDir: clockDir,
        providerId: 'provider-a',
        taskId: 'task-a',
        report: clockReport,
        content: 'answer text',
        meta: { citations: [citation('provider-a')] },
      }),
    ).toThrow(/timestamp/);
    expect(readRunManifest(clockDir).revision).toBe(0);
  });

  it('fails closed when another declared provider metadata file is malformed', () => {
    const providerA = success(
      'provider-a',
      'task-a',
      'provider-a.md',
      'provider-a.meta.json',
    );
    const dir = makeRun([providerA, pending('provider-b', 'task-b')]);
    writeFileSync(join(dir, providerA.outputFile), 'a');
    writeFileSync(join(dir, providerA.metaFile), '{malformed');
    const report = success('provider-b', 'task-b');
    const input = {
      runDir: dir,
      providerId: 'provider-b',
      taskId: 'task-b',
      report,
      content: 'b answer',
      meta: { citations: [citation('provider-b')] },
      now: 10,
    } as const;
    expect(() => new RunArtifactRepository().commitRetrieved(input)).toThrow(
      /malformed|unreadable/,
    );
    expect(
      readRunManifest(dir).providers[1]?.task?.retrievedAt,
    ).toBeUndefined();
    expect(readFileSync(join(dir, report.outputFile), 'utf8')).toBe('b answer');
    expect(readFileSync(join(dir, report.metaFile), 'utf8')).toContain(
      'provider-b',
    );

    writeFileSync(
      join(dir, providerA.metaFile),
      JSON.stringify({
        provider: 'provider-a',
        citations: [citation('provider-a')],
      }),
    );
    const committed = new RunArtifactRepository({
      now: () => 10,
    }).commitRetrieved(input);
    expect(committed.committed).toBe(true);
    expect(committed.snapshot.manifest.providers[1]?.task?.retrievedAt).toBe(
      10,
    );
    expect(committed.snapshot.manifest.sources).toMatchObject({
      total: 2,
      unique: 2,
    });
  });

  it('serializes same-task commits so the winner owns a coherent artifact set', async () => {
    const dir = makeRun([pending('provider-a', 'task-a')]);
    const names = providerArtifactFileNames('provider-a');
    const fixture = join(process.cwd(), 'tests/fixtures/commit-retrieved.ts');
    const worker = join(dir, 'commit-worker.mjs');
    buildSync({
      entryPoints: [fixture],
      outfile: worker,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22.12',
    });
    await Promise.all(
      ['winner-a', 'winner-b'].map(
        (content) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, [worker, dir, content], {
              stdio: 'pipe',
            });
            let stderr = '';
            child.stderr.on('data', (chunk) => {
              stderr += String(chunk);
            });
            child.on('error', reject);
            child.on('exit', (code) => {
              if (code === 0) resolve();
              else reject(new Error(`commit worker exited ${code}: ${stderr}`));
            });
          }),
      ),
    );
    const manifest = readRunManifest(dir);
    expect(manifest.revision).toBe(1);
    expect(manifest.providers[0]?.task?.retrievedAt).toBeDefined();
    const content = readFileSync(join(dir, names.outputFile), 'utf8');
    expect(['winner-a', 'winner-b']).toContain(content);
    const meta = JSON.parse(
      readFileSync(join(dir, names.metaFile), 'utf8'),
    ) as { citations: Array<{ url: string }> };
    expect(meta.citations[0]?.url).toBe('https://provider-a.test');
    expect(JSON.parse(readFileSync(join(dir, 'sources.json'), 'utf8'))).toEqual(
      [
        {
          url: 'https://provider-a.test',
          normalizedUrl: 'provider-a.test',
          providers: ['provider-a'],
          citationCount: 1,
        },
      ],
    );
  });
});
