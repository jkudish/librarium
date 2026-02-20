import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';

export function registerCleanupCommand(program: Command): void {
  program
    .command('cleanup')
    .description('Remove old output directories')
    .option(
      '--days <n>',
      'Age threshold in days (default: 30)',
      Number.parseInt,
      30,
    )
    .option('--dry-run', 'Show what would be deleted without deleting')
    .option('--json', 'Output JSON')
    .action((opts) => {
      try {
        const globalConfig = loadConfig();
        const projectConfig = loadProjectConfig(process.cwd());
        const config = mergeConfigs(globalConfig, projectConfig);
        const baseDir = resolve(config.defaults.outputDir);

        if (!existsSync(baseDir)) {
          if (opts.json) {
            console.log(
              JSON.stringify({
                deleted: [],
                message: 'Output directory does not exist',
              }),
            );
          } else {
            console.log(
              'Output directory does not exist. Nothing to clean up.',
            );
          }
          return;
        }

        const cutoffMs = Date.now() - opts.days * 24 * 60 * 60 * 1000;
        const entries = readdirSync(baseDir);
        const toDelete: Array<{ dir: string; age: string; size: number }> = [];

        for (const entry of entries) {
          const dirPath = join(baseDir, entry);
          try {
            const stat = statSync(dirPath);
            if (!stat.isDirectory()) continue;

            // Extract timestamp from directory name (format: {timestamp}-{slug})
            const match = entry.match(/^(\d+)-/);
            const dirTime = match
              ? Number.parseInt(match[1], 10) * 1000
              : stat.mtimeMs;

            if (dirTime < cutoffMs) {
              const ageDays = Math.floor(
                (Date.now() - dirTime) / (24 * 60 * 60 * 1000),
              );
              toDelete.push({
                dir: dirPath,
                age: `${ageDays}d`,
                size: getDirSize(dirPath),
              });
            }
          } catch {}
        }

        if (toDelete.length === 0) {
          if (opts.json) {
            console.log(
              JSON.stringify({ deleted: [], message: 'Nothing to clean up' }),
            );
          } else {
            console.log(`No output directories older than ${opts.days} days.`);
          }
          return;
        }

        if (opts.json) {
          if (!opts.dryRun) {
            for (const item of toDelete) {
              rmSync(item.dir, { recursive: true, force: true });
            }
          }
          console.log(
            JSON.stringify(
              {
                dryRun: !!opts.dryRun,
                deleted: toDelete.map((d) => ({
                  path: d.dir,
                  age: d.age,
                  sizeBytes: d.size,
                })),
              },
              null,
              2,
            ),
          );
          return;
        }

        const totalSize = toDelete.reduce((sum, d) => sum + d.size, 0);
        const sizeStr = formatSize(totalSize);

        if (opts.dryRun) {
          console.log(
            `\nWould delete ${toDelete.length} directories (${sizeStr}):\n`,
          );
          for (const item of toDelete) {
            console.log(
              `  ${item.dir} (${item.age} old, ${formatSize(item.size)})`,
            );
          }
          console.log('\nRun without --dry-run to delete.');
        } else {
          console.log(
            `\nDeleting ${toDelete.length} directories (${sizeStr})...\n`,
          );
          for (const item of toDelete) {
            rmSync(item.dir, { recursive: true, force: true });
            console.log(`  Deleted: ${item.dir} (${item.age} old)`);
          }
          console.log('\nCleanup complete.');
        }
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });
}

function getDirSize(dirPath: string): number {
  let size = 0;
  try {
    const entries = readdirSync(dirPath);
    for (const entry of entries) {
      const fullPath = join(dirPath, entry);
      const stat = statSync(fullPath);
      if (stat.isFile()) {
        size += stat.size;
      } else if (stat.isDirectory()) {
        size += getDirSize(fullPath);
      }
    }
  } catch {
    // Skip on error
  }
  return size;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
