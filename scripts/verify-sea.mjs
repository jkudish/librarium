#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const os = platform();
const cpu = arch();
const binary =
  os === 'win32'
    ? `librarium-windows-${cpu}.exe`
    : `librarium-${os === 'darwin' ? 'macos' : 'linux'}-${cpu}`;
const executable = join(process.cwd(), 'dist', binary);
const hostNodeDirectory = resolve(dirname(process.execPath));
const pathWithoutHostNode = (process.env.PATH ?? '')
  .split(delimiter)
  .filter((entry) => entry && resolve(entry) !== hostNodeDirectory)
  .join(delimiter);

function run(args) {
  return execFileSync(executable, args, {
    encoding: 'utf8',
    env: { ...process.env, PATH: pathWithoutHostNode },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

run(['--help']);
const version = run(['--version']);
if (version !== pkg.version) {
  throw new Error(`Expected SEA version ${pkg.version}, received ${version}`);
}

console.log(`Verified ${binary}: --help and --version (${version})`);
