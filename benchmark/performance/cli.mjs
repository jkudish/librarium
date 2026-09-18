#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = mkdtempSync(join(tmpdir(), 'librarium-performance-build-'));
const bundler = join(root, 'node_modules', '.bin', 'esbuild');
const runner = join(root, 'benchmark', 'performance', 'runner.ts');
const compiled = join(output, 'runner.js');

try {
  const build = spawnSync(
    bundler,
    [
      runner,
      '--bundle',
      '--format=esm',
      '--platform=node',
      `--outfile=${compiled}`,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (build.status !== 0) throw new Error(build.stderr || build.stdout);
  const run = spawnSync(
    process.execPath,
    [compiled, ...process.argv.slice(2)],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, LIBRARIUM_PERFORMANCE_ROOT: root },
    },
  );
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(output, { recursive: true, force: true });
}
