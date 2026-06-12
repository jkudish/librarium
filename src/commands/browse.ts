import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as p from '@clack/prompts';
import type { Command } from 'commander';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import type { ProviderReport } from '../types.js';
import {
  describeRun,
  discoverRuns,
  extractPreview,
  type RunEntry,
  readRunEntry,
} from './browse-data.js';
import { writeHtmlReport } from './html-report.js';
import { computeLineWidths, formatProviderLine } from './run-format.js';

type NavResult = 'back' | 'quit';

export function registerBrowseCommand(program: Command): void {
  program
    .command('browse')
    .description('Browse past research runs and provider results')
    .option('-o, --output <dir>', 'Output base directory')
    .action(async (opts: { output?: string }) => {
      if (!process.stdout.isTTY || !process.stdin.isTTY) {
        console.error('librarium browse requires an interactive terminal.');
        process.exitCode = 1;
        return;
      }
      const config = mergeConfigs(
        loadConfig(),
        loadProjectConfig(process.cwd()),
      );
      const baseDir = resolve(opts.output ?? config.defaults.outputDir);
      await browseRuns(baseDir);
    });
}

/** Top-level loop: pick a run, drill in, repeat until quit. */
export async function browseRuns(baseDir: string): Promise<void> {
  const runs = discoverRuns(baseDir);
  if (runs.length === 0) {
    console.log(`No runs found in ${baseDir}`);
    return;
  }

  p.intro('librarium browse');
  for (;;) {
    const choice = await p.select<RunEntry | 'quit'>({
      message: `Recent runs (${baseDir})`,
      options: [
        ...runs.map((entry) => {
          const { label, hint } = describeRun(entry);
          return { value: entry, label, hint };
        }),
        { value: 'quit' as const, label: 'quit' },
      ],
    });
    if (p.isCancel(choice) || choice === 'quit') break;
    const nav = await browseRun(choice);
    if (nav === 'quit') break;
  }
  p.outro('done');
}

/** Browse a single run directory directly (used by the wizard post-run offer). */
export async function browseRunDir(dir: string): Promise<void> {
  const entry = readRunEntry(dir);
  if (!entry) {
    console.log(`No run manifest found in ${dir}`);
    return;
  }
  await browseRun(entry);
}

/** Run view: provider list rendered with the run table line format. */
async function browseRun(entry: RunEntry): Promise<NavResult> {
  const reports = entry.manifest.providers;
  const widths = computeLineWidths(
    reports.map((r) => r.id),
    reports.map((r) => r.tier),
  );

  for (;;) {
    type Choice = ProviderReport | 'summary' | 'html' | 'back' | 'quit';
    const choice = await p.select<Choice>({
      message: entry.manifest.query,
      options: [
        ...reports.map((report) => ({
          value: report as Choice,
          // Plain (uncolored) table line; clack applies its own active/dim styling.
          label: formatProviderLine(report, widths, false).trimStart(),
        })),
        { value: 'summary' as const, label: 'open summary.md' },
        { value: 'html' as const, label: 'export HTML report' },
        { value: 'back' as const, label: 'back' },
        { value: 'quit' as const, label: 'quit' },
      ],
    });
    if (p.isCancel(choice) || choice === 'quit') return 'quit';
    if (choice === 'back') return 'back';
    if (choice === 'summary') {
      openInPager(join(entry.dir, 'summary.md'));
      continue;
    }
    if (choice === 'html') {
      const reportPath = writeHtmlReport(entry.dir);
      if (reportPath) {
        p.log.success(`Wrote ${reportPath}`);
      } else {
        p.log.warn('Could not generate report (missing run.json).');
      }
      continue;
    }
    const nav = await providerView(entry, choice);
    if (nav === 'quit') return 'quit';
  }
}

/** Provider view: inline preview plus actions. */
async function providerView(
  entry: RunEntry,
  report: ProviderReport,
): Promise<NavResult> {
  const filePath = report.outputFile
    ? join(entry.dir, report.outputFile)
    : null;

  if (!filePath || !existsSync(filePath)) {
    const note =
      report.status === 'async-pending'
        ? 'Result not retrieved yet: run `librarium status --wait` to poll and retrieve.'
        : 'No output file recorded for this provider.';
    p.log.warn(note);
    return 'back';
  }

  const content = readFileSync(filePath, 'utf-8');
  p.note(extractPreview(content).join('\n'), report.id);

  for (;;) {
    const action = await p.select<'pager' | 'back' | 'quit'>({
      message: report.outputFile,
      options: [
        { value: 'pager', label: 'open full file in pager' },
        { value: 'back', label: 'back' },
        { value: 'quit', label: 'quit' },
      ],
    });
    if (p.isCancel(action) || action === 'quit') return 'quit';
    if (action === 'back') return 'back';
    openInPager(filePath);
  }
}

/** Open a file in $PAGER (fallback `less -R`), blocking until it exits. */
function openInPager(filePath: string): void {
  if (!existsSync(filePath)) {
    p.log.warn(`File not found: ${filePath}`);
    return;
  }
  const pagerEnv = process.env.PAGER?.trim();
  const parts =
    pagerEnv && pagerEnv.length > 0 ? pagerEnv.split(/\s+/) : ['less', '-R'];
  const [command, ...args] = parts as [string, ...string[]];
  const result = spawnSync(command, [...args, filePath], { stdio: 'inherit' });
  if (result.error) {
    p.log.warn(`Could not open pager (${command}): ${result.error.message}`);
  }
}
