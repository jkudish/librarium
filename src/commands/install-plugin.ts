import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { VERSION } from '../constants.js';

/**
 * Files that make up the Amp plugin, relative to the repository root.
 * Each entry is downloaded from the version-pinned GitHub raw URL and
 * installed to the corresponding path under the plugin directory.
 */
const PLUGIN_FILES = [
  '.amp/plugins/librarium/index.ts',
  '.amp/plugins/librarium/skills/research/SKILL.md',
];

const PLUGIN_DIR = join(homedir(), '.config', 'amp', 'plugins', 'librarium');
const REPO_OWNER = 'jkudish';
const REPO_NAME = 'librarium';

function rawUrl(branch: string, filePath: string): string {
  return `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${branch}/${filePath}`;
}

export function registerInstallPluginCommand(program: Command): void {
  program
    .command('install-plugin')
    .description('Install the Amp plugin for AI-assisted research')
    .option('--force', 'Overwrite existing plugin files')
    .option('--dry-run', 'Show what would happen without installing')
    .action(async (opts) => {
      try {
        if (opts.dryRun) {
          console.log('Would download plugin files from:');
          for (const file of PLUGIN_FILES) {
            console.log(`  ${rawUrl(`v${VERSION}`, file)}`);
          }
          console.log(`Would install to:\n  ${PLUGIN_DIR}`);
          return;
        }

        console.log('Downloading librarium Amp plugin...');

        const branches = [`v${VERSION}`, 'main'];
        let installed = 0;

        for (const file of PLUGIN_FILES) {
          const destPath = join(
            PLUGIN_DIR,
            file.replace('.amp/plugins/librarium/', ''),
          );

          if (existsSync(destPath)) {
            if (!opts.force) {
              console.log(`Already installed: ${destPath}`);
              continue;
            }
            // Refuse to overwrite symlinks.
            const stat = lstatSync(destPath);
            if (stat.isSymbolicLink()) {
              console.error(`${destPath} is a symlink — refusing to overwrite`);
              process.exitCode = 1;
              return;
            }
          }

          let content: string | null = null;
          for (const branch of branches) {
            try {
              const response = await fetch(rawUrl(branch, file));
              if (response.ok) {
                content = await response.text();
                break;
              }
            } catch {
              // Try next branch.
            }
          }

          if (!content || content.trim().length < 50) {
            console.error(
              `Failed to download ${file} or content appears invalid.`,
            );
            process.exitCode = 1;
            return;
          }

          mkdirSync(dirname(destPath), { recursive: true });
          writeFileSync(destPath, content, 'utf-8');
          console.log(`Installed: ${destPath}`);
          installed++;
        }

        if (installed > 0 || opts.force) {
          console.log(`\nAmp plugin installed to ${PLUGIN_DIR}`);
          console.log(
            'Restart Amp or run the "plugins: reload" command to activate it.',
          );
        }
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });
}
