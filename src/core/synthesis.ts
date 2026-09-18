import type {
  AsyncTaskHandle,
  DeduplicatedSource,
  ProviderReport,
} from '../types.js';

export interface SynthesisOptions {
  query: string;
  reports: ProviderReport[];
  sources: DeduplicatedSource[];
  asyncTasks: AsyncTaskHandle[];
  timestamp: number;
}

export function generateSummary(options: SynthesisOptions): string {
  const { query, reports, sources, asyncTasks, timestamp } = options;
  const lines: string[] = [];

  lines.push('# Research Summary');
  lines.push('');
  lines.push(`**Query:** ${query}`);
  lines.push(`**Date:** ${new Date(timestamp * 1000).toISOString()}`);
  lines.push('');

  // Run stats
  const successful = reports.filter((r) => r.status === 'success');
  const failed = reports.filter((r) => r.status === 'error');
  const pending = reports.filter((r) => r.status === 'async-pending');
  const totalDuration = Math.max(
    ...reports.filter((r) => r.durationMs > 0).map((r) => r.durationMs),
    0,
  );

  lines.push('## Run Statistics');
  lines.push('');
  lines.push(`- **Providers queried:** ${reports.length}`);
  lines.push(`- **Successful:** ${successful.length}`);
  if (failed.length > 0) lines.push(`- **Failed:** ${failed.length}`);
  if (pending.length > 0) lines.push(`- **Async pending:** ${pending.length}`);
  lines.push(`- **Total duration:** ${(totalDuration / 1000).toFixed(1)}s`);
  lines.push(`- **Unique sources:** ${sources.length}`);
  lines.push('');

  // Per-provider summaries
  lines.push('## Provider Results');
  lines.push('');

  for (const report of reports) {
    const statusIcon =
      report.status === 'success'
        ? 'OK'
        : report.status === 'async-pending'
          ? 'PENDING'
          : report.status === 'skipped'
            ? 'SKIP'
            : 'FAIL';
    lines.push(`### ${report.id} [${statusIcon}]`);
    lines.push('');
    if (report.status === 'success') {
      lines.push(`- **Duration:** ${(report.durationMs / 1000).toFixed(1)}s`);
      lines.push(`- **Words:** ${report.wordCount}`);
      lines.push(`- **Citations:** ${report.citationCount}`);
      lines.push(`- **Output:** ${report.outputFile}`);
    } else if (report.status === 'async-pending') {
      lines.push(
        '- *Async task submitted, use `librarium status` to check progress*',
      );
    } else if (report.error) {
      lines.push(`- **Error:** ${report.error}`);
    }
    lines.push('');
  }

  // Top sources
  if (sources.length > 0) {
    lines.push('## Top Sources');
    lines.push('');
    const topSources = sources.slice(0, 20);
    for (const source of topSources) {
      const title = source.title || source.url;
      const providers = source.providers.join(', ');
      lines.push(
        `- [${title}](${source.url}) — cited by ${providers} (${source.citationCount}x)`,
      );
    }
    lines.push('');
  }

  // Async tasks
  if (asyncTasks.length > 0) {
    lines.push('## Pending Async Tasks');
    lines.push('');
    for (const task of asyncTasks) {
      lines.push(
        `- **${task.provider}** — Task ID: \`${task.taskId}\`, Status: ${task.status}`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}
