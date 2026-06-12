import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import ora from 'ora';
import {
  getAllProviders,
  initializeProviders,
} from '../adapters/node-registry.js';
import { resolveProviderIds } from '../constants.js';
import { saveAsyncTasks } from '../core/async-manager.js';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import { dispatch } from '../core/dispatcher.js';
import { safeWriteFile } from '../core/fs-utils.js';
import { deduplicateSources } from '../core/normalizer.js';
import {
  buildPrompt,
  generateSlug,
  resolveOutputDir,
} from '../core/prompt-builder.js';
import { generateSummary } from '../core/synthesis.js';
import type {
  Citation,
  Defaults,
  ProviderDispatchResult,
  ProviderReport,
  ProviderTier,
  RunManifest,
} from '../types.js';
import { writeHtmlReport } from './html-report.js';
import { LiveRunTable } from './live-table.js';
import { type RefinedQueries, refineQuery } from './refine.js';
import {
  computeLineWidths,
  dimText,
  formatFallbackNotice,
  formatProviderLine,
  formatRunSummary,
  isColorEnabled,
  shortenHomePath,
} from './run-format.js';

export interface RunOptions {
  providers?: string[];
  group?: string;
  mode?: 'sync' | 'async' | 'mixed';
  output?: string;
  parallel?: number;
  timeout?: number;
  json?: boolean;
  open?: boolean;
  html?: boolean;
  refine?: boolean;
}

export interface RunOutcome {
  exitCode: number;
  outputDir?: string;
}

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run a research query across multiple providers')
    .argument('<query>', 'The research query')
    .option(
      '-p, --providers <ids>',
      'Comma-separated provider IDs',
      (v: string) => v.split(','),
    )
    .option('-g, --group <name>', 'Use a predefined provider group')
    .option('-m, --mode <mode>', 'Execution mode: sync, async, or mixed')
    .option('-o, --output <dir>', 'Output base directory')
    .option('--parallel <n>', 'Max parallel requests', Number.parseInt)
    .option('--timeout <n>', 'Timeout per provider in seconds', Number.parseInt)
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

    try {
      const globalConfig = loadConfig();
      const projectConfig = loadProjectConfig(process.cwd());
      const cliFlags: Partial<Defaults> = {};
      if (opts.output) cliFlags.outputDir = opts.output;
      if (opts.parallel) cliFlags.maxParallel = opts.parallel;
      if (opts.timeout) cliFlags.timeout = opts.timeout;
      if (opts.mode) cliFlags.mode = opts.mode;

      const config = mergeConfigs(globalConfig, projectConfig, cliFlags);
      const credentials = { env: process.env };
      const initResult = await initializeProviders({
        ...config,
        credentials,
      });
      for (const warning of initResult.warnings) {
        console.error(`[librarium] warning: ${warning}`);
      }

      // Resolve provider list
      let providerIds: string[];
      if (opts.providers) {
        providerIds = resolveProviderIds(opts.providers);
      } else if (opts.group) {
        const group = config.groups[opts.group];
        if (!group) {
          spinner.fail(`Unknown group: ${opts.group}`);
          process.exitCode = 2;
          return { exitCode: 2 };
        }
        providerIds = resolveProviderIds(group);
      } else {
        // Default: use all enabled providers
        providerIds = resolveProviderIds(
          Object.entries(config.providers)
            .filter(([, p]) => p.enabled)
            .map(([id]) => id),
        );
      }

      if (providerIds.length === 0) {
        spinner.fail(
          'No providers selected. Run `librarium init` to configure providers.',
        );
        process.exitCode = 2;
        return { exitCode: 2 };
      }

      const availableProviderIds = new Set(
        getAllProviders().map((provider) => provider.id),
      );
      const unavailableProviders = providerIds.filter(
        (id) => !availableProviderIds.has(id),
      );
      if (unavailableProviders.length > 0) {
        console.error(
          `[librarium] warning: Provider(s) not registered and will be skipped: ${unavailableProviders.join(', ')}`,
        );
        providerIds = providerIds.filter((id) => availableProviderIds.has(id));
      }

      if (providerIds.length === 0) {
        spinner.fail(
          'No valid providers selected after validation. Check provider trust/availability in config.',
        );
        process.exitCode = 2;
        return { exitCode: 2 };
      }

      // Optional one-shot LLM refine: never allowed to break the run.
      let refined: RefinedQueries | null = null;
      if (opts.refine) {
        spinner.start('Refining query...');
        try {
          refined = await refineQuery(query, config);
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

      // Write prompt (with refined variants recorded for reproducibility)
      let promptDoc = buildPrompt(query);
      if (refined) {
        promptDoc += `\n\n## Refined Query Variants\n\n- deep-research: ${refined.tierQueries['deep-research']}\n- ai-grounded: ${refined.tierQueries['ai-grounded']}\n- raw-search: ${refined.tierQueries['raw-search']}\n`;
      }
      safeWriteFile(join(outputDir, 'prompt.md'), promptDoc);

      // Column widths cover both primaries and any configured fallbacks so
      // lines stay aligned if a fallback fires mid-run.
      const tierById = new Map<string, ProviderTier>(
        getAllProviders().map((provider) => [provider.id, provider.tier]),
      );
      const fallbackIds = providerIds
        .map((id) => config.providers[id]?.fallback)
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

      const dispatchStartedAt = Date.now();
      const { reports, results, asyncTasks } = await dispatch({
        config,
        providerIds,
        query,
        tierQueries: refined?.tierQueries,
        mode: config.defaults.mode,
        credentials,
        onProgress: (event) => {
          if (live) {
            switch (event.event) {
              case 'started':
                live.markStarted(event.providerId);
                break;
              case 'fallback-started':
                live.addFallback(
                  event.report?.id ?? event.providerId,
                  event.providerId,
                  tierById.get(event.providerId) ?? 'raw-search',
                );
                break;
              case 'completed':
              case 'error':
              case 'async-submitted':
                if (event.report) live.resolve(event.report);
                break;
            }
            return;
          }
          switch (event.event) {
            case 'started':
              running.add(event.providerId);
              break;
            case 'fallback-started':
              printLine(formatFallbackNotice(event.providerId, color));
              running.add(event.providerId);
              break;
            case 'completed':
            case 'error':
            case 'async-submitted':
              running.delete(event.providerId);
              if (event.report) {
                printLine(formatProviderLine(event.report, widths, color));
              }
              break;
          }
          spinner.text = spinnerText();
        },
      });
      const totalDurationMs = Date.now() - dispatchStartedAt;

      spinner.stop();

      if (live) {
        // Rows that never emitted events (e.g. skipped providers) resolve
        // from the final reports before the block is finalized.
        live.resolveRemaining(reports);
        live.stop();
      } else {
        // Skipped providers never emit progress events — show them too.
        for (const report of reports) {
          if (report.status === 'skipped') {
            printLine(formatProviderLine(report, widths, color));
          }
        }
      }

      writeProviderOutputs(outputDir, reports, results);

      // Collect all citations for dedup
      const allCitations: Citation[] = results.flatMap((result) =>
        result.status === 'success' ? result.citations : [],
      );

      const sources = deduplicateSources(allCitations);

      // Write sources.json
      safeWriteFile(
        join(outputDir, 'sources.json'),
        JSON.stringify(sources, null, 2),
      );

      // Write async tasks
      if (asyncTasks.length > 0) {
        for (const task of asyncTasks) {
          task.outputDir = outputDir;
        }
        saveAsyncTasks(outputDir, asyncTasks);
      }

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
      const successCount = effectiveReports.filter(
        (r) => r.status === 'success' || r.status === 'async-pending',
      ).length;
      const exitCode =
        successCount === 0 ? 2 : successCount < effectiveReports.length ? 1 : 0;

      // Write run manifest
      const timestamp = Math.floor(Date.now() / 1000);
      const manifest: RunManifest = {
        version: 1,
        timestamp,
        slug,
        query,
        mode: config.defaults.mode,
        outputDir,
        providers: reports,
        sources: {
          total: allCitations.length,
          unique: sources.length,
          file: 'sources.json',
        },
        asyncTasks,
        exitCode,
        refinedQueries: refined?.tierQueries,
      };
      safeWriteFile(
        join(outputDir, 'run.json'),
        JSON.stringify(manifest, null, 2),
      );

      // Write summary
      const summary = generateSummary({
        query,
        reports,
        sources,
        asyncTasks,
        timestamp,
      });
      safeWriteFile(join(outputDir, 'summary.md'), summary);

      // Print summary (exclude recovered primaries so they don't show as failures)
      const successful = effectiveReports.filter((r) => r.status === 'success');
      const failed = effectiveReports.filter((r) => r.status === 'error');
      const pending = effectiveReports.filter(
        (r) => r.status === 'async-pending',
      );
      // Total API-reported cost across providers that reported one.
      const costReports = effectiveReports.filter(
        (r) => r.usage?.costUsd !== undefined,
      );
      const reportedCost =
        costReports.length > 0
          ? {
              totalUsd: costReports.reduce(
                (sum, r) => sum + (r.usage?.costUsd ?? 0),
                0,
              ),
              reporting: costReports.length,
              providers: effectiveReports.length,
            }
          : undefined;

      for (const line of formatRunSummary({
        succeeded: successful.length,
        failed: failed.length,
        pending: pending.length,
        uniqueSources: sources.length,
        totalCitations: allCitations.length,
        outputDir,
        color,
        totalDurationMs,
        reportedCost,
      })) {
        printLine(line);
      }

      let reportPath: string | null = null;
      if (opts.html) {
        reportPath = writeHtmlReport(outputDir);
        if (reportPath) {
          printLine(`  \u25b8 ${shortenHomePath(reportPath)}`);
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
      spinner.fail(e instanceof Error ? e.message : String(e));
      process.exitCode = 2;
      return { exitCode: 2 };
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

function writeProviderOutputs(
  outputDir: string,
  reports: ProviderReport[],
  results: ProviderDispatchResult[],
): void {
  for (const result of results) {
    const report = reports.find(
      (candidate) =>
        candidate.id === result.provider &&
        candidate.fallbackFor === result.fallbackFor,
    );
    if (!report?.outputFile || !report.metaFile) continue;

    safeWriteFile(join(outputDir, report.outputFile), result.text);
    safeWriteFile(
      join(outputDir, report.metaFile),
      JSON.stringify(
        {
          provider: result.provider,
          tier: result.tier,
          model: result.model,
          durationMs: result.durationMs,
          citationCount: result.citations.length,
          tokenUsage: result.tokenUsage,
          usage: result.usage,
          citations: result.citations,
        },
        null,
        2,
      ),
    );
  }
}
