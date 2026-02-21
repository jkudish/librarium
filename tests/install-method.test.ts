import { afterEach, describe, expect, it, vi } from 'vitest';

// We need to test detectInstallMethod which reads process.execPath and process.argv
// We'll mock these and the node:sea module

describe('install method detection', () => {
  const originalExecPath = process.execPath;
  const originalArgv = [...process.argv];

  afterEach(() => {
    process.execPath = originalExecPath;
    process.argv = [...originalArgv];
    vi.restoreAllMocks();
    // Clear module cache so each test gets a fresh import
    vi.resetModules();
  });

  async function getDetectFn() {
    const mod = await import('../src/core/install-method.js');
    return mod.detectInstallMethod;
  }

  it('returns npm as default install method', async () => {
    process.execPath = '/usr/local/bin/node';
    process.argv[1] = '/usr/local/lib/node_modules/librarium/dist/cli.js';
    const detect = await getDetectFn();
    expect(detect()).toBe('npm');
  });

  it('detects pnpm from script path', async () => {
    process.execPath = '/usr/local/bin/node';
    process.argv[1] =
      '/home/user/.local/share/pnpm/global/5/.pnpm/librarium@0.1.0/node_modules/librarium/dist/cli.js';
    const detect = await getDetectFn();
    expect(detect()).toBe('pnpm');
  });

  it('detects pnpm from exec path', async () => {
    process.execPath = '/home/user/.local/share/pnpm/nodejs/20.0.0/bin/node';
    process.argv[1] = '/some/path/dist/cli.js';
    const detect = await getDetectFn();
    // pnpm detected via execPath
    expect(detect()).toBe('pnpm');
  });

  it('detects yarn from script path', async () => {
    process.execPath = '/usr/local/bin/node';
    process.argv[1] =
      '/home/user/.yarn/global/node_modules/librarium/dist/cli.js';
    const detect = await getDetectFn();
    expect(detect()).toBe('yarn');
  });

  it('detects yarn from exec path', async () => {
    process.execPath = '/home/user/.yarn/bin/node';
    process.argv[1] = '/some/path/dist/cli.js';
    const detect = await getDetectFn();
    expect(detect()).toBe('yarn');
  });

  it('returns the correct type union values', async () => {
    const mod = await import('../src/core/install-method.js');
    // Type check: the function exists and returns a string
    const result = mod.detectInstallMethod();
    expect(['homebrew', 'sea-standalone', 'pnpm', 'yarn', 'npm']).toContain(
      result,
    );
  });
});
