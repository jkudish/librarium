import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import type { Command } from 'commander';
import { parsePositiveDays } from '../cli-parsers.js';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import { formatRunDate } from './browse-data.js';
import {
  type CleanupCandidate,
  discoverCandidates,
  formatSize,
  isInsideBaseDir,
  summarizeCandidates,
  unsafeBaseDirReason,
} from './cleanup-data.js';

interface CleanupOptions {
  days: number;
  all?: boolean;
  dryRun?: boolean;
  interactive?: boolean;
  yes?: boolean;
  json?: boolean;
  output?: string;
}

export function registerCleanupCommand(program: Command): void {
  program
    .command('cleanup')
    .description(
      'Remove output directories (old by default, or all with --all)',
    )
    .option(
      '--days <n>',
      'Age threshold in days (default: 30)',
      parsePositiveDays,
      30,
    )
    .option('--all', 'Delete every run directory regardless of age')
    .option('-i, --interactive', 'Pick which runs to delete from a list')
    .option('--dry-run', 'Show what would be deleted without deleting')
    .option(
      '--yes',
      'Skip the confirmation prompt (required for --all in non-TTY)',
    )
    .option('-o, --output <dir>', 'Output base directory')
    .option('--json', 'Output JSON')
    .action(async (opts: CleanupOptions) => {
      await runCleanup(opts);
    });

  // `clear` is an alias for `cleanup --all`: one implementation, two names.
  program
    .command('clear')
    .description('Delete all run directories (alias for `cleanup --all`)')
    .option('-i, --interactive', 'Pick which runs to delete from a list')
    .option('--dry-run', 'Show what would be deleted without deleting')
    .option('--yes', 'Skip the confirmation prompt (required in non-TTY)')
    .option('-o, --output <dir>', 'Output base directory')
    .option('--json', 'Output JSON')
    .action(async (opts: Omit<CleanupOptions, 'days' | 'all'>) => {
      await runCleanup({ ...opts, all: true, days: 30 });
    });
}

async function runCleanup(opts: CleanupOptions): Promise<void> {
  try {
    const globalConfig = loadConfig();
    const projectConfig = loadProjectConfig(process.cwd());
    const config = mergeConfigs(globalConfig, projectConfig);
    const baseDir = resolve(opts.output ?? config.defaults.outputDir);

    // Safety: never operate on HOME or a filesystem root.
    const unsafe = unsafeBaseDirReason(baseDir);
    if (unsafe) {
      printError(opts, unsafe);
      process.exitCode = 1;
      return;
    }

    const all = !!opts.all || !!opts.interactive;
    const candidates = discoverCandidates(baseDir, { all, days: opts.days });

    if (candidates.length === 0) {
      const msg = opts.all
        ? 'No run directories found.'
        : `No output directories older than ${opts.days} days.`;
      if (opts.json) {
        console.log(JSON.stringify({ deleted: [], message: msg }));
      } else {
        console.log(msg);
      }
      return;
    }

    // Interactive selection takes precedence over bulk delete.
    if (opts.interactive) {
      await runInteractive(baseDir, candidates, opts);
      return;
    }

    if (opts.json) {
      handleJson(baseDir, candidates, opts);
      return;
    }

    const summary = summarizeCandidates(candidates);

    if (opts.dryRun) {
      console.log(
        `\nWould delete ${summary.count} ${plural(summary.count, 'directory', 'directories')} (${formatSize(summary.totalSize)}):\n`,
      );
      for (const c of candidates) {
        console.log(`  ${describeLine(c)}`);
      }
      if (summary.oldest && summary.newest) {
        console.log(
          `\nOldest: ${formatRunDate(summary.oldest.timeMs / 1000)}  Newest: ${formatRunDate(summary.newest.timeMs / 1000)}`,
        );
      }
      if (summary.pendingAsyncCount > 0) {
        console.log(
          `\nNote: ${summary.pendingAsyncCount} ${plural(summary.pendingAsyncCount, 'run has', 'runs have')} pending async tasks (deleting orphans the server-side task handle).`,
        );
      }
      console.log('\nRun without --dry-run to delete.');
      return;
    }

    // Destructive bulk delete. With --all, require an interactive confirm in a
    // TTY or an explicit --yes in non-TTY.
    if (opts.all && !opts.yes) {
      if (process.stdout.isTTY && process.stdin.isTTY) {
        const ok = await confirmDelete(summary);
        if (!ok) {
          console.log('Aborted.');
          return;
        }
      } else {
        printError(
          opts,
          'Refusing to delete all runs without confirmation. Re-run with --yes (or use --dry-run to preview).',
        );
        process.exitCode = 1;
        return;
      }
    }

    deleteCandidates(baseDir, candidates, summary, opts);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}

/** Interactive multiselect of runs, then confirm + delete the chosen ones. */
async function runInteractive(
  baseDir: string,
  candidates: CleanupCandidate[],
  opts: CleanupOptions,
): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    printError(
      opts,
      'Interactive selection (-i) requires an interactive terminal.',
    );
    process.exitCode = 1;
    return;
  }

  p.intro('librarium clear');
  const selected = await p.multiselect<string>({
    message: `Select runs to delete (${baseDir})`,
    options: candidates.map((c) => ({
      value: c.dir,
      label: describeLine(c),
      hint: c.pendingAsync
        ? 'pending async tasks: deleting orphans the task handle'
        : undefined,
    })),
    required: false,
  });

  if (p.isCancel(selected) || selected.length === 0) {
    p.outro('Nothing selected.');
    return;
  }

  const chosen = candidates.filter((c) => selected.includes(c.dir));
  const summary = summarizeCandidates(chosen);
  const ok = await confirmDelete(summary);
  if (!ok) {
    p.outro('Aborted.');
    return;
  }

  let freed = 0;
  let count = 0;
  for (const c of chosen) {
    if (!isInsideBaseDir(baseDir, c.dir)) continue;
    rmSync(c.dir, { recursive: true, force: true, maxRetries: 3 });
    freed += c.size;
    count += 1;
  }
  p.outro(
    `Deleted ${count} ${plural(count, 'directory', 'directories')}, freed ${formatSize(freed)}.`,
  );
}

/** clack confirm that surfaces count, total size, and pending-async warnings. */
async function confirmDelete(summary: {
  count: number;
  totalSize: number;
  pendingAsyncCount: number;
}): Promise<boolean> {
  if (summary.pendingAsyncCount > 0) {
    p.log.warn(
      `${summary.pendingAsyncCount} ${plural(summary.pendingAsyncCount, 'run has', 'runs have')} pending async tasks. Deleting orphans the server-side task handle.`,
    );
  }
  const answer = await p.confirm({
    message: `Delete ${summary.count} ${plural(summary.count, 'directory', 'directories')} (${formatSize(summary.totalSize)})? This cannot be undone.`,
    initialValue: false,
  });
  return !p.isCancel(answer) && answer === true;
}

function deleteCandidates(
  baseDir: string,
  candidates: CleanupCandidate[],
  summary: { count: number; totalSize: number },
  _opts: CleanupOptions,
): void {
  console.log(
    `\nDeleting ${summary.count} ${plural(summary.count, 'directory', 'directories')} (${formatSize(summary.totalSize)})...\n`,
  );
  let freed = 0;
  for (const c of candidates) {
    if (!isInsideBaseDir(baseDir, c.dir)) {
      console.warn(`  Skipped (outside base dir): ${c.dir}`);
      continue;
    }
    rmSync(c.dir, { recursive: true, force: true, maxRetries: 3 });
    freed += c.size;
    console.log(`  Deleted: ${c.dir} (${c.ageDays}d old)`);
  }
  console.log(`\nCleanup complete. Freed ${formatSize(freed)}.`);
}

function handleJson(
  baseDir: string,
  candidates: CleanupCandidate[],
  opts: CleanupOptions,
): void {
  let freed = 0;
  const safe: CleanupCandidate[] = [];
  for (const c of candidates) {
    if (!isInsideBaseDir(baseDir, c.dir)) continue;
    safe.push(c);
  }
  if (!opts.dryRun) {
    for (const c of safe) {
      rmSync(c.dir, { recursive: true, force: true, maxRetries: 3 });
      freed += c.size;
    }
  }
  console.log(
    JSON.stringify(
      {
        dryRun: !!opts.dryRun,
        freedBytes: opts.dryRun ? 0 : freed,
        deleted: safe.map((c) => ({
          path: c.dir,
          age: `${c.ageDays}d`,
          sizeBytes: c.size,
          query: c.query,
          pendingAsync: c.pendingAsync,
        })),
      },
      null,
      2,
    ),
  );
}

function describeLine(c: CleanupCandidate): string {
  const query = c.query ? truncate(c.query, 50) : '(no manifest)';
  const flag = c.pendingAsync ? ' [pending async]' : '';
  return `${formatRunDate(c.timeMs / 1000)}  ${query}  (${c.ageDays}d, ${formatSize(c.size)})${flag}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function printError(opts: CleanupOptions, message: string): void {
  if (opts.json) {
    console.log(JSON.stringify({ error: message }));
  } else {
    console.error(message);
  }
}
