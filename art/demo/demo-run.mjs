#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
/**
 * Deterministic README demo driver.
 *
 * It invokes the real built CLI and replays the checked-in canonical fixture.
 * The fixture runtime installs a network guard and uses fake in-process
 * providers, so this path never reads credentials, calls a provider, or spends
 * money. The command output is from the real canonical execution/artifact
 * path, not hand-authored terminal text.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const demoRoot = mkdtempSync(join(tmpdir(), 'librarium-demo-'));
const fixture = JSON.parse(
  readFileSync(new URL('./fixture.template.json', import.meta.url), 'utf8'),
);
fixture.state_root = demoRoot;

const fixturePath = join(demoRoot, 'fixture.json');
writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
process.on('exit', () => rmSync(demoRoot, { recursive: true, force: true }));

const cli = new URL('../../dist/cli.js', import.meta.url);
const args = [cli.pathname, 'live-validation', '--fixture', fixturePath];

// A durable fixture requires an initial materialization and one later resume.
// The first real CLI call is intentionally quiet because its temporary path is
// not useful in a deterministic recording; the second prints the terminal
// canonical result. Neither call has network or credential access.
const initial = spawnSync(process.execPath, args, { stdio: 'ignore' });
if (initial.status !== 0) process.exit(initial.status ?? 1);

const resumed = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(resumed.status ?? 1);
