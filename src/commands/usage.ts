import { resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import { formatRunDate } from './browse-data.js';
import { formatCost, formatTokens } from './run-format.js';
import { aggregateUsage, type UsageAggregate } from './usage-data.js';

interface UsageOptions {
  days?: number;
  json?: boolean;
  output?: string;
}

export function registerUsageCommand(program: Command): void {
  program
    .command('usage')
    .description('Aggregate API-reported cost and tokens across past runs')
    .option(
      '--days <n>',
      'Only include runs from the last N days',
      Number.parseInt,
    )
    .option('--json', 'Output JSON')
    .option('-o, --output <dir>', 'Output base directory')
    .action((opts: UsageOptions) => {
      try {
        const globalConfig = loadConfig();
        const projectConfig = loadProjectConfig(process.cwd());
        const config = mergeConfigs(globalConfig, projectConfig);
        const baseDir = resolve(opts.output ?? config.defaults.outputDir);

        const aggregate = aggregateUsage(baseDir, { days: opts.days });

        if (opts.json) {
          console.log(JSON.stringify(aggregate, null, 2));
          return;
        }

        for (const line of formatUsageReport(aggregate, opts.days)) {
          console.log(line);
        }
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });
}

/**
 * Render the usage aggregate as a simple aligned table. Pure string output so
 * it stays testable. Only API-reported costs appear here (honest data).
 */
export function formatUsageReport(
  aggregate: UsageAggregate,
  days?: number,
): string[] {
  const lines: string[] = [''];

  if (aggregate.runCount === 0) {
    lines.push(
      days !== undefined
        ? `No runs found in the last ${days} ${days === 1 ? 'day' : 'days'}.`
        : 'No runs found.',
    );
    return lines;
  }

  const scope =
    days !== undefined
      ? `last ${days} ${days === 1 ? 'day' : 'days'}`
      : 'all runs';
  lines.push(`Usage (${scope}):`);
  lines.push('');

  // Provider table.
  const header = ['provider', 'cost', 'tokens', 'runs'];
  const rows = aggregate.providers.map((p) => [
    p.provider,
    p.reportedCost ? formatCost(p.costUsd) : '-',
    p.totalTokens > 0 ? formatTokens(p.totalTokens) : '-',
    String(p.runCount),
  ]);

  const widths = header.map((h, col) =>
    Math.max(h.length, ...rows.map((r) => r[col].length)),
  );
  const pad = (value: string, col: number): string =>
    col === 0 ? value.padEnd(widths[col]) : value.padStart(widths[col]);

  lines.push(`  ${header.map((h, col) => pad(h, col)).join('  ')}`);
  lines.push(`  ${widths.map((w) => '-'.repeat(w)).join('  ')}`);
  for (const row of rows) {
    lines.push(`  ${row.map((value, col) => pad(value, col)).join('  ')}`);
  }

  lines.push('');
  lines.push(`  runs: ${aggregate.runCount}`);
  lines.push(`  total reported cost: ${formatCost(aggregate.totalCostUsd)}`);
  if (aggregate.range) {
    lines.push(
      `  date range: ${formatRunDate(aggregate.range.fromSeconds)} to ${formatRunDate(aggregate.range.toSeconds)}`,
    );
  }
  if (aggregate.runsWithoutUsage > 0) {
    lines.push(
      `  ${aggregate.runsWithoutUsage} of ${aggregate.runCount} ${aggregate.runCount === 1 ? 'run' : 'runs'} had no reported usage`,
    );
  }

  return lines;
}
