import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCliProgram } from '../../src/cli-program.js';
import { discoverRuns } from '../../src/commands/browse-data.js';
import type {
  FrozenPlanningCatalog,
  PlanningProfile,
  PreparedResearchExecution,
} from '../../src/core/execution-plan.js';
import { prepareResearchExecution } from '../../src/core/execution-plan.js';
import { deduplicateSources, normalizeUrl } from '../../src/core/normalizer.js';
import type { ExecutionProfile } from '../../src/core.js';
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
import type { Provider } from '../../src/types.js';
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

interface SyntheticExecutionTracker {
  active: number;
  peak: number;
  completed: number;
  readonly expectedPeak: number;
  readonly releaseWave: Array<() => void>;
}

function syntheticProvider(
  id: string,
  tracker: SyntheticExecutionTracker,
): Provider {
  return {
    id,
    displayName: id,
    tier: 'raw-search',
    envVar: '',
    execution: 'inline',
    async execute() {
      tracker.active++;
      tracker.peak = Math.max(tracker.peak, tracker.active);
      if (tracker.active < tracker.expectedPeak) {
        await new Promise<void>((resolve) => tracker.releaseWave.push(resolve));
      } else {
        for (const release of tracker.releaseWave.splice(0)) release();
      }
      tracker.active--;
      tracker.completed++;
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

const BENCHMARK_TIME = Date.parse('2026-08-13T00:00:00.000Z');

function benchmarkProfile(providerId: string): ExecutionProfile {
  return {
    identity: {
      provider_id: providerId,
      profile_id: 'benchmark',
      target: {
        primary: {
          model_selection: 'fixed',
          kind: 'model',
          target_id: `${providerId}-model`,
        },
      },
    },
    result_kind: 'grounded_answer',
    grounding_policy: 'required',
    observation_mode: 'api_output',
    corpora: ['web'],
    retrieval_method: 'model_search_tool',
    access_mode: 'direct',
    operator_id: providerId,
    invocation: 'inline',
    resumability: 'none',
  };
}

function planningCatalog(profiles: readonly ExecutionProfile[]) {
  const entries: readonly PlanningProfile[] = profiles.map((profile) => ({
    profile,
    binding: {
      adapter_id: `adapter-${profile.identity.provider_id}`,
      binding_id: `binding-${profile.identity.provider_id}`,
    },
    enabled: true,
    credentialed: true,
    configuration_valid: true,
  }));
  const identities = entries.map(({ profile }) => profile.identity);
  const catalog: FrozenPlanningCatalog = {
    revision: 'benchmark-r1',
    digest: 'benchmark-digest',
    profiles: entries,
    resolveGroup: () => undefined,
    resolveDefault: () => identities,
    resolveConfiguredReserve: () => [],
  };
  return catalog;
}

function canonicalPlanningFixture(
  name: string,
  providerCount: number,
  maxConcurrency = Math.min(4, providerCount),
) {
  const profiles = Array.from({ length: providerCount }, (_, index) =>
    benchmarkProfile(`synthetic-${index}`),
  );
  const targets = profiles.map(({ identity }) => ({
    provider_id: identity.provider_id,
    profile_id: identity.profile_id,
  }));
  let nextId = 0;
  return {
    input: {
      query: 'offline deterministic canonical benchmark',
      mode: 'sync',
      selector: { kind: 'targets', targets },
      fallback: { kind: 'disabled' },
      limits: {
        max_concurrency: maxConcurrency,
        request_deadline_ms: 60_000,
        inline_attempt_deadline_ms: 10_000,
        background_attempt_deadline_ms: 20_000,
        poll_interval_ms: 1_000,
      },
    },
    catalog: planningCatalog(profiles),
    dependencies: {
      clock: { now: () => BENCHMARK_TIME },
      ids: {
        next: (scope: 'request' | 'slot' | 'fallback_candidate') =>
          `${scope}-${name}-${++nextId}`,
      },
    },
  } as const;
}

function prepareCanonicalRun(
  name: string,
  providerCount: number,
  maxConcurrency = Math.min(4, providerCount),
): PreparedResearchExecution {
  const fixture = canonicalPlanningFixture(name, providerCount, maxConcurrency);
  const result = prepareResearchExecution(
    fixture.input,
    fixture.catalog,
    fixture.dependencies,
  );
  if (!result.ok) {
    throw new Error(
      `Canonical benchmark planning failed: ${JSON.stringify(result.issues)}`,
    );
  }
  return result.prepared;
}

function coordinator() {
  let nextId = 0;
  return {
    clock: { now: () => BENCHMARK_TIME },
    ids: {
      next: (scope: 'attempt' | 'event' | 'delivery_lease') =>
        `${scope}-${++nextId}`,
    },
  };
}

async function executeCanonicalRun(
  base: string,
  name: string,
  prepared: PreparedResearchExecution,
): Promise<string> {
  const tracker: SyntheticExecutionTracker = {
    active: 0,
    peak: 0,
    completed: 0,
    expectedPeak: Math.min(
      prepared.policy.limits.max_concurrency,
      prepared.request.slots.length,
    ),
    releaseWave: [],
  };
  const providers = new Map(
    prepared.request.slots.map(({ primary }) => {
      const id = `adapter-${primary.identity.provider_id}`;
      return [id, syntheticProvider(id, tracker)];
    }),
  );
  const runDirectory = join(base, name);
  mkdirSync(runDirectory, { recursive: true });
  const result = await runCanonicalPreparedExecution(prepared, {
    runs_root: base,
    run_directory: runDirectory,
    coordinator: coordinator(),
    attempt_bridge: createRegisteredProviderAttemptBridge(
      prepared,
      (adapterId) => providers.get(adapterId),
      () => BENCHMARK_TIME,
    ),
  });
  if (
    result.response?.status !== 'succeeded' ||
    result.response.results.length !== prepared.request.slots.length ||
    tracker.completed !== prepared.request.slots.length ||
    tracker.peak !== tracker.expectedPeak
  ) {
    throw new Error(
      `Canonical benchmark execution invariant failed: status=${result.response?.status ?? 'none'}, projected=${result.response?.results.length ?? 0}, completed=${tracker.completed}, peak=${tracker.peak}, expected_peak=${tracker.expectedPeak}`,
    );
  }
  return runDirectory;
}

async function createCanonicalRun(
  base: string,
  name: string,
  providerCount = 1,
): Promise<string> {
  return executeCanonicalRun(
    base,
    name,
    prepareCanonicalRun(name, providerCount),
  );
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
      const maxConcurrency = Math.min(4, profiles);
      metrics.push({
        name: `canonical-planning-${profiles}-profiles`,
        parameters: { profiles, max_concurrency: maxConcurrency },
        ...(await measure({
          warmup,
          iterations,
          prepare: () =>
            canonicalPlanningFixture('planning', profiles, maxConcurrency),
          operation: ({ input, catalog, dependencies }) => {
            const result = prepareResearchExecution(
              input,
              catalog,
              dependencies,
            );
            if (!result.ok) {
              throw new Error(
                `Canonical benchmark planning failed: ${JSON.stringify(result.issues)}`,
              );
            }
            return result.prepared;
          },
        })),
      });
      metrics.push({
        name: `canonical-execution-${profiles}-profiles`,
        parameters: {
          profiles,
          max_concurrency: maxConcurrency,
          scope: 'local-runtime-filesystem-and-projection',
          provider_io: 'deterministic-concurrent-fake-adapters',
        },
        ...(await measure({
          warmup,
          iterations,
          prepare: () => {
            const directory = mkdtempSync(join(temp, 'fanout-'));
            return {
              directory,
              prepared: prepareCanonicalRun('run', profiles, maxConcurrency),
            };
          },
          operation: async ({ directory, prepared }) => {
            try {
              await executeCanonicalRun(directory, 'run', prepared);
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
      const base = join(temp, `canonical-runs-${count}`);
      for (let index = 0; index < count; index++)
        await createCanonicalRun(
          base,
          `canonical-${String(index).padStart(3, '0')}`,
        );
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
        name: `canonical-browse-discovery-${count}-runs`,
        parameters: { runs: count, schema_version: 3 },
        ...(await measure({
          warmup,
          iterations,
          operation: () => discoverRuns(base, count),
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
      `${JSON.stringify({ schema_version: PERFORMANCE_SCHEMA_VERSION, git_sha: gitRevision(), node: process.version, os: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown' }, methodology: { scope: 'synthetic local Librarium overhead', provider_io: 'deterministic fake adapters synchronized per scheduler wave; no live provider calls or simulated latency', comparable_with_schema_versions: [PERFORMANCE_SCHEMA_VERSION] }, parameters: { warmup, iterations, datasets: { url_count: urls.length, canonical_runs: [1, 20, 100], canonical_profiles: [1, 4, 16], max_concurrency: [1, 4, 4] } }, package_size: { tarball_bytes: entry?.size ?? null, unpacked_bytes: entry?.unpackedSize ?? null, sea_bytes: bytes(join(root, 'dist', 'librarium')) }, dist_bytes: sizeTree(join(root, 'dist')), metrics }, null, 2)}\n`,
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
