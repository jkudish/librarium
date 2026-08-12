import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import type { Command } from 'commander';
import ora from 'ora';
import {
  getAllProviders,
  initializeProviders,
} from '../adapters/node-registry.js';
import {
  parseMode,
  parseParallel,
  parseProviders,
  parseResearchQuery,
  parseTimeoutSeconds,
  parseUsdBudget,
} from '../cli-parsers.js';
import {
  BUDGET_SKIP_REASON,
  createBudgetTracker,
  createEstimateBudgetTracker,
  ESTIMATE_BUDGET_SKIP_REASON,
} from '../core/budget.js';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import { generateSlug, resolveOutputDir } from '../core/prompt-builder.js';
import { retiredProviderSelectionIssues } from '../core/provider-selection.js';
import { executeResearchRun } from '../core/research-run.js';
import {
  assertAdmittedAdaptersRegistered,
  emitRequestPreflightNotices,
  legacyPrimaryAdapterIds,
  preflightProductionRequest,
  projectLegacyExecutionConfig,
} from '../node-request-preflight.js';
import type {
  Config,
  DeduplicatedSource,
  Defaults,
  ProviderDispatchResult,
  ProviderReport,
  ProviderTier,
  RunManifest,
} from '../types.js';
import { writeHtmlReport } from './html-report.js';
import { writeJsonlReport } from './jsonl-report.js';
import { LiveRunTable } from './live-table.js';
import {
  countDeepResearch,
  deepResearchWarning,
  shouldConfirmDeepResearch,
} from './preflight.js';
import { type RefinedQueries, refineQuery } from './refine.js';
import {
  computeLineWidths,
  dimText,
  fileUrl,
  formatFallbackNotice,
  formatProviderLine,
  formatRunSummary,
  hyperlink,
  isColorEnabled,
  type LineWidths,
  shortenHomePath,
} from './run-format.js';

export interface RunOptions {
  providers?: string[];
  group?: string;
  mode?: 'sync' | 'async' | 'mixed';
  output?: string;
  parallel?: number;
  timeout?: number;
  maxCost?: number;
  maxEstimatedCost?: number;
  json?: boolean;
  open?: boolean;
  html?: boolean;
  jsonl?: boolean;
  refine?: boolean;
  /** Opt-in answer-only claim verification. Ignored by plain `run`. */
  verify?: boolean;
  yes?: boolean;
  fallback?: boolean;
  /**
   * Set by the wizard, whose own confirm step already counts as consent, so
   * the deep-research pre-flight confirm does not double-prompt. Not a CLI flag.
   */
  skipPreflightConfirm?: boolean;
}

export interface RunOutcome {
  exitCode: number;
  outputDir?: string;
}

/**
 * Context handed to a post-dispatch hook (used by `librarium answer`). Exposes
 * the deduped results, the run directory, and an output sink so the hook can
 * run an extra transform (e.g. LLM synthesis), print to the same stream as the
 * run, and contribute additive fields to run.json.
 */
export interface PostDispatchContext {
  query: string;
  config: Config;
  results: ProviderDispatchResult[];
  reports: ProviderReport[];
  sources: DeduplicatedSource[];
  outputDir: string;
  color: boolean;
  printLine: (line: string) => void;
}

export interface PostDispatchResult {
  /** Additive fields merged into the run manifest before it is written. */
  manifestExtra?: Partial<Pick<RunManifest, 'answer' | 'verification'>>;
  /**
   * Raw synthesized answer body for downstream hook stages (verification).
   * Never merged into the manifest or persisted.
   */
  answerText?: string;
}

export interface ExecuteRunHooks {
  /**
   * Runs after sources are deduped and provider outputs are written, before
   * the run summary and run.json are produced. Must never throw (it is the
   * hook's job to fail open); a throw is swallowed so the run is never lost.
   */
  postDispatch?: (
    context: PostDispatchContext,
  ) => Promise<PostDispatchResult | undefined>;
}

export interface ExecuteRunDeps {
  /** Test/embedding seam for provider initialization. */
  initialize?: typeof initializeProviders;
  /**
   * Exact adapter ids registered by the injected initializer. Production reads
   * the client-scoped Node registry after initialization.
   */
  registeredAdapterIds?: () => Iterable<string>;
}

/**
 * Strict parser for the shared --max-cost flag. Rejects anything that is not a
 * finite, positive USD amount so a typo never silently disables the budget
 * circuit breaker. Shared by `run` and `answer` so both validate identically.
 */
export function parseMaxCost(value: string): number {
  return parseUsdBudget(value);
}

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run a research query across multiple providers')
    .argument('<query>', 'The research query', parseResearchQuery)
    .option(
      '-p, --providers <ids>',
      'Comma-separated provider IDs',
      parseProviders,
    )
    .option('-g, --group <name>', 'Use a predefined provider group')
    .option(
      '-m, --mode <mode>',
      'Execution mode: sync, async, or mixed',
      parseMode,
    )
    .option('-o, --output <dir>', 'Output base directory')
    .option('--parallel <n>', 'Max parallel requests', parseParallel)
    .option(
      '--timeout <n>',
      'Timeout per provider in seconds',
      parseTimeoutSeconds,
    )
    .option(
      '--max-cost <usd>',
      'Stop launching providers once API-reported cost crosses this budget (USD)',
      parseMaxCost,
    )
    .option(
      '--max-estimated-cost <usd>',
      'Reserve each provider’s pre-dispatch estimated cost; skip launches once the estimate crosses this ceiling (USD)',
      parseMaxCost,
    )
    .option('-y, --yes', 'Skip the deep-research pre-flight confirm')
    .option(
      '--no-fallback',
      'Disable configured provider fallbacks for an exact provider matrix',
    )
    .option('--json', 'Output run.json to stdout')
    .option(
      '--refine',
      'Rewrite the query into tier-tuned variants with one LLM call before dispatch',
    )
    .option(
      '--html',
      'Generate a self-contained report.html in the run directory',
    )
    .option(
      '--jsonl',
      'Generate a machine-readable results.jsonl in the run directory',
    )
    .option(
      '--open',
      'Open the output directory (or report.html with --html) when the run completes',
    )
    .action(async (query: string, opts: RunOptions) => {
      await executeRun(query, opts);
    });
}

/**
 * Execute a research run. Shared by the `run` command and the interactive
 * wizard so both produce identical output and side effects.
 */
export async function executeRun(
  query: string,
  opts: RunOptions,
  hooks?: ExecuteRunHooks,
  deps: ExecuteRunDeps = {},
): Promise<RunOutcome> {
  {
    // In --json mode stdout must stay pure JSON (the run manifest), so all
    // pretty output is routed to stderr. The ora spinner already writes to
    // stderr and no-ops in non-TTY environments.
    const prettyStream = opts.json ? process.stderr : process.stdout;
    const color = isColorEnabled(prettyStream);
    const spinner = ora('Initializing providers...').start();
    const printLine = (line: string): void => {
      const wasSpinning = spinner.isSpinning;
      if (wasSpinning) spinner.stop();
      prettyStream.write(`${line}\n`);
      if (wasSpinning) spinner.start();
    };
    const retiredProviderIssues = retiredProviderSelectionIssues(
      opts.providers,
    );
    if (retiredProviderIssues.length > 0) {
      spinner.fail(
        retiredProviderIssues.map((issue) => issue.message).join(' '),
      );
      process.exitCode = 2;
      return { exitCode: 2 };
    }
    try {
      const globalConfig = loadConfig();
      const projectConfig = loadProjectConfig(process.cwd());
      const cliFlags: Partial<Defaults> = {};
      if (opts.output) cliFlags.outputDir = opts.output;
      if (opts.parallel) cliFlags.maxParallel = opts.parallel;
      if (opts.timeout) cliFlags.timeout = opts.timeout;
      if (opts.mode) cliFlags.mode = opts.mode;
      // Flag wins over defaults.maxCostUsd from config.
      if (opts.maxCost !== undefined) cliFlags.maxCostUsd = opts.maxCost;
      if (opts.maxEstimatedCost !== undefined) {
        cliFlags.maxEstimatedCostUsd = opts.maxEstimatedCost;
      }

      const config = mergeConfigs(globalConfig, projectConfig, cliFlags);
      const preflight = preflightProductionRequest({
        config,
        transport: {
          kind: 'cli',
          input: {
            query,
            providers: opts.providers,
            group: opts.group,
            mode: opts.mode,
            parallel: opts.parallel,
            timeoutSeconds: opts.timeout,
            maxCostUsd: opts.maxCost,
            maxEstimatedCostUsd: opts.maxEstimatedCost,
            fallback: opts.fallback,
            refine: opts.refine,
          },
        },
      });
      emitRequestPreflightNotices(preflight.notices, (message) => {
        const wasSpinning = spinner.isSpinning;
        if (wasSpinning) spinner.stop();
        try {
          process.stderr.write(`${message}\n`);
        } finally {
          if (wasSpinning) spinner.start();
        }
      });
      const credentials = preflight.credentials;
      const initialize = deps.initialize ?? initializeProviders;
      const initResult = await initialize(
        {
          ...config,
          credentials,
        },
        { customProviderIds: preflight.admittedAdapterIds },
      );
      for (const warning of initResult.warnings) {
        console.error(`[librarium] warning: ${warning}`);
      }

      // Slice A retains the legacy dispatcher, but it receives the exact
      // canonical primary projection. This preserves one admission authority
      // and excludes disabled/uncredentialed group members before init.
      const providerIds = [...legacyPrimaryAdapterIds(preflight.prepared)];
      assertAdmittedAdaptersRegistered(
        preflight.prepared,
        deps.registeredAdapterIds?.() ??
          getAllProviders().map((provider) => provider.id),
      );
      const executionConfig = projectLegacyExecutionConfig(
        config,
        preflight.prepared,
      );

      // Deep-research pre-flight confirm (TTY only). When a run would dispatch
      // several deep-research providers, warn that they take minutes and bill
      // per call before committing. Non-TTY runs never prompt and are never
      // refused (pipes/CI never hang); --yes and the wizard's own confirm skip
      // it.
      {
        const tierLookup = new Map(
          getAllProviders().map((provider) => [provider.id, provider.tier]),
        );
        const deepResearchIds = providerIds.filter(
          (id) => tierLookup.get(id) === 'deep-research',
        );
        const isTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
        // In --json mode stdout must stay pure JSON: clack prompts write to
        // stdout, so the preflight confirm is disabled entirely.
        if (
          !opts.json &&
          shouldConfirmDeepResearch({
            deepResearchCount: countDeepResearch(providerIds, tierLookup),
            isTTY,
            yes: Boolean(opts.yes),
            fromWizard: Boolean(opts.skipPreflightConfirm),
          })
        ) {
          spinner.stop();
          p.log.warn(deepResearchWarning(deepResearchIds));
          const proceed = await p.confirm({
            message: 'Proceed with this deep-research run?',
            initialValue: false,
          });
          if (p.isCancel(proceed) || !proceed) {
            process.stdout.write('Cancelled.\n');
            process.exitCode = 130;
            return { exitCode: 130 };
          }
        }
      }

      // Optional one-shot LLM refine: never allowed to break the run.
      let refined: RefinedQueries | null = null;
      if (opts.refine) {
        spinner.start('Refining query...');
        const warn = (message: string): void => {
          const wasSpinning = spinner.isSpinning;
          if (wasSpinning) spinner.stop();
          process.stderr.write(
            `${dimText(`[librarium] refine: ${message}`, isColorEnabled(process.stderr))}\n`,
          );
          if (wasSpinning) spinner.start();
        };
        try {
          refined = await refineQuery(
            query,
            config,
            process.env,
            warn,
            credentials,
          );
          spinner.stop();
        } catch (e) {
          spinner.stop();
          console.error(
            `[librarium] warning: refine failed (${e instanceof Error ? e.message : String(e)}); dispatching the original query`,
          );
        }
      }

      // Create output directory
      const slug = generateSlug(query);
      const baseDir = resolve(config.defaults.outputDir);
      const outputDir = resolveOutputDir(baseDir, slug);
      mkdirSync(outputDir, { recursive: true });

      // Column widths cover both primaries and any configured fallbacks so
      // lines stay aligned if a fallback fires mid-run.
      const tierById = new Map<string, ProviderTier>(
        getAllProviders().map((provider) => [provider.id, provider.tier]),
      );
      const fallbackIds = providerIds
        .map((id) => executionConfig.providers[id]?.fallback)
        .filter((id): id is string => Boolean(id && tierById.has(id)));
      const tableIds = [...new Set([...providerIds, ...fallbackIds])];
      const widths = computeLineWidths(
        tableIds,
        tableIds.map((id) => tierById.get(id) ?? 'raw-search'),
      );

      // Live (resolve-in-place) rendering needs a real TTY for the cursor
      // math; NO_COLOR and non-TTY environments keep append-on-completion.
      const liveMode = color && Boolean(prettyStream.isTTY);
      const live = liveMode
        ? new LiveRunTable(prettyStream, widths, color)
        : null;

      const running = new Set<string>();
      const spinnerText = (): string => {
        if (running.size === 0) return 'Waiting for providers...';
        const names = [...running].join(', ');
        return `running: ${names.length > 60 ? `${names.slice(0, 59)}…` : names}`;
      };

      spinner.stop();
      printLine('');
      printLine(`  fanning out to ${providerIds.length} providers`);
      if (refined) {
        for (const tier of [
          'deep-research',
          'ai-grounded',
          'raw-search',
        ] as const) {
          const variant = refined.tierQueries[tier];
          if (!variant) continue;
          const shown =
            variant.length > 90 ? `${variant.slice(0, 89)}\u2026` : variant;
          printLine(dimText(`    ${tier}: ${shown}`, color));
        }
      }
      printLine('');
      if (live) {
        for (const id of providerIds) {
          live.addProvider(id, tierById.get(id) ?? 'raw-search');
        }
        live.start();
      } else {
        spinner.start(spinnerText());
      }

      // Honest runtime spend circuit breaker. Only API-reported costs count;
      // providers that report nothing contribute 0. Undefined budget means no
      // limit, in which case the tracker never trips.
      const budget = createBudgetTracker(config.defaults.maxCostUsd);
      // Separate pre-dispatch reservation ceiling (estimated cost). Kept fully
      // independent of the reported-cost budget above; the two never reconcile.
      const estimatedBudget = createEstimateBudgetTracker(
        config.defaults.maxEstimatedCostUsd,
      );

      const { reports, sources, totalCitations, totalDurationMs, manifest } =
        await executeResearchRun({
          query,
          config: executionConfig,
          providerIds,
          outputDir,
          slug,
          tierQueries: refined?.tierQueries,
          credentials,
          budget,
          estimatedBudget,
          allowFallbacks: opts.fallback !== false,
          onEvent: (event) => {
            if (event.type === 'post-dispatch-warning') {
              console.error(
                `[librarium] warning: post-dispatch hook failed (${event.message})`,
              );
              return;
            }
            if (event.type === 'dispatch-completed') {
              finalizeDispatchPresentation(event.reports, {
                spinner,
                live,
                printLine,
                widths,
                color,
              });
              return;
            }
            if (event.type !== 'dispatch-progress') return;
            const { progress } = event;
            if (live) {
              switch (progress.event) {
                case 'started':
                  live.markStarted(progress.providerId);
                  break;
                case 'fallback-started':
                  live.addFallback(
                    progress.report?.id ?? progress.providerId,
                    progress.providerId,
                    tierById.get(progress.providerId) ?? 'raw-search',
                  );
                  break;
                case 'completed':
                case 'error':
                case 'async-submitted':
                  if (progress.report) live.resolve(progress.report);
                  break;
              }
              return;
            }
            switch (progress.event) {
              case 'started':
                running.add(progress.providerId);
                break;
              case 'fallback-started':
                printLine(formatFallbackNotice(progress.providerId, color));
                running.add(progress.providerId);
                break;
              case 'completed':
              case 'error':
              case 'async-submitted':
                running.delete(progress.providerId);
                if (progress.report) {
                  printLine(formatProviderLine(progress.report, widths, color));
                }
                break;
            }
            spinner.text = spinnerText();
          },
          postDispatch: hooks?.postDispatch
            ? async (context) =>
                hooks.postDispatch?.({
                  ...context,
                  color,
                  printLine,
                })
            : undefined,
        });

      // Determine exit code. When a primary fails but its fallback succeeds,
      // the user's intent was fully satisfied — exclude the recovered primary's
      // error report so it doesn't inflate the failure count.
      const recoveredPrimaries = new Set(
        reports
          .filter((r) => r.fallbackFor && r.status === 'success')
          .map((r) => r.fallbackFor as string),
      );
      const effectiveReports = reports.filter(
        (r) => !recoveredPrimaries.has(r.id),
      );
      // Awaiting background work is intentionally non-terminal.
      const exitCode = manifest.exitCode ?? 0;

      // Print summary (exclude recovered primaries so they don't show as failures)
      const successful = effectiveReports.filter((r) => r.status === 'success');
      const failed = effectiveReports.filter((r) => r.status === 'error');
      const pending = effectiveReports.filter(
        (r) => r.status === 'async-pending',
      );
      // Total API-reported cost across providers that reported one. Uses ALL
      // reports (not effectiveReports): a paid primary recovered by a fallback
      // still spent real money and must count toward reported spend.
      const costReports = reports.filter(
        (r) =>
          typeof r.usage?.costUsd === 'number' &&
          Number.isFinite(r.usage.costUsd) &&
          r.usage.costUsd >= 0,
      );
      const reportedCost =
        costReports.length > 0
          ? {
              totalUsd: costReports.reduce(
                (sum, r) => sum + (r.usage?.costUsd ?? 0),
                0,
              ),
              reporting: costReports.length,
              providers: reports.length,
            }
          : undefined;

      // Surface the budget circuit breaker when it tripped: count the
      // providers it skipped and report the accumulated spend against the
      // budget ceiling.
      const budgetSkipped = effectiveReports.filter(
        (r) => r.status === 'skipped' && r.error === BUDGET_SKIP_REASON,
      ).length;
      const budgetReached =
        budget.limitUsd !== undefined && budgetSkipped > 0
          ? {
              reportedUsd: budget.spentUsd,
              budgetUsd: budget.limitUsd,
              skipped: budgetSkipped,
            }
          : undefined;

      // Pre-dispatch estimated cost across providers that actually launched and
      // produced a USD estimate (separate lane from reported cost; never mixed).
      // Skipped providers never ran, so their estimate is not counted.
      const estimateReports = reports.filter(
        (r) =>
          r.status !== 'skipped' &&
          typeof r.metering?.estimate?.estimatedCostUsd === 'number' &&
          Number.isFinite(r.metering.estimate.estimatedCostUsd),
      );
      const estimatedCost =
        estimateReports.length > 0
          ? {
              totalUsd: estimateReports.reduce(
                (sum, r) => sum + (r.metering?.estimate?.estimatedCostUsd ?? 0),
                0,
              ),
              estimating: estimateReports.length,
              providers: reports.length,
            }
          : undefined;

      // Surface the estimated-cost reservation breaker when it tripped.
      const estimateSkipped = effectiveReports.filter(
        (r) =>
          r.status === 'skipped' && r.error === ESTIMATE_BUDGET_SKIP_REASON,
      ).length;
      const estimatedBudgetReached =
        estimatedBudget.limitUsd !== undefined && estimateSkipped > 0
          ? {
              reservedUsd: estimatedBudget.reservedUsd,
              budgetUsd: estimatedBudget.limitUsd,
              skipped: estimateSkipped,
            }
          : undefined;

      for (const line of formatRunSummary({
        succeeded: successful.length,
        failed: failed.length,
        pending: pending.length,
        uniqueSources: sources.length,
        totalCitations,
        outputDir,
        color,
        totalDurationMs,
        reportedCost,
        budgetReached,
        estimatedCost,
        estimatedBudgetReached,
      })) {
        printLine(line);
      }

      let reportPath: string | null = null;
      if (opts.html) {
        reportPath = writeHtmlReport(outputDir);
        if (reportPath) {
          printLine(
            `  \u25b8 ${hyperlink(shortenHomePath(reportPath), fileUrl(reportPath), color)}`,
          );
        }
      }

      if (opts.jsonl) {
        const jsonlPath = writeJsonlReport(outputDir);
        if (jsonlPath) {
          printLine(
            `  \u25b8 ${hyperlink(shortenHomePath(jsonlPath), fileUrl(jsonlPath), color)}`,
          );
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(manifest, null, 2));
      }

      if (opts.open && exitCode !== 2) {
        openPath(reportPath ?? outputDir);
      }

      process.exitCode = exitCode;
      return { exitCode, outputDir };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      spinner.fail(message);
      process.exitCode = 2;
      return { exitCode: 2 };
    }
  }
}

export interface DispatchPresentation {
  spinner: { stop(): unknown };
  live: Pick<LiveRunTable, 'resolveRemaining' | 'stop'> | null;
  printLine: (line: string) => void;
  widths: LineWidths;
  color: boolean;
}

/** Finalize provider rows before artifacts and post-dispatch hooks can print. */
export function finalizeDispatchPresentation(
  reports: ProviderReport[],
  presentation: DispatchPresentation,
): void {
  presentation.spinner.stop();
  if (presentation.live) {
    presentation.live.resolveRemaining(reports);
    presentation.live.stop();
    return;
  }
  for (const report of reports) {
    if (report.status === 'skipped') {
      presentation.printLine(
        formatProviderLine(report, presentation.widths, presentation.color),
      );
    }
  }
}

/** Open a file or directory with the platform opener. Failures are silent. */
export function openPath(target: string): void {
  let command: string;
  let args: string[];
  if (process.platform === 'darwin') {
    command = 'open';
    args = [target];
  } else if (process.platform === 'win32') {
    // `start` is a cmd builtin; the empty string is the window title so
    // paths containing spaces are not mistaken for it.
    command = 'cmd';
    args = ['/c', 'start', '', target];
  } else {
    command = 'xdg-open';
    args = [target];
  }
  try {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Best-effort only.
  }
}
