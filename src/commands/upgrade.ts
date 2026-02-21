import { execSync } from 'node:child_process';
import type { Command } from 'commander';
import { VERSION } from '../constants.js';
import {
  detectInstallMethod,
  type InstallMethod,
} from '../core/install-method.js';

const GITHUB_REPO = 'jkudish/librarium';

/**
 * Fetch the latest version from GitHub Releases API.
 * Works regardless of install method (unlike npm view).
 */
function fetchLatestVersion(): string | null {
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    const response = execSync(`curl -fsSL "${url}"`, {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const match = response.match(/"tag_name"\s*:\s*"v?([^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Run the upgrade command for the given install method.
 */
function runUpgrade(method: InstallMethod, latest: string): void {
  switch (method) {
    case 'homebrew':
      console.log('Running: brew upgrade librarium');
      execSync('brew upgrade librarium', {
        encoding: 'utf-8',
        timeout: 120_000,
        stdio: 'inherit',
      });
      break;

    case 'pnpm':
      console.log('Running: pnpm update -g librarium');
      execSync('pnpm update -g librarium', {
        encoding: 'utf-8',
        timeout: 120_000,
        stdio: 'inherit',
      });
      break;

    case 'yarn':
      console.log(`Running: yarn global upgrade librarium@${latest}`);
      execSync(`yarn global upgrade librarium@${latest}`, {
        encoding: 'utf-8',
        timeout: 120_000,
        stdio: 'inherit',
      });
      break;

    case 'sea-standalone':
      console.log(
        'Standalone binary cannot self-replace while running.\n' +
          'To upgrade, re-run the installer:\n\n' +
          '  curl -fsSL https://raw.githubusercontent.com/jkudish/librarium/main/scripts/install.sh | sh\n',
      );
      return;

    default:
      console.log('Running: npm install -g librarium@latest');
      execSync('npm install -g librarium@latest', {
        encoding: 'utf-8',
        timeout: 120_000,
        stdio: 'inherit',
      });
      break;
  }
}

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
        const method = detectInstallMethod();

        const latest = fetchLatestVersion();
        if (!latest) {
          console.error('Could not check for updates. Are you online?');
          process.exitCode = 1;
          return;
        }

        if (!opts.force && latest === current) {
          console.log(
            `Already on latest version (${current}). Installed via ${method}.`,
          );
          return;
        }

        if (opts.check) {
          if (latest !== current) {
            console.log(
              `Update available: ${current} → ${latest} (installed via ${method})`,
            );
          } else {
            console.log(
              `Already on latest version (${current}). Installed via ${method}.`,
            );
          }
          return;
        }

        if (opts.dryRun) {
          console.log(
            `Would upgrade librarium: ${current} → ${latest} via ${method}`,
          );
          return;
        }

        console.log(
          `Upgrading librarium: ${current} → ${latest} via ${method}...`,
        );

        try {
          runUpgrade(method, latest);
          if (method !== 'sea-standalone') {
            console.log(`Successfully upgraded to ${latest}.`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/EACCES|permission denied/i.test(msg)) {
            if (method === 'npm') {
              console.error(
                'Permission denied. Try: sudo npm install -g librarium@latest',
              );
            } else {
              console.error(
                `Permission denied. Try running the ${method} upgrade command with elevated permissions.`,
              );
            }
          } else {
            console.error(
              `Upgrade failed via ${method}. Try running the upgrade command manually.`,
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
