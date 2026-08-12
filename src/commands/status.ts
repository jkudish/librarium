import { resolve } from 'node:path';
import type { Command } from 'commander';
import ora from 'ora';
import {
  getExactProvider,
  initializeProviders,
} from '../adapters/node-registry.js';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import { generateSlug } from '../core/prompt-builder.js';
import { writeCanonicalPresentationArtifacts } from '../node-canonical-artifacts.js';
import {
  canonicalRunsRoot,
  createNodeCoordinatorDependencies,
  createRegisteredProviderAttemptBridge,
  discoverCanonicalRunDirectories,
  readCanonicalRunManifest,
  resumeCanonicalPreparedExecution,
} from '../node-canonical-run.js';
import { createNodeCredentialContext } from '../node-credentials.js';
import {
  createNodeRunReconciliationRuntime,
  type NodeRunReconciliationRuntime,
  type ReconciliationResult,
} from '../node-run-reconciliation-runtime.js';
import type { AsyncTaskHandle, Config, ProviderReport } from '../types.js';
import {
  computeLineWidths,
  dimText,
  formatProviderLine,
  isColorEnabled,
} from './run-format.js';

const RECONCILIATION_FAILED = 'artifact.reconciliation_failed';
const REGENERATION_FAILED = 'artifact.regeneration_failed';

interface ReconciledRun {
  readonly runDir: string;
  readonly result?: ReconciliationResult;
  readonly error?: typeof RECONCILIATION_FAILED;
  readonly refreshed: readonly string[];
}

interface ReconcileRunsResult {
  readonly runs: readonly ReconciledRun[];
  readonly polled: number;
  readonly retrieved: number;
  readonly errors: readonly (typeof RECONCILIATION_FAILED)[];
  readonly regenerationErrors: readonly (typeof REGENERATION_FAILED)[];
}

function formatTaskAge(submittedAt: number): string {
  const ageMs = Date.now() - submittedAt;
  const ageMin = Math.floor(ageMs / 60000);
  if (ageMin < 1) return 'just now';
  if (ageMin < 60) return `${ageMin}m ago`;
  return `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`;
}

function formatTaskStatus(task: AsyncTaskHandle): string {
  const remote = task.providerStatus
    ? ` | Provider: ${task.providerStatus}`
    : '';
  const error = task.lastPollError ? ` | Error: ${task.lastPollError}` : '';
  return `  ${task.provider} | Task: ${task.taskId.slice(0, 20)}... | Status: ${task.status}${remote}${error} | Submitted: ${formatTaskAge(task.submittedAt)}`;
}

function persistedTasks(
  runtime: NodeRunReconciliationRuntime,
  runDirs: readonly string[],
): AsyncTaskHandle[] {
  const tasks: AsyncTaskHandle[] = [];
  for (const runDir of runDirs) {
    const snapshot = runtime.repository.tryReadSnapshot(runDir, {
      view: 'authoritative',
    });
    if (!snapshot) continue;
    for (const report of snapshot.manifest.providers) {
      const task = report.task;
      if (!task || task.retrievedAt !== undefined) continue;
      tasks.push({
        provider: report.id,
        taskId: task.taskId,
        query: snapshot.manifest.query,
        submittedAt: task.submittedAt,
        status: task.status,
        outputDir: snapshot.runDir,
        ...(task.lastPolledAt === undefined
          ? {}
          : { lastPolledAt: task.lastPolledAt }),
        ...(task.completedAt === undefined
          ? {}
          : { completedAt: task.completedAt }),
        ...(task.providerStatus === undefined
          ? {}
          : { providerStatus: task.providerStatus }),
        ...(task.lastPollError === undefined
          ? {}
          : { lastPollError: task.lastPollError }),
      });
    }
  }
  return tasks;
}

async function reconcileRuns(
  runtime: NodeRunReconciliationRuntime,
  runDirs: readonly string[],
  retrieve: boolean,
): Promise<ReconcileRunsResult> {
  const runs: ReconciledRun[] = [];
  const errors: (typeof RECONCILIATION_FAILED)[] = [];
  const regenerationErrors: (typeof REGENERATION_FAILED)[] = [];
  let polled = 0;
  let retrieved = 0;

  for (const runDir of runDirs) {
    try {
      const refreshed = ['summary.md', 'report.html', 'results.jsonl'].filter(
        (fileName) => runtime.repository.hasArtifact(runDir, fileName),
      );
      const result = await runtime.service.reconcileOnce(runDir, { retrieve });
      polled += result.polled;
      retrieved += result.retrieved;
      if (result.regenerationError !== undefined)
        regenerationErrors.push(REGENERATION_FAILED);
      runs.push({ runDir, result, refreshed });
    } catch {
      errors.push(RECONCILIATION_FAILED);
      runs.push({
        runDir,
        error: RECONCILIATION_FAILED,
        refreshed: [],
      });
    }
  }
  return { runs, polled, retrieved, errors, regenerationErrors };
}

/** Compatibility shim; lifecycle work remains in the reconciliation service. */
export async function reconcilePendingTasksOnce(
  tasks: AsyncTaskHandle[],
  config: Config,
): Promise<void> {
  const runtime = createNodeRunReconciliationRuntime(config);
  const runDirs = [
    ...new Set(
      tasks
        .map((task) => task.outputDir)
        .filter((runDir): runDir is string => Boolean(runDir)),
    ),
  ];
  await reconcileRuns(runtime, runDirs, false);
}

function printTasks(
  tasks: AsyncTaskHandle[],
  print: (line: string) => void,
): void {
  const pending = tasks.filter(
    (task) => task.status === 'pending' || task.status === 'running',
  );
  const completed = tasks.filter((task) => task.status === 'completed');
  const terminal = tasks.filter(
    (task) => task.status === 'failed' || task.status === 'cancelled',
  );
  if (pending.length > 0) {
    print(`\nPending async tasks (${pending.length}):\n`);
    for (const task of pending) print(formatTaskStatus(task));
  }
  if (completed.length > 0) {
    print(`\nCompleted (awaiting retrieval): ${completed.length}\n`);
    for (const task of completed) print(formatTaskStatus(task));
  }
  if (terminal.length > 0) {
    print(`\nTerminal async tasks (${terminal.length}):\n`);
    for (const task of terminal) print(formatTaskStatus(task));
  }
  print(
    '\nUse --wait to poll and auto-retrieve, --retrieve to fetch completed results.',
  );
}

function printRetrieved(
  runtime: NodeRunReconciliationRuntime,
  pass: ReconcileRunsResult,
  rendered: Set<string>,
  print: (line: string) => void,
  color: boolean,
): void {
  for (const run of pass.runs) {
    const result = run.result;
    if (!result) continue;
    const snapshot = runtime.repository.tryReadSnapshot(run.runDir, {
      view: 'authoritative',
    });
    if (!snapshot) continue;
    const reports: ProviderReport[] = [];
    for (const task of result.tasks) {
      if (!task.retrievedThisPass) continue;
      const key = `${run.runDir}\0${task.provider}\0${task.taskId}`;
      if (rendered.has(key)) continue;
      const report = snapshot.manifest.providers.find(
        (candidate) =>
          candidate.id === task.provider &&
          candidate.task?.taskId === task.taskId,
      );
      if (!report) continue;
      rendered.add(key);
      reports.push(report);
    }
    const widths = computeLineWidths(
      reports.map((report) => report.id),
      reports.map((report) => report.tier),
    );
    for (const report of reports) {
      print(
        `${formatProviderLine(report, widths, color)}   ${dimText(
          `${report.outputFile}, ${report.wordCount} words`,
          color,
        )}`,
      );
    }
    if (result.regenerated) {
      for (const fileName of run.refreshed) print(`  regenerated ${fileName}`);
    }
  }
}

function reportWarnings(pass: ReconcileRunsResult): boolean {
  for (const error of pass.errors)
    process.stderr.write(`[librarium] warning: ${error}\n`);
  for (const error of pass.regenerationErrors)
    process.stderr.write(`[librarium] warning: ${error}\n`);
  return pass.errors.length > 0 || pass.regenerationErrors.length > 0;
}

/** Keep terminal output and warnings from corrupting an active ora frame. */
function withSpinnerStopped(
  spinner: ReturnType<typeof ora>,
  action: () => void,
  restart: boolean,
): void {
  const wasSpinning = spinner.isSpinning;
  if (wasSpinning) spinner.stop();
  action();
  if (wasSpinning && restart) spinner.start();
}

function jsonPayload(
  tasks: AsyncTaskHandle[],
  errors: readonly (typeof RECONCILIATION_FAILED)[],
  regenerationErrors: readonly (typeof REGENERATION_FAILED)[],
): Record<string, unknown> {
  return {
    tasks,
    ...(errors.length === 0 ? {} : { errors }),
    ...(regenerationErrors.length === 0 ? {} : { regenerationErrors }),
  };
}

async function reconcileCanonicalRuns(
  baseDir: string,
  _config: Config,
): Promise<{
  readonly runs: readonly {
    readonly runDir: string;
    readonly state: 'pending' | 'terminal';
    readonly response?: unknown;
  }[];
  readonly pending: number;
}> {
  const runs = [];
  for (const runDir of discoverCanonicalRunDirectories(
    baseDir,
    Number.MAX_SAFE_INTEGER,
  )) {
    const runsRoot = canonicalRunsRoot(runDir);
    const before = readCanonicalRunManifest(runsRoot, runDir);
    const remoteCustody = before.coordination_state.attempts.some(
      (attempt) =>
        attempt.durable_handle &&
        ['pending', 'running'].includes(attempt.durable_handle.status),
    );
    const needsResume =
      before.coordination_state.status === 'running' ||
      !before.terminal_response ||
      remoteCustody;
    const canonical = needsResume
      ? await resumeCanonicalPreparedExecution({
          runs_root: runsRoot,
          run_directory: runDir,
          coordinator: createNodeCoordinatorDependencies(),
          attempt_bridge: createRegisteredProviderAttemptBridge(
            {
              request: before.request,
              catalog: { digest: before.coordination_state.catalog_digest },
              profile_plans_by_identity:
                before.coordination_state.profile_plans_by_identity,
            },
            getExactProvider,
          ),
        })
      : {
          manifest: before,
          response: before.terminal_response,
        };
    writeCanonicalPresentationArtifacts(
      canonical.manifest,
      runDir,
      generateSlug(canonical.manifest.request.query),
    );
    runs.push({
      runDir,
      state:
        canonical.manifest.coordination_state.status === 'running'
          ? ('pending' as const)
          : ('terminal' as const),
      ...(canonical.response && { response: canonical.response }),
    });
  }
  return {
    runs,
    pending: runs.filter((run) => run.state === 'pending').length,
  };
}

function printCanonicalRuns(
  runs: Awaited<ReturnType<typeof reconcileCanonicalRuns>>['runs'],
  print: (line: string) => void,
): void {
  if (runs.length === 0) return;
  print(`\nCanonical runs (${runs.length}):\n`);
  for (const run of runs) {
    const response = run.response as
      | { readonly status?: string; readonly request_id?: string }
      | undefined;
    const detail = response?.status ?? run.state;
    print(`  ${run.runDir} | Status: ${detail}`);
  }
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Check status of async deep-research tasks')
    .option('--wait', 'Block and poll until all tasks complete, then retrieve')
    .option('--retrieve', 'Fetch completed results')
    .option('--json', 'Output JSON')
    .action(async (opts) => {
      try {
        const config = mergeConfigs(
          loadConfig(),
          loadProjectConfig(process.cwd()),
        );
        const runtime = createNodeRunReconciliationRuntime(config);
        const baseDir = resolve(config.defaults.outputDir);
        const canonicalRunDirs = discoverCanonicalRunDirectories(
          baseDir,
          Number.MAX_SAFE_INTEGER,
        );
        const admittedCanonicalAdapters = [
          ...new Set(
            canonicalRunDirs.flatMap((runDir) =>
              Object.values(
                readCanonicalRunManifest(canonicalRunsRoot(runDir), runDir)
                  .coordination_state.profile_plans_by_identity,
              ).map((plan) => plan.binding.adapter_id),
            ),
          ),
        ];
        const runDirs = runtime.repository
          .discoverRuns(baseDir, Number.MAX_SAFE_INTEGER)
          .map((run) => run.runDir);
        const historicalCustomAdapters = [
          ...new Set(
            runDirs.flatMap((runDir) => {
              const manifest = runtime.repository.tryReadManifest(runDir);
              return manifest
                ? manifest.providers
                    .map((provider) => provider.id)
                    .filter((id) => Object.hasOwn(config.customProviders, id))
                : [];
            }),
          ),
        ];
        const credentials = createNodeCredentialContext();
        const initialized = await initializeProviders(
          { ...config, credentials },
          {
            customProviderIds: [
              ...new Set([
                ...admittedCanonicalAdapters,
                ...historicalCustomAdapters,
              ]),
            ],
          },
        );
        for (const warning of initialized.warnings)
          process.stderr.write(`[librarium] warning: ${warning}\n`);

        let canonical = await reconcileCanonicalRuns(baseDir, config);
        let tasks = persistedTasks(runtime, runDirs);
        if (tasks.length === 0 && canonical.runs.length === 0) {
          if (opts.json)
            console.log(
              JSON.stringify({ tasks: [], message: 'No async tasks' }),
            );
          else console.log('No async tasks.');
          return;
        }

        const prettyStream = opts.json ? process.stderr : process.stdout;
        const print = (line: string): void => {
          prettyStream.write(`${line}\n`);
        };
        const color = isColorEnabled(prettyStream);
        const rendered = new Set<string>();
        const errors: (typeof RECONCILIATION_FAILED)[] = [];
        const regenerationErrors: (typeof REGENERATION_FAILED)[] = [];
        const record = (pass: ReconcileRunsResult): void => {
          errors.push(...pass.errors);
          regenerationErrors.push(...pass.regenerationErrors);
          if (!opts.json) {
            printRetrieved(runtime, pass, rendered, print, color);
            reportWarnings(pass);
          }
        };

        if (opts.wait) {
          const spinner = ora(`Polling ${tasks.length} async tasks...`).start();
          let totalRetrieved = 0;
          let remaining = true;
          try {
            while (remaining) {
              canonical = await reconcileCanonicalRuns(baseDir, config);
              const pass = await reconcileRuns(runtime, runDirs, true);
              totalRetrieved += pass.retrieved;
              withSpinnerStopped(spinner, () => record(pass), true);
              tasks = persistedTasks(runtime, runDirs);
              const failedRuns = new Set(
                pass.runs
                  .filter((run) => run.error !== undefined)
                  .map((run) => run.runDir),
              );
              remaining =
                canonical.pending > 0 ||
                tasks.some(
                  (task) =>
                    !failedRuns.has(task.outputDir ?? '') &&
                    (task.status === 'pending' || task.status === 'running'),
                );
              if (remaining) {
                spinner.text = `Polling ${tasks.filter((task) => task.status === 'pending' || task.status === 'running').length} async tasks...`;
                await new Promise<void>((done) =>
                  setTimeout(done, config.defaults.asyncPollInterval * 1000),
                );
              }
            }
            if (errors.length > 0 || regenerationErrors.length > 0) {
              spinner.warn('Async reconciliation finished with errors.');
            } else {
              spinner.succeed(
                totalRetrieved > 0
                  ? `All async tasks completed; retrieved ${totalRetrieved} results.`
                  : 'All async tasks completed.',
              );
            }
          } finally {
            if (spinner.isSpinning) spinner.stop();
          }
        } else if (opts.retrieve) {
          const spinner = ora(
            'Reconciling and retrieving async tasks...',
          ).start();
          try {
            const pass = await reconcileRuns(runtime, runDirs, true);
            withSpinnerStopped(spinner, () => record(pass), false);
            tasks = persistedTasks(runtime, runDirs);
            if (pass.errors.length > 0 || pass.regenerationErrors.length > 0) {
              spinner.warn('Async reconciliation finished with errors.');
            } else {
              spinner.succeed(
                pass.retrieved > 0
                  ? `Retrieved ${pass.retrieved} results.`
                  : 'No completed tasks to retrieve.',
              );
            }
          } finally {
            if (spinner.isSpinning) spinner.stop();
          }
        } else {
          const pass = await reconcileRuns(runtime, runDirs, false);
          record(pass);
          tasks = persistedTasks(runtime, runDirs);
          if (errors.length > 0 || regenerationErrors.length > 0)
            process.exitCode = 1;
          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  ...jsonPayload(tasks, errors, regenerationErrors),
                  canonicalRuns: canonical.runs,
                },
                null,
                2,
              ),
            );
            return;
          }
          printCanonicalRuns(canonical.runs, print);
          printTasks(tasks, print);
          return;
        }

        if (errors.length > 0 || regenerationErrors.length > 0)
          process.exitCode = 1;
        if (opts.json)
          console.log(
            JSON.stringify(
              {
                ...jsonPayload(tasks, errors, regenerationErrors),
                canonicalRuns: canonical.runs,
              },
              null,
              2,
            ),
          );
        else {
          printCanonicalRuns(canonical.runs, print);
          if (tasks.length > 0) printTasks(tasks, print);
        }
      } catch {
        process.stderr.write(`[librarium] warning: ${RECONCILIATION_FAILED}\n`);
        process.exitCode = 1;
      }
    });
}
