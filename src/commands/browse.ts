import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import type { Command } from 'commander';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import { RunArtifactRepository } from '../node-run-artifacts.js';
import type { ProviderReport } from '../types.js';
import {
  type BrowseProviderPresentation,
  describeRun,
  discoverRuns,
  type RunEntry,
  readRunEntry,
  readRunSnapshot,
  shapeBrowseRunSnapshot,
} from './browse-data.js';
import { writeHtmlReport } from './html-report-v2.js';
import { writeJsonlReport } from './jsonl-report-v2.js';
import { renderMarkdownAnsi } from './markdown-ansi.js';
import { runPager } from './pager.js';
import { openPath } from './run.js';
import {
  computeLineWidths,
  fileUrl,
  formatProviderLine,
  hyperlink,
  isColorEnabled,
} from './run-format.js';

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
export async function browseRuns(
  baseDir: string,
  repository: RunArtifactRepository = new RunArtifactRepository(),
): Promise<void> {
  const runs = discoverRuns(baseDir, 20, repository);
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
    const nav = await browseRun(choice, repository);
    if (nav === 'quit') break;
  }
  p.outro('done');
}

/** Browse a single run directory directly (used by the wizard post-run offer). */
export async function browseRunDir(
  dir: string,
  repository: RunArtifactRepository = new RunArtifactRepository(),
): Promise<void> {
  const entry = readRunEntry(dir, repository);
  if (!entry) {
    console.log(`No run manifest found in ${dir}`);
    return;
  }
  await browseRun(entry, repository);
}

/** Run view: provider list rendered with the run table line format. */
async function browseRun(
  entry: RunEntry,
  repository: RunArtifactRepository,
): Promise<NavResult> {
  const snapshot = readRunSnapshot(entry.dir, repository);
  if (!snapshot) {
    p.log.warn(`Could not read run artifacts in ${entry.dir}`);
    return 'back';
  }
  const presentation = shapeBrowseRunSnapshot(snapshot);
  const reports = presentation.providers.map(({ report }) => report);
  const widths = computeLineWidths(
    reports.map((r) => r.id),
    reports.map((r) => r.tier),
  );

  for (;;) {
    type Choice =
      | ProviderReport
      | 'summary'
      | 'html'
      | 'jsonl'
      | 'back'
      | 'quit';
    const choice = await p.select<Choice>({
      message: snapshot.manifest.query,
      options: [
        ...reports.map((report) => ({
          value: report as Choice,
          // Plain (uncolored) table line; clack applies its own active/dim styling.
          label: formatProviderLine(report, widths, false).trimStart(),
        })),
        { value: 'summary' as const, label: 'open summary.md' },
        { value: 'html' as const, label: 'export HTML report' },
        { value: 'jsonl' as const, label: 'export JSONL' },
        { value: 'back' as const, label: 'back' },
        { value: 'quit' as const, label: 'quit' },
      ],
    });
    if (p.isCancel(choice) || choice === 'quit') return 'quit';
    if (choice === 'back') return 'back';
    if (choice === 'summary') {
      if (snapshot.summary === undefined) {
        p.log.warn(
          `File not found: ${repository.resolveContainedPath(snapshot.runDir, 'summary.md')}`,
        );
        continue;
      }
      await viewMarkdownInPager(
        snapshot.summary,
        'summary.md',
        repository.resolveContainedPath(snapshot.runDir, 'summary.md'),
      );
      continue;
    }
    if (choice === 'html') {
      const reportPath = writeHtmlReport(entry.dir, repository);
      if (reportPath) {
        p.log.success(
          `Wrote ${hyperlink(reportPath, fileUrl(reportPath), isColorEnabled(process.stdout))}`,
        );
        const open = await p.confirm({
          message: 'Open it in your browser?',
          initialValue: true,
        });
        if (!p.isCancel(open) && open) openPath(reportPath);
      } else {
        p.log.warn('Could not generate report (missing run.json).');
      }
      continue;
    }
    if (choice === 'jsonl') {
      const jsonlPath = writeJsonlReport(entry.dir, repository);
      if (jsonlPath) {
        p.log.success(
          `Wrote ${hyperlink(jsonlPath, fileUrl(jsonlPath), isColorEnabled(process.stdout))}`,
        );
      } else {
        p.log.warn('Could not generate JSONL (missing run.json).');
      }
      continue;
    }
    const provider = presentation.providers.find(
      ({ report }) => report.id === choice.id,
    );
    if (!provider) continue;
    const nav = await providerView(snapshot.runDir, provider, repository);
    if (nav === 'quit') return 'quit';
  }
}

/** Provider view: fullscreen pager over the ANSI-rendered markdown. */
async function providerView(
  runDir: string,
  presentation: BrowseProviderPresentation,
  repository: RunArtifactRepository,
): Promise<NavResult> {
  const { report, content } = presentation;

  if (content === undefined || !report.outputFile) {
    const note =
      report.status === 'async-pending'
        ? 'Result not retrieved yet: run `librarium status --wait` to poll and retrieve.'
        : 'No output file recorded for this provider.';
    p.log.warn(note);
    return 'back';
  }

  await viewMarkdownInPager(
    content,
    report.id,
    repository.resolveContainedPath(runDir, report.outputFile),
  );
  return 'back';
}

/** Content wider than this is wrapped to a readable column anyway. */
const MAX_READING_WIDTH = 100;

/** Open a markdown file in the fullscreen pager (o opens the raw file in $PAGER). */
async function viewMarkdownInPager(
  content: string,
  title: string,
  filePath?: string,
): Promise<void> {
  const color = isColorEnabled(process.stdout);
  await runPager({
    title,
    filePath,
    render: (width) =>
      renderMarkdownAnsi(content, {
        color,
        width: Math.min(Math.max(20, width), MAX_READING_WIDTH),
      }).split('\n'),
  });
}
