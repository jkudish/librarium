import { execSync } from 'node:child_process';
import type { Command } from 'commander';
import { VERSION } from '../constants.js';

export function registerUpgradeCommand(program: Command): void {
  program
    .command('upgrade')
    .description('Check for and install librarium updates')
    .option('--check', 'Check for updates without installing')
    .option('--dry-run', 'Show what would happen without upgrading')
    .option('--force', 'Skip version comparison and force reinstall')
    .action((opts) => {
      try {
        const current = VERSION;
        let latest: string;

        try {
          latest = execSync('npm view librarium version', {
            encoding: 'utf-8',
            timeout: 15_000,
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
        } catch {
          console.error('Could not check npm registry. Are you online?');
          process.exitCode = 1;
          return;
        }

        if (!opts.force && latest === current) {
          console.log(`Already on latest version (${current}).`);
          return;
        }

        if (opts.check) {
          if (latest !== current) {
            console.log(`Update available: ${current} → ${latest}`);
          } else {
            console.log(`Already on latest version (${current}).`);
          }
          return;
        }

        if (opts.dryRun) {
          console.log(`Would upgrade librarium: ${current} → ${latest}`);
          return;
        }

        console.log(`Upgrading librarium: ${current} → ${latest}...`);

        try {
          execSync('npm install -g librarium@latest', {
            encoding: 'utf-8',
            timeout: 120_000,
            stdio: 'inherit',
          });
          console.log(`Successfully upgraded to ${latest}.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/EACCES|permission denied/i.test(msg)) {
            console.error(
              'Permission denied. Try: sudo npm install -g librarium@latest',
            );
          } else {
            console.error(
              'Upgrade failed. Try running manually: npm install -g librarium@latest',
            );
          }
          process.exitCode = 1;
        }
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });
}
