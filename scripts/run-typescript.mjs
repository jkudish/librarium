#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { verifyTypeScriptToolchain } from './typescript-toolchain.mjs';

const result = spawnSync(verifyTypeScriptToolchain(), process.argv.slice(2), {
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
