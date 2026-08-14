import { execFileSync } from 'node:child_process';
import type { Command } from 'commander';
import { VERSION } from '../constants.js';
import {
  detectInstallMethod,
  type InstallMethod,
} from '../core/install-method.js';

const GITHUB_REPO = 'jkudish/librarium';
const RELEASE_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.[1-9]\d*)?$/;

interface UpgradeDependencies {
  readonly current_version: string;
  readonly detect_install_method: () => InstallMethod;
  readonly fetch_latest_version: () => string | null;
  readonly run_command: (
    executable: string,
    arguments_: readonly string[],
  ) => void;
}

function assertReleaseVersion(value: string, label: string): string {
  if (!RELEASE_VERSION_PATTERN.test(value)) {
    throw new Error(`${label} must use X.Y.Z or X.Y.Z-rc.N syntax.`);
  }
  return value;
}

interface ParsedReleaseVersion {
  readonly major: bigint;
  readonly minor: bigint;
  readonly patch: bigint;
  readonly rc: bigint | null;
}

function parseReleaseVersion(value: string): ParsedReleaseVersion {
  assertReleaseVersion(value, 'Release version');
  const [core, prerelease] = value.split('-rc.');
  const [major, minor, patch] = core!.split('.').map(BigInt);
  return {
    major: major!,
    minor: minor!,
    patch: patch!,
    rc: prerelease === undefined ? null : BigInt(prerelease),
  };
}

function compareReleaseVersions(left: string, right: string): number {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.rc === b.rc) return 0;
  if (a.rc === null) return 1;
  if (b.rc === null) return -1;
  return a.rc < b.rc ? -1 : 1;
}

function fetchLatestVersion(): string | null {
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    const response = execFileSync('curl', ['-fsSL', url], {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const match = response.match(/"tag_name"\s*:\s*"v?([^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function executeCommand(
  executable: string,
  arguments_: readonly string[],
): void {
  execFileSync(executable, [...arguments_], {
    encoding: 'utf-8',
    timeout: 120_000,
    stdio: 'inherit',
  });
}

function upgradeInvocation(
  method: InstallMethod,
  target: string,
): {
  readonly executable: string;
  readonly arguments_: readonly string[];
} | null {
  switch (method) {
    case 'homebrew':
      return { executable: 'brew', arguments_: ['upgrade', 'librarium'] };
    case 'pnpm':
      return {
        executable: 'pnpm',
        arguments_: ['update', '-g', `librarium@${target}`],
      };
    case 'yarn':
      return {
        executable: 'yarn',
        arguments_: ['global', 'upgrade', `librarium@${target}`],
      };
    case 'sea-standalone':
      return null;
    default:
      return {
        executable: 'npm',
        arguments_: ['install', '-g', `librarium@${target}`],
      };
  }
}

function displayInvocation(
  invocation: NonNullable<ReturnType<typeof upgradeInvocation>>,
): string {
  return [invocation.executable, ...invocation.arguments_].join(' ');
}

function runUpgrade(
  method: InstallMethod,
  target: string,
  runCommand: UpgradeDependencies['run_command'],
): void {
  const invocation = upgradeInvocation(method, target);
  if (!invocation) {
    console.log(
      'Standalone binary cannot self-replace while running.\n' +
        'To upgrade, re-run the installer with an exact version and checksum.\n',
    );
    return;
  }
  console.log(`Running: ${displayInvocation(invocation)}`);
  runCommand(invocation.executable, invocation.arguments_);
}

const defaultDependencies: UpgradeDependencies = {
  current_version: VERSION,
  detect_install_method: detectInstallMethod,
  fetch_latest_version: fetchLatestVersion,
  run_command: executeCommand,
};

export function registerUpgradeCommand(
  program: Command,
  dependencies: Partial<UpgradeDependencies> = {},
): void {
  const resolved = { ...defaultDependencies, ...dependencies };
  program
    .command('upgrade')
    .description('Check for and install librarium updates')
    .option('--check', 'Check for updates without installing')
    .option('--dry-run', 'Show what would happen without upgrading')
    .option('--force', 'Skip version comparison and force reinstall')
    .option(
      '--target <version>',
      'Use an exact local/fixture target (requires --dry-run)',
    )
    .action((opts) => {
      try {
        const current = assertReleaseVersion(
          resolved.current_version,
          'Installed version',
        );
        const method = resolved.detect_install_method();
        const explicitTarget = opts.target as string | undefined;
        if (explicitTarget && !opts.dryRun) {
          throw new Error('--target is allowed only with --dry-run.');
        }
        if (explicitTarget && opts.check) {
          throw new Error('--target cannot be combined with --check.');
        }

        const fetched = explicitTarget ?? resolved.fetch_latest_version();
        if (!fetched) {
          console.error('Could not check for updates. Are you online?');
          process.exitCode = 1;
          return;
        }
        const target = assertReleaseVersion(fetched, 'Target version');

        if (!opts.force && !explicitTarget) {
          const comparison = compareReleaseVersions(target, current);
          if (comparison === 0) {
            console.log(
              `Already on latest version (${current}). Installed via ${method}.`,
            );
            return;
          }
          if (comparison < 0) {
            console.error(
              `Refusing to downgrade librarium: installed ${current}, fetched ${target}. Use --force only if this downgrade is intentional.`,
            );
            process.exitCode = 1;
            return;
          }
        }

        if (opts.check) {
          console.log(
            `Update available: ${current} → ${target} (installed via ${method})`,
          );
          return;
        }

        if (opts.dryRun) {
          console.log(
            `Would upgrade librarium: ${current} → ${target} via ${method}`,
          );
          const invocation = upgradeInvocation(method, target);
          if (invocation) {
            console.log(`Would run: ${displayInvocation(invocation)}`);
          } else {
            console.log(
              'Would re-run install.sh with the exact candidate path, version, and SHA-256.',
            );
          }
          return;
        }

        console.log(
          `Upgrading librarium: ${current} → ${target} via ${method}...`,
        );

        try {
          runUpgrade(method, target, resolved.run_command);
          if (method !== 'sea-standalone') {
            console.log(`Successfully upgraded to ${target}.`);
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (/EACCES|permission denied/i.test(message)) {
            if (method === 'npm') {
              console.error(
                `Permission denied. Try: sudo npm install -g librarium@${target}`,
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
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}

export const upgradeInternals = {
  assertReleaseVersion,
  compareReleaseVersions,
  displayInvocation,
  runUpgrade,
  upgradeInvocation,
};
