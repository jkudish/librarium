#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { resolveNativeTypeScript7Compiler } from './typescript-toolchain.mjs';

const root = process.cwd();
const workspace = mkdtempSync(join(tmpdir(), 'librarium-packed-'));
const consumer = join(workspace, 'consumer');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function option(name) {
  const indexes = process.argv.flatMap((value, index) =>
    value === `--${name}` ? [index] : [],
  );
  if (indexes.length > 1) throw new Error(`Duplicate --${name}`);
  if (!indexes.length) return undefined;
  const value = process.argv[indexes[0] + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing --${name}`);
  return value;
}
function files(directory, base = directory) {
  return readdirSync(directory)
    .flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory()
        ? files(path, base)
        : [relative(base, path).split(sep).join('/')];
    })
    .sort();
}
function run(args, cwd = consumer, env = process.env) {
  return execFileSync(process.execPath, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
const common = [
  'VERSION',
  'ConfigV3Schema',
  'createLibrarium',
  'MemoryRunStore',
  'RunSchema',
  'StoredRunSchema',
  'RunStoreConflict',
];
const node = [
  ...common,
  'FilesystemRunStore',
  'loadConfigV3',
  'saveConfigV3',
  'migrateConfigV1',
  'configV3Path',
];
const builtins = new Set(
  builtinModules.flatMap((id) => [id, `node:${id.replace(/^node:/, '')}`]),
);
async function verifyCoreGraph(installed) {
  const scan = await build({
    entryPoints: [join(root, 'src/run-core-entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    packages: 'external',
    write: false,
    metafile: true,
    define: { __VERSION__: JSON.stringify('packed-verifier') },
  });
  for (const input of Object.keys(scan.metafile.inputs))
    if (/src\/(node-|commands\/|mcp\/|cli)/.test(input))
      throw new Error(`Core reached ${input}`);
  for (const output of Object.values(scan.metafile.outputs))
    for (const imported of output.imports)
      if (imported.external && builtins.has(imported.path))
        throw new Error(`Core imports ${imported.path}`);
  const visited = new Set();
  function visit(path) {
    if (visited.has(path)) return;
    visited.add(path);
    const source = readFileSync(path, 'utf8');
    for (const [, id] of source.matchAll(
      /(?:from\s*|import\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g,
    )) {
      if (builtins.has(id)) throw new Error(`Built core imports ${id}`);
      if (id.startsWith('./')) visit(resolve(dirname(path), id));
    }
  }
  visit(join(installed, 'dist/core.js'));
}
function verifyDeclarations() {
  for (const kind of ['worker', 'node']) {
    copyFileSync(
      join(root, `tests/fixtures/declarations/${kind}-public-api.ts`),
      join(consumer, `${kind}.ts`),
    );
    const config = join(consumer, `${kind}.json`);
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: kind === 'node' ? ['node'] : [],
          ...(kind === 'node' && {
            typeRoots: [resolve(root, 'node_modules/@types')],
          }),
          lib: ['ES2023', 'DOM', 'DOM.Iterable'],
        },
        files: [`./${kind}.ts`],
      }),
    );
    execFileSync(
      resolveNativeTypeScript7Compiler(root),
      ['--project', config],
      { cwd: consumer, stdio: 'pipe' },
    );
    execFileSync(
      process.execPath,
      [
        resolve(root, 'node_modules/@typescript/typescript6/bin/tsc6'),
        '--project',
        config,
      ],
      { cwd: consumer, stdio: 'pipe' },
    );
  }
}
try {
  mkdirSync(consumer);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.engines.node !== '>=22.12.0')
    throw new Error('Unexpected Node engine floor');
  let tarball = option('tarball');
  const checksum = option('sha256');
  if (!!tarball !== !!checksum)
    throw new Error('--tarball and --sha256 must be supplied together');
  if (tarball) {
    tarball = resolve(tarball);
    if (
      !/^[0-9a-f]{64}$/.test(checksum) ||
      createHash('sha256').update(readFileSync(tarball)).digest('hex') !==
        checksum
    )
      throw new Error('Supplied tarball SHA-256 mismatch');
  } else {
    const [packed] = JSON.parse(
      execFileSync(npm, ['pack', '--json', '--pack-destination', workspace], {
        cwd: root,
        encoding: 'utf8',
      }),
    );
    const expected = [
      'LICENSE',
      'README.md',
      'package.json',
      ...files(join(root, 'dist')).map((path) => `dist/${path}`),
    ].sort();
    if (
      JSON.stringify(packed.files.map((row) => row.path).sort()) !==
      JSON.stringify(expected)
    )
      throw new Error('Packed inventory mismatch');
    tarball = join(workspace, packed.filename);
  }
  execFileSync(npm, ['init', '--yes'], { cwd: consumer, stdio: 'ignore' });
  const installed = spawnSync(
    npm,
    [
      'install',
      '--engine-strict',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefer-offline',
      tarball,
    ],
    { cwd: consumer, encoding: 'utf8' },
  );
  if (process.argv.includes('--expect-engine-rejection')) {
    if (
      installed.status === 0 ||
      !/EBADENGINE|Unsupported engine/.test(
        installed.stdout + installed.stderr,
      ) ||
      !(installed.stdout + installed.stderr).includes(pkg.engines.node)
    )
      throw new Error('Expected an engine-strict rejection');
    console.log(`Verified ${process.version} rejects ${pkg.engines.node}`);
  } else {
    if (installed.status !== 0)
      throw new Error(installed.stdout + installed.stderr);
    await verifyCoreGraph(join(consumer, 'node_modules/librarium'));
    run([
      '--input-type=module',
      '--eval',
      `
      const expected = ${JSON.stringify({ librarium: node, 'librarium/node': node, 'librarium/core': common, 'librarium/testing': ['runStoreContract', 'RunStoreConflict'] })};
      for (const [id, names] of Object.entries(expected)) {
        if (JSON.stringify(Object.keys(await import(id)).sort()) !== JSON.stringify(names.sort())) throw new Error('Export mismatch: ' + id);
      }
      for (const id of ['librarium/cli', 'librarium/maintainer', 'librarium/package.json', 'librarium/adapters']) {
        try { await import(id); throw new Error('Unexpected public path'); } catch (e) { if (e.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw e; }
      }
      const { MemoryRunStore } = await import('librarium/core');
      await (await import('librarium/testing')).runStoreContract(new MemoryRunStore());
    `,
    ]);
    const home = join(workspace, 'home');
    mkdirSync(home);
    run(
      [
        '--input-type=module',
        '--eval',
        `
      process.argv = [process.execPath, 'librarium', 'setup'];
      process.exit = () => { throw new Error('exit on import'); };
      process.stdout.write = process.stderr.write = () => { throw new Error('output on import'); };
      for (const id of ['librarium', 'librarium/core', 'librarium/node', 'librarium/testing']) await import(id);
    `,
      ],
      consumer,
      { ...process.env, HOME: home, USERPROFILE: home },
    );
    if (readdirSync(home).length) throw new Error('Import changed HOME');
    verifyDeclarations();
    const cli = join(consumer, 'node_modules/librarium/dist/cli.js');
    run([cli, '--help']);
    if (run([cli, '--version']) !== pkg.version)
      throw new Error('CLI version mismatch');
    console.log(
      `Verified packed ${pkg.name}@${pkg.version}: inventory, exports, declarations (TS7/TS6), Worker-safe core, import side effects, stores, CLI`,
    );
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
