/**
 * Detect how librarium was installed to determine the correct upgrade path.
 */

export type InstallMethod =
  | 'homebrew'
  | 'sea-standalone'
  | 'pnpm'
  | 'yarn'
  | 'npm';

/**
 * Check if running as a Node.js Single Executable Application.
 * Uses the node:sea module available in Node 21+.
 */
function isSea(): boolean {
  try {
    // In a SEA binary, node:sea module exists and isSea() returns true.
    // Use createRequire to avoid bundler resolution issues.
    const { createRequire } = require('node:module');
    const req = createRequire(__filename);
    const mod = req('node:sea');
    return typeof mod.isSea === 'function' && mod.isSea();
  } catch {
    return false;
  }
}

/**
 * Detect how librarium was installed.
 *
 * Detection order:
 * 1. SEA binary → check if path contains homebrew prefix → 'homebrew' or 'sea-standalone'
 * 2. Script path contains .pnpm → 'pnpm'
 * 3. Script path contains .yarn → 'yarn'
 * 4. Default → 'npm'
 */
export function detectInstallMethod(): InstallMethod {
  if (isSea()) {
    const execPath = process.execPath.toLowerCase();
    if (
      execPath.includes('/homebrew/') ||
      execPath.includes('/linuxbrew/') ||
      execPath.includes('/cellar/')
    ) {
      return 'homebrew';
    }
    return 'sea-standalone';
  }

  // For non-SEA: check the script path (process.argv[1])
  const scriptPath = (process.argv[1] || '').toLowerCase();
  const execPath = process.execPath.toLowerCase();

  if (
    scriptPath.includes('.pnpm') ||
    scriptPath.includes('/pnpm/') ||
    execPath.includes('.pnpm') ||
    execPath.includes('/pnpm/')
  ) {
    return 'pnpm';
  }

  if (
    scriptPath.includes('.yarn') ||
    scriptPath.includes('/yarn/') ||
    execPath.includes('.yarn') ||
    execPath.includes('/yarn/')
  ) {
    return 'yarn';
  }

  return 'npm';
}
