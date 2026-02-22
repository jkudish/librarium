import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import ora from 'ora';
import { initializeProviders } from '../adapters/index.js';
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
import type { Citation, Defaults, RunManifest } from '../types.js';

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
    .action(async (query: string, opts) => {
      const spinner = ora('Initializing providers...').start();

      try {
        await initializeProviders();

        const globalConfig = loadConfig();
        const projectConfig = loadProjectConfig(process.cwd());
        const cliFlags: Partial<Defaults> = {};
        if (opts.output) cliFlags.outputDir = opts.output;
        if (opts.parallel) cliFlags.maxParallel = opts.parallel;
        if (opts.timeout) cliFlags.timeout = opts.timeout;
        if (opts.mode) cliFlags.mode = opts.mode;

        const config = mergeConfigs(globalConfig, projectConfig, cliFlags);

        // Resolve provider list
        let providerIds: string[];
        if (opts.providers) {
          providerIds = opts.providers;
        } else if (opts.group) {
          const group = config.groups[opts.group];
          if (!group) {
            spinner.fail(`Unknown group: ${opts.group}`);
            process.exitCode = 2;
            return;
          }
          providerIds = group;
        } else {
          // Default: use all enabled providers
          providerIds = Object.entries(config.providers)
            .filter(([, p]) => p.enabled)
            .map(([id]) => id);
        }

        if (providerIds.length === 0) {
          spinner.fail(
            'No providers selected. Run `librarium init` to configure providers.',
          );
          process.exitCode = 2;
          return;
        }

        // Create output directory
        const slug = generateSlug(query);
        const baseDir = resolve(config.defaults.outputDir);
        const outputDir = resolveOutputDir(baseDir, slug);

        // Write prompt
        safeWriteFile(join(outputDir, 'prompt.md'), buildPrompt(query));

        spinner.text = `Dispatching to ${providerIds.length} providers...`;

        const { reports, asyncTasks } = await dispatch({
          config,
          providerIds,
          query,
          outputDir,
          mode: config.defaults.mode,
          onProgress: (event) => {
            if (event.event === 'started') {
              spinner.text = `Running: ${event.providerId}...`;
            } else if (event.event === 'completed') {
              spinner.text = `Completed: ${event.providerId}`;
            } else if (event.event === 'fallback-started') {
              spinner.text = `Falling back: ${event.report?.id} → ${event.providerId}...`;
            }
          },
        });

        // Collect all citations for dedup
        const allCitations: Citation[] = [];
        for (const report of reports) {
          if (report.status === 'success' && report.metaFile) {
            try {
              const meta = JSON.parse(
                readFileSync(join(outputDir, report.metaFile), 'utf-8'),
              );
              if (meta.citations) {
                allCitations.push(...meta.citations);
              }
            } catch {
              // Skip if meta file can't be read
            }
          }
        }

        const sources = deduplicateSources(allCitations);

        // Write sources.json
        safeWriteFile(
          join(outputDir, 'sources.json'),
          JSON.stringify(sources, null, 2),
        );

        // Write async tasks
        if (asyncTasks.length > 0) {
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
          successCount === 0
            ? 2
            : successCount < effectiveReports.length
              ? 1
              : 0;

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

        spinner.succeed(`Research complete: ${outputDir}`);

        // Print summary (exclude recovered primaries so they don't show as failures)
        const successful = effectiveReports.filter(
          (r) => r.status === 'success',
        );
        const failed = effectiveReports.filter((r) => r.status === 'error');
        const pending = effectiveReports.filter(
          (r) => r.status === 'async-pending',
        );
        console.log(
          `  ${successful.length} succeeded, ${failed.length} failed, ${pending.length} async pending`,
        );
        console.log(
          `  ${sources.length} unique sources from ${allCitations.length} total citations`,
        );

        if (opts.json) {
          console.log(JSON.stringify(manifest, null, 2));
        }

        process.exitCode = exitCode;
      } catch (e) {
        spinner.fail(e instanceof Error ? e.message : String(e));
        process.exitCode = 2;
      }
    });
}
