import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCliProgram } from '../../src/cli-program.js';
import { discoverRuns } from '../../src/commands/browse-data.js';
import { writeHtmlReport } from '../../src/commands/html-report-v2.js';
import { writeJsonlReport } from '../../src/commands/jsonl-report-v2.js';
import { deduplicateSources, normalizeUrl } from '../../src/core/normalizer.js';
import { executeResearchRun } from '../../src/core/research-run.js';
import {
  readCanonicalRunReportingView,
  writeHtmlReportForRun,
  writeJsonlReportForRun,
} from '../../src/node-canonical-reporting.js';
import {
  createRegisteredProviderAttemptBridge,
  discoverCanonicalRunDirectories,
  runCanonicalPreparedExecution,
} from '../../src/node-canonical-run.js';
import { RunArtifactRepository } from '../../src/node-run-artifacts.js';
import { RunReconciliationService } from '../../src/node-run-reconciliation.js';
import type { Config, Provider } from '../../src/types.js';
import {
  canonicalFixtureCoordinator,
  canonicalFixturePrepared,
  canonicalFixtureProfile,
} from '../../tests/fixtures/canonical-run.js';
import { measure, PERFORMANCE_SCHEMA_VERSION } from './lib.mjs';

const root = process.env.LIBRARIUM_PERFORMANCE_ROOT
  ? resolve(process.env.LIBRARIUM_PERFORMANCE_ROOT)
  : resolve(import.meta.dirname, '..', '..');
const defaults = { warmup: 2, iterations: 7 };

function argument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : Number(process.argv[index + 1]);
}

function gitRevision(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
}

function bytes(path: string): number | null {
  return existsSync(path) && statSync(path).isFile()
    ? statSync(path).size
    : null;
}

function sizeTree(path: string): number | null {
  const result = spawnSync('du', ['-sk', path], { encoding: 'utf8' });
  return result.status === 0
    ? Number(result.stdout.trim().split(/\s+/)[0]) * 1024
    : null;
}

function benchmarkConfig(ids: readonly string[]): Config {
  return {
    version: 1,
    defaults: {
      outputDir: '',
      maxParallel: ids.length,
      timeout: 1,
      asyncTimeout: 1,
      asyncPollInterval: 1,
      mode: 'sync',
      llmWebSearch: false,
    },
    providers: Object.fromEntries(ids.map((id) => [id, { enabled: true }])),
    customProviders: {},
    trustedProviderIds: [],
    groups: {},
  };
}

function syntheticProvider(id: string): Provider {
  return {
    id,
    displayName: id,
    tier: 'raw-search',
    envVar: '',
    execution: 'inline',
    async execute() {
      return {
        provider: id,
        tier: 'raw-search',
        content: `# ${id}\n\nSynthetic result`,
        citations: [
          {
            provider: id,
            url: `https://example.test/${id}?keep=yes&utm_benchmark=1#result`,
          },
        ],
        durationMs: 1,
      };
    },
  };
}

async function createRun(
  base: string,
  name: string,
  providerCount: number,
): Promise<string> {
  const ids = Array.from(
    { length: providerCount },
    (_, index) => `synthetic-${index}`,
  );
  const providers = new Map(ids.map((id) => [id, syntheticProvider(id)]));
  const outputDir = join(base, name);
  await executeResearchRun(
    {
      query: 'offline deterministic benchmark',
      config: benchmarkConfig(ids),
      providerIds: ids,
      outputDir,
      slug: name,
    },
    {
      now: () => Date.parse('2026-08-13T00:00:00.000Z'),
      providerRegistry: {
        getProvider: (id) => providers.get(id),
        getAllProviders: () => [...providers.values()],
      },
    },
  );
  return outputDir;
}

async function createPendingRun(base: string, name: string): Promise<string> {
  const runDirectory = await createRun(base, name, 1);
  const repository = new RunArtifactRepository();
  repository.mutate(runDirectory, (manifest) => {
    const report = manifest.providers[0];
    if (!report) throw new Error('Synthetic benchmark run has no provider');
    report.status = 'async-pending';
    report.task = {
      taskId: 'synthetic-pending-task',
      submittedAt: Date.parse('2026-08-13T00:00:00.000Z'),
      status: 'pending',
      outputDir: runDirectory,
    };
    manifest.status = 'awaiting_async';
    manifest.exitCode = null;
  });
  return runDirectory;
}

async function createCanonicalRun(base: string, name: string): Promise<string> {
  const profile = canonicalFixtureProfile('canonical-synthetic');
  const prepared = canonicalFixturePrepared([profile], {
    requestId: name,
    query: 'offline canonical benchmark',
  });
  const provider = syntheticProvider('adapter-canonical-synthetic');
  const runDirectory = join(base, name);
  mkdirSync(runDirectory, { recursive: true });
  await runCanonicalPreparedExecution(prepared, {
    runs_root: base,
    run_directory: runDirectory,
    coordinator: canonicalFixtureCoordinator(),
    attempt_bridge: createRegisteredProviderAttemptBridge(
      prepared,
      (adapterId) => (adapterId === provider.id ? provider : undefined),
      () => Date.parse('2026-08-13T00:00:00.000Z'),
    ),
  });
  return runDirectory;
}

async function main(): Promise<void> {
  const warmup = argument('--warmup', defaults.warmup);
  const iterations = argument('--iterations', defaults.iterations);
  if (
    !Number.isInteger(warmup) ||
    warmup < 0 ||
    !Number.isInteger(iterations) ||
    iterations < 3
  )
    throw new Error(
      '--warmup must be nonnegative and --iterations must be at least 3',
    );
  const temp = mkdtempSync(join(tmpdir(), 'librarium-performance-'));
  try {
    const metrics: Array<Record<string, unknown>> = [];
    for (const profiles of [1, 4, 16]) {
      metrics.push({
        name: `fan-out-${profiles}-profiles`,
        parameters: { profiles },
        ...(await measure({
          warmup,
          iterations,
          operation: async () => {
            const directory = mkdtempSync(join(temp, 'fanout-'));
            try {
              await createRun(directory, 'run', profiles);
            } finally {
              rmSync(directory, { recursive: true, force: true });
            }
          },
        })),
      });
    }
    const urls = Array.from(
      { length: 2_000 },
      (_, index) =>
        `https://WWW.Example${index % 50}.test/article/${index % 200}?keep=${index % 17}&UTM_Custom_${index % 7}=x#source-${index}`,
    );
    metrics.push({
      name: 'url-normalization-2000',
      parameters: { urls: urls.length },
      ...(await measure({
        warmup,
        iterations,
        operation: () => {
          for (const url of urls) normalizeUrl(url);
        },
      })),
    });
    metrics.push({
      name: 'url-deduplication-2000',
      parameters: { citations: urls.length },
      ...(await measure({
        warmup,
        iterations,
        operation: () =>
          deduplicateSources(
            urls.map((url, index) => ({
              url,
              provider: `provider-${index % 4}`,
            })),
          ),
      })),
    });
    for (const count of [1, 20, 100]) {
      const base = join(temp, `runs-${count}`);
      for (let index = 0; index < count; index++)
        await createRun(base, `run-${String(index).padStart(3, '0')}`, 1);
      const repository = new RunArtifactRepository();
      const runDirectories = Array.from({ length: count }, (_, index) =>
        join(base, `run-${String(index).padStart(3, '0')}`),
      );
      metrics.push({
        name: `artifact-read-retrieved-${count}-runs`,
        parameters: { runs: count, state: 'retrieved' },
        ...(await measure({
          warmup,
          iterations,
          operation: () =>
            runDirectories.map((directory) =>
              repository.readSnapshot(directory, { view: 'recovery' }),
            ),
        })),
      });
      metrics.push({
        name: `browse-discovery-${count}-runs`,
        parameters: { runs: count },
        ...(await measure({
          warmup,
          iterations,
          operation: () => discoverRuns(base, count, repository),
        })),
      });
      metrics.push({
        name: `html-report-${count}-runs`,
        parameters: { runs: count },
        ...(await measure({
          warmup,
          iterations,
          operation: () =>
            runDirectories.map((directory) =>
              writeHtmlReport(directory, repository),
            ),
        })),
      });
      metrics.push({
        name: `jsonl-report-${count}-runs`,
        parameters: { runs: count },
        ...(await measure({
          warmup,
          iterations,
          operation: () =>
            runDirectories.map((directory) =>
              writeJsonlReport(directory, repository),
            ),
        })),
      });
      const service = new RunReconciliationService({
        repository,
        resolveBackgroundProvider: () => undefined,
        getProviderConfig: () => undefined,
        now: () => 1,
      });
      metrics.push({
        name: `reconciliation-retrieved-${count}-runs`,
        parameters: { runs: count, state: 'retrieved' },
        ...(await measure({
          warmup,
          iterations,
          operation: () =>
            Promise.all(
              runDirectories.map((directory) =>
                service.reconcileOnce(directory),
              ),
            ),
        })),
      });
      metrics.push({
        name: `artifact-read-pending-${count}-runs`,
        parameters: { runs: count, state: 'pending' },
        ...(await measure({
          warmup,
          iterations,
          prepare: async () => {
            const directory = mkdtempSync(join(temp, 'pending-read-'));
            const runs = [];
            for (let index = 0; index < count; index++) {
              runs.push(
                await createPendingRun(
                  directory,
                  `run-${String(index).padStart(3, '0')}`,
                ),
              );
            }
            return { directory, runs };
          },
          operation: ({ directory, runs }) => {
            try {
              return runs.map((runDirectory) =>
                repository.readSnapshot(runDirectory, { view: 'recovery' }),
              );
            } finally {
              rmSync(directory, { recursive: true, force: true });
            }
          },
        })),
      });
      metrics.push({
        name: `reconciliation-pending-${count}-runs`,
        parameters: { runs: count, state: 'pending' },
        ...(await measure({
          warmup,
          iterations,
          prepare: async () => {
            const directory = mkdtempSync(join(temp, 'pending-reconcile-'));
            const runs = [];
            for (let index = 0; index < count; index++) {
              runs.push(
                await createPendingRun(
                  directory,
                  `run-${String(index).padStart(3, '0')}`,
                ),
              );
            }
            const pendingRepository = new RunArtifactRepository();
            return {
              directory,
              runs,
              service: new RunReconciliationService({
                repository: pendingRepository,
                resolveBackgroundProvider: () => undefined,
                getProviderConfig: () => undefined,
                now: () => 1,
              }),
            };
          },
          operation: async ({ directory, runs, service: pendingService }) => {
            try {
              return await Promise.all(
                runs.map((runDirectory) =>
                  pendingService.reconcileOnce(runDirectory),
                ),
              );
            } finally {
              rmSync(directory, { recursive: true, force: true });
            }
          },
        })),
      });
    }
    for (const count of [1, 20, 100]) {
      const base = join(temp, `canonical-runs-${count}`);
      for (let index = 0; index < count; index++) {
        await createCanonicalRun(
          base,
          `canonical-${String(index).padStart(3, '0')}`,
        );
      }
      const runDirectories = Array.from({ length: count }, (_, index) =>
        join(base, `canonical-${String(index).padStart(3, '0')}`),
      );
      metrics.push({
        name: `canonical-read-${count}-runs`,
        parameters: { runs: count, schema_version: 3 },
        ...(await measure({
          warmup,
          iterations,
          operation: () =>
            runDirectories.map((directory) =>
              readCanonicalRunReportingView(directory),
            ),
        })),
      });
      metrics.push({
        name: `canonical-discovery-${count}-runs`,
        parameters: { runs: count, schema_version: 3 },
        ...(await measure({
          warmup,
          iterations,
          operation: () => discoverCanonicalRunDirectories(base, count),
        })),
      });
      metrics.push({
        name: `canonical-html-report-${count}-runs`,
        parameters: { runs: count, schema_version: 3 },
        ...(await measure({
          warmup,
          iterations,
          operation: () =>
            runDirectories.map((directory) => writeHtmlReportForRun(directory)),
        })),
      });
      metrics.push({
        name: `canonical-jsonl-report-${count}-runs`,
        parameters: { runs: count, schema_version: 3 },
        ...(await measure({
          warmup,
          iterations,
          operation: () =>
            runDirectories.map((directory) =>
              writeJsonlReportForRun(directory),
            ),
        })),
      });
    }
    metrics.push({
      name: 'cli-warm-help',
      parameters: { mode: 'in-process' },
      ...(await measure({
        warmup,
        iterations,
        operation: () => createCliProgram().helpInformation(),
      })),
    });
    metrics.push({
      name: 'cli-cold-help',
      parameters: { mode: 'child-process' },
      ...(await measure({
        warmup: 0,
        iterations,
        operation: () => {
          const result = spawnSync(
            process.execPath,
            ['dist/cli.js', '--help'],
            { cwd: root, encoding: 'utf8' },
          );
          if (result.status !== 0)
            throw new Error(result.stderr || 'CLI help failed');
        },
      })),
    });
    const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: join(temp, 'npm-cache') },
    });
    const [entry] = packed.status === 0 ? JSON.parse(packed.stdout) : [];
    process.stdout.write(
      `${JSON.stringify({ schema_version: PERFORMANCE_SCHEMA_VERSION, git_sha: gitRevision(), node: process.version, os: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown' }, parameters: { warmup, iterations, datasets: { url_count: urls.length, runs: [1, 20, 100], canonical_runs: [1, 20, 100], fan_out_profiles: [1, 4, 16] } }, package_size: { tarball_bytes: entry?.size ?? null, unpacked_bytes: entry?.unpackedSize ?? null, sea_bytes: bytes(join(root, 'dist', 'librarium')) }, dist_bytes: sizeTree(join(root, 'dist')), metrics }, null, 2)}\n`,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
