import { resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import { discoverRuns } from './browse-data.js';
import { writeJsonlReport } from './jsonl-report.js';
import { fileUrl, hyperlink, isColorEnabled } from './run-format.js';

export function registerJsonlCommand(program: Command): void {
  program
    .command('jsonl [run-dir]')
    .description(
      'Generate a results.jsonl for a run directory (default: most recent run)',
    )
    .action(async (runDir: string | undefined) => {
      let dir = runDir ? resolve(runDir) : undefined;
      if (!dir) {
        const config = mergeConfigs(
          loadConfig(),
          loadProjectConfig(process.cwd()),
        );
        const runs = discoverRuns(resolve(config.defaults.outputDir), 1);
        dir = runs[0]?.dir;
      }
      if (!dir) {
        console.error('No runs found. Run `librarium run` first.');
        process.exitCode = 2;
        return;
      }
      const reportPath = writeJsonlReport(dir);
      if (!reportPath) {
        console.error(`No run manifest (run.json) found in ${dir}`);
        process.exitCode = 2;
        return;
      }
      console.log(
        hyperlink(
          reportPath,
          fileUrl(reportPath),
          isColorEnabled(process.stdout),
        ),
      );
    });
}
