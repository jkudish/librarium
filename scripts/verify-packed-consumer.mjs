#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const expectEngineRejection = process.argv.includes(
  '--expect-engine-rejection',
);
const root = process.cwd();
const workspace = mkdtempSync(join(tmpdir(), 'librarium-packed-consumer-'));
const packDirectory = join(workspace, 'pack');
const consumerDirectory = join(workspace, 'consumer');
// The temporary consumer isolates package resolution. Reuse the caller's npm
// cache so this gate does not redownload the dependency graph after `npm ci`.
const npmEnvironment = process.env;

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runNode(args, cwd = consumerDirectory) {
  return execFileSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runInstalledCli(args) {
  const executable = join(
    consumerDirectory,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'librarium.cmd' : 'librarium',
  );

  if (process.platform === 'win32') {
    const command = [
      '"',
      executable.replaceAll('"', '""'),
      '" ',
      args.join(' '),
    ].join('');
    return execFileSync(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', command],
      {
        cwd: consumerDirectory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  }

  return execFileSync(executable, args, {
    cwd: consumerDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

try {
  mkdirSync(packDirectory);
  mkdirSync(consumerDirectory);

  execFileSync(npmCommand(), ['pack', '--pack-destination', packDirectory], {
    cwd: root,
    encoding: 'utf8',
    env: npmEnvironment,
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.engines?.node !== '>=22.12.0') {
    throw new Error(
      `Expected package engines.node to be >=22.12.0, received ${String(pkg.engines?.node)}`,
    );
  }
  const tarball = resolve(
    packDirectory,
    `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`,
  );

  execFileSync(npmCommand(), ['init', '--yes'], {
    cwd: consumerDirectory,
    env: npmEnvironment,
    stdio: 'ignore',
  });

  const install = spawnSync(
    npmCommand(),
    [
      'install',
      '--engine-strict',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefer-offline',
      tarball,
    ],
    {
      cwd: consumerDirectory,
      encoding: 'utf8',
      env: { ...npmEnvironment, npm_config_engine_strict: 'true' },
    },
  );

  if (expectEngineRejection) {
    if (install.status === 0) {
      throw new Error(
        `Expected Node ${process.version} to reject ${pkg.name} ${pkg.engines.node}`,
      );
    }

    const diagnostics = `${install.stdout ?? ''}\n${install.stderr ?? ''}`;
    if (!/EBADENGINE|Unsupported engine/i.test(diagnostics)) {
      throw new Error(
        `Expected an engine-strict rejection, received:\n${diagnostics.trim()}`,
      );
    }
    if (
      !diagnostics.includes(`${pkg.name}@${pkg.version}`) ||
      !diagnostics.includes(pkg.engines.node)
    ) {
      throw new Error(
        `Engine rejection did not identify ${pkg.name}@${pkg.version} ${pkg.engines.node}:\n${diagnostics.trim()}`,
      );
    }

    console.log(
      `Verified Node ${process.version} rejects ${pkg.name} ${pkg.engines.node}`,
    );
  } else {
    if (install.status !== 0) {
      throw new Error(
        `Packed consumer install failed:\n${install.stdout ?? ''}\n${install.stderr ?? ''}`,
      );
    }

    runNode([
      '--input-type=module',
      '--eval',
      "await import('librarium/core'); await import('librarium/node');",
    ]);

    runInstalledCli(['--help']);
    const version = runInstalledCli(['--version']);
    if (version !== pkg.version) {
      throw new Error(
        `Expected CLI version ${pkg.version}, received ${version}`,
      );
    }

    console.log(
      `Verified packed ${pkg.name}@${pkg.version} on ${process.version}: install, CLI, core, node`,
    );
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
