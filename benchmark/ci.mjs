#!/usr/bin/env node
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertOfflineCi,
  installNetworkGuard,
  secretEnvironmentVariables,
} from './lib/guard.mjs';
import { executeBenchmark } from './lib/runner.mjs';

const fixture = fileURLToPath(
  new URL('./fixtures/v1/manifest.json', import.meta.url),
);
const output = mkdtempSync(join(tmpdir(), 'librarium-benchmark-ci-'));
const ciEnvironment = { ...process.env, CI: 'true' };
assertOfflineCi({ fixture, env: ciEnvironment });
for (const key of secretEnvironmentVariables) delete ciEnvironment[key];
const restoreNetwork = installNetworkGuard();
try {
  const result = await executeBenchmark(
    { track: 'all', fixture, output },
    { env: ciEnvironment, failFast: true },
  );
  if (result.failed > 0 || result.completed === 0) {
    throw new Error(
      `Fixture replay completed=${result.completed} failed=${result.failed}`,
    );
  }
  process.stdout.write(
    `Offline benchmark CI replay passed: ${result.completed} cases; artifacts ${result.outputDirectory}\n`,
  );
} finally {
  restoreNetwork();
}
