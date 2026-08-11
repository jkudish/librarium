#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyTypeScriptToolchain } from './typescript-toolchain.mjs';

const root = process.cwd();
const packageJson = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8'),
);

verifyTypeScriptToolchain(root);

if (packageJson.devDependencies?.['@typescript/typescript6'] !== '6.0.2') {
  throw new Error('TypeScript 6 compatibility must be pinned at 6.0.2');
}
const typescript6 = resolve(
  root,
  'node_modules/@typescript/typescript6/bin/tsc6',
);
const typescript6Version = execFileSync(
  process.execPath,
  [typescript6, '--version'],
  {
    encoding: 'utf8',
  },
).trim();
if (!/^Version 6\./.test(typescript6Version)) {
  throw new Error(
    `Expected a TypeScript 6 compatibility compiler, received ${typescript6Version}`,
  );
}
