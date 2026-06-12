import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import ora from 'ora';
import { getProvider, initializeProviders } from '../adapters/node-registry.js';
import { sanitizeId } from '../constants.js';
import {
  getPendingTasks,
  loadAsyncTasks,
  saveAsyncTasks,
  updateAsyncTask,
} from '../core/async-manager.js';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import { safeWriteFile } from '../core/fs-utils.js';
import type { AsyncTaskHandle, ProviderReport } from '../types.js';
import {
  computeLineWidths,
  dimText,
  formatProviderLine,
  isColorEnabled,
  type LineWidths,
} from './run-format.js';

function formatTaskAge(submittedAt: number): string {
  // submittedAt is in milliseconds
  const ageMs = Date.now() - submittedAt;
  const ageMin = Math.floor(ageMs / 60000);
  if (ageMin < 1) return 'just now';
  if (ageMin < 60) return `${ageMin}m ago`;
  return `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`;
}

function formatTaskStatus(task: AsyncTaskHandle): string {
  return `  ${task.provider} | Task: ${task.taskId.slice(0, 20)}... | Status: ${task.status} | Submitted: ${formatTaskAge(task.submittedAt)}`;
}

/** Column widths across a set of async tasks so result lines align. */
function widthsForTasks(tasks: AsyncTaskHandle[]): LineWidths {
  return computeLineWidths(
    tasks.map((task) => task.provider),
    tasks.map((task) => getProvider(task.provider)?.tier ?? 'deep-research'),
  );
}

async function retrieveTask(
  task: AsyncTaskHandle,
  dir: string,
  spinner: ReturnType<typeof ora>,
  widths: LineWidths,
  color: boolean,
): Promise<boolean> {
  const provider = getProvider(task.provider);
  if (!provider?.retrieve) {
    spinner.text = `Provider ${task.provider} does not support retrieval`;
    return false;
  }

  try {
    spinner.text = `Retrieving ${task.provider}...`;
    const result = await provider.retrieve(task);
    const safeId = sanitizeId(task.provider);
    const outputFile = `${safeId}.md`;
    const metaFile = `${safeId}.meta.json`;

    safeWriteFile(join(dir, outputFile), result.content);
    safeWriteFile(
      join(dir, metaFile),
      JSON.stringify(
        {
          provider: result.provider,
          tier: result.tier,
          model: result.model,
          durationMs: result.durationMs,
          citationCount: result.citations.length,
          tokenUsage: result.tokenUsage,
          citations: result.citations,
        },
        null,
        2,
      ),
    );

    // Mark as retrieved by removing from async tasks
    const tasks = loadAsyncTasks(dir);
    const updatedTasks = tasks.filter((t) => t.taskId !== task.taskId);
    saveAsyncTasks(dir, updatedTasks);

    const words = result.content.split(/\s+/).filter(Boolean).length;
    const cites = result.citations.length;
    spinner.text = `Retrieved ${task.provider} -> ${outputFile}`;

    // Render the retrieved result with the same table line as `librarium run`,
    // with the retrieval details as a dim suffix.
    const report: ProviderReport = {
      id: task.provider,
      tier: result.tier,
      status: result.error ? 'error' : 'success',
      durationMs: result.durationMs,
      wordCount: words,
      citationCount: cites,
      outputFile,
      metaFile,
      error: result.error,
    };
    const wasSpinning = spinner.isSpinning;
    if (wasSpinning) spinner.stop();
    console.log(
      `${formatProviderLine(report, widths, color)}   ${dimText(
        `${outputFile}, ${words} words`,
        color,
      )}`,
    );
    if (wasSpinning) spinner.start();
    return true;
  } catch (e) {
    spinner.text = `Error retrieving ${task.provider}: ${e instanceof Error ? e.message : String(e)}`;
    return false;
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
        const globalConfig = loadConfig();
        const projectConfig = loadProjectConfig(process.cwd());
        const config = mergeConfigs(globalConfig, projectConfig);
        const initResult = await initializeProviders({
          ...config,
          credentials: { env: process.env },
        });
        for (const warning of initResult.warnings) {
          console.error(`[librarium] warning: ${warning}`);
        }
        const baseDir = resolve(config.defaults.outputDir);
        const color = isColorEnabled(process.stdout);

        // Gather all async tasks (pending + completed unretrieved)
        const pendingTasks = getPendingTasks(baseDir);
        const completedTasks = getCompletedTasks(baseDir);
        const allTasks = [...pendingTasks, ...completedTasks];

        if (allTasks.length === 0) {
          if (opts.json) {
            console.log(
              JSON.stringify({ tasks: [], message: 'No async tasks' }),
            );
          } else {
            console.log('No async tasks.');
          }
          return;
        }

        if (opts.json && !opts.wait && !opts.retrieve) {
          console.log(JSON.stringify({ tasks: allTasks }, null, 2));
          return;
        }

        if (!opts.wait && !opts.retrieve) {
          if (pendingTasks.length > 0) {
            console.log(`\nPending async tasks (${pendingTasks.length}):\n`);
            for (const task of pendingTasks) {
              console.log(formatTaskStatus(task));
            }
          }
          if (completedTasks.length > 0) {
            console.log(
              `\nCompleted (awaiting retrieval): ${completedTasks.length}\n`,
            );
            for (const task of completedTasks) {
              console.log(formatTaskStatus(task));
            }
          }
          console.log(
            '\nUse --wait to poll and auto-retrieve, --retrieve to fetch completed results.',
          );
          return;
        }

        // Wait mode: poll until done, then auto-retrieve
        if (opts.wait) {
          const spinner = ora(
            `Polling ${pendingTasks.length} async tasks...`,
          ).start();
          const pollInterval = config.defaults.asyncPollInterval * 1000;
          let remaining = [...pendingTasks];
          const justCompleted: Array<{
            task: AsyncTaskHandle;
            dir: string;
          }> = [];

          while (remaining.length > 0) {
            for (const task of remaining) {
              const provider = getProvider(task.provider);
              if (!provider?.poll) {
                spinner.text = `Provider ${task.provider} does not support polling`;
                task.status = 'failed';
                continue;
              }

              try {
                const result = await provider.poll(task);
                if (
                  result.status === 'completed' ||
                  result.status === 'failed'
                ) {
                  if (task.outputDir) {
                    updateAsyncTask(task.outputDir, task.taskId, {
                      status: result.status,
                      completedAt: Date.now(),
                    });
                  }
                  task.status = result.status;
                  if (result.status === 'completed' && task.outputDir) {
                    justCompleted.push({ task, dir: task.outputDir });
                  }
                  if (result.status === 'failed') {
                    const failureReport: ProviderReport = {
                      id: task.provider,
                      tier: getProvider(task.provider)?.tier ?? 'deep-research',
                      status: 'error',
                      durationMs: 0,
                      wordCount: 0,
                      citationCount: 0,
                      outputFile: '',
                      metaFile: '',
                      error: result.message ?? 'task failed',
                    };
                    spinner.stop();
                    console.log(
                      formatProviderLine(
                        failureReport,
                        widthsForTasks(pendingTasks),
                        color,
                      ),
                    );
                    spinner.start();
                  }
                  spinner.text = `${task.provider}: ${result.status}${result.message ? `: ${result.message}` : ''}`;
                } else {
                  const progress = result.progress
                    ? ` (${result.progress}%)`
                    : '';
                  spinner.text = `${task.provider}: ${result.status}${progress}`;
                  if (task.outputDir) {
                    updateAsyncTask(task.outputDir, task.taskId, {
                      status: result.status,
                      lastPolledAt: Date.now(),
                    });
                  }
                }
              } catch (e) {
                spinner.text = `Error polling ${task.provider}: ${e instanceof Error ? e.message : String(e)}`;
              }
            }

            remaining = remaining.filter(
              (t) => t.status === 'pending' || t.status === 'running',
            );

            if (remaining.length > 0) {
              await new Promise((r) => setTimeout(r, pollInterval));
            }
          }

          spinner.succeed('All async tasks completed.');

          // Auto-retrieve completed results
          if (justCompleted.length > 0) {
            const retrieveSpinner = ora(
              `Retrieving ${justCompleted.length} results...`,
            ).start();
            const widths = widthsForTasks(justCompleted.map((c) => c.task));
            let retrieved = 0;
            for (const { task, dir } of justCompleted) {
              const ok = await retrieveTask(
                task,
                dir,
                retrieveSpinner,
                widths,
                color,
              );
              if (ok) retrieved++;
            }
            retrieveSpinner.succeed(
              `Retrieved ${retrieved}/${justCompleted.length} results.`,
            );
          }
        }

        // Retrieve mode (standalone or after wait for previously completed)
        if (opts.retrieve && !opts.wait) {
          const spinner = ora('Retrieving completed results...').start();
          const entries = readdirSync(baseDir);
          let retrieved = 0;

          // Collect all completed tasks first so table columns align.
          const toRetrieve: Array<{ task: AsyncTaskHandle; dir: string }> = [];
          for (const entry of entries) {
            const dir = join(baseDir, entry);
            try {
              if (!statSync(dir).isDirectory()) continue;
            } catch {
              continue;
            }

            const tasks = loadAsyncTasks(dir);
            for (const task of tasks) {
              if (task.status === 'completed') toRetrieve.push({ task, dir });
            }
          }

          const widths = widthsForTasks(toRetrieve.map((c) => c.task));
          for (const { task, dir } of toRetrieve) {
            const ok = await retrieveTask(task, dir, spinner, widths, color);
            if (ok) retrieved++;
          }

          if (retrieved > 0) {
            spinner.succeed(`Retrieved ${retrieved} results.`);
          } else {
            spinner.info('No completed tasks to retrieve.');
          }
        }

        if (opts.json) {
          const updatedTasks = [
            ...getPendingTasks(baseDir),
            ...getCompletedTasks(baseDir),
          ];
          console.log(JSON.stringify({ tasks: updatedTasks }, null, 2));
        }
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });
}

/**
 * Get completed but unretrieved async tasks across all output directories
 */
function getCompletedTasks(baseOutputDir: string): AsyncTaskHandle[] {
  if (!existsSync(baseOutputDir)) return [];

  const entries = readdirSync(baseOutputDir);
  const tasks: AsyncTaskHandle[] = [];

  for (const entry of entries) {
    const dir = join(baseOutputDir, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const dirTasks = loadAsyncTasks(dir);
      for (const task of dirTasks) {
        if (task.status === 'completed') {
          if (!task.outputDir) task.outputDir = dir;
          tasks.push(task);
        }
      }
    } catch {}
  }

  return tasks;
}
