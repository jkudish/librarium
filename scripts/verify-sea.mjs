#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const os = platform();
const cpu = arch();
const binary =
  os === 'win32'
    ? `librarium-windows-${cpu}.exe`
    : `librarium-${os === 'darwin' ? 'macos' : 'linux'}-${cpu}`;
const executable = join(process.cwd(), 'dist', binary);
const pathEntries = (process.env.PATH ?? '')
  .split(delimiter)
  .filter(Boolean)
  .map((entry) => resolve(entry));

function containsNodeExecutable(directory) {
  for (const filename of ['node', 'node.exe']) {
    try {
      accessSync(
        join(directory, filename),
        os === 'win32' ? constants.F_OK : constants.X_OK,
      );
      return true;
    } catch {
      // Keep checking the other platform spelling.
    }
  }
  return false;
}

const nodeDirectories = new Set(pathEntries.filter(containsNodeExecutable));
if (nodeDirectories.size === 0) {
  throw new Error(
    'SEA verification could not identify a Node.js executable on PATH',
  );
}

const isolatedPathEntries = pathEntries.filter(
  (entry) => !nodeDirectories.has(entry),
);
if (isolatedPathEntries.some(containsNodeExecutable)) {
  throw new Error('SEA verification failed to remove Node.js from PATH');
}
const pathWithoutNode = isolatedPathEntries.join(delimiter);

function run(args) {
  return execFileSync(executable, args, {
    encoding: 'utf8',
    env: { ...process.env, PATH: pathWithoutNode },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

run(['--help']);
const version = run(['--version']);
if (version !== pkg.version) {
  throw new Error(`Expected SEA version ${pkg.version}, received ${version}`);
}

console.log(`Verified ${binary}: --help and --version (${version})`);
