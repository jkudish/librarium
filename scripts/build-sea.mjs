#!/usr/bin/env node

/**
 * Build a standalone executable using Node.js Single Executable Applications (SEA).
 *
 * Steps:
 *   1. Bundle src/cli.ts into dist/cli-sea.cjs (CJS, all deps inlined) via esbuild
 *   2. Generate SEA blob from the CJS bundle
 *   3. Copy the current Node binary and inject the blob with postject
 *
 * Output: dist/librarium (or dist/librarium.exe on Windows)
 */

import { execFileSync, execSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { platform, arch } from 'node:os';

const DIST = 'dist';
const SEA_CONFIG = join(DIST, 'sea-config.json');
const CJS_BUNDLE = join(DIST, 'cli-sea.cjs');
const SEA_BLOB = join(DIST, 'sea-prep.blob');

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));

const os = platform();
const cpu = arch();
const isWindows = os === 'win32';
const isMac = os === 'darwin';

const binaryName = isWindows
  ? `librarium-windows-${cpu}.exe`
  : `librarium-${isMac ? 'macos' : 'linux'}-${cpu}`;

const outputPath = join(DIST, binaryName);

console.log(`Building standalone binary for ${os}-${cpu}...`);
console.log(`  Version: ${pkg.version}`);
console.log(`  Output:  ${outputPath}`);

// Step 1: Bundle with esbuild into CJS (SEA requires CJS)
console.log('\n1. Bundling with esbuild...');
execFileSync('npx', ['esbuild', 'src/cli.ts', '--bundle', '--platform=node', '--target=node20', '--format=cjs', `--outfile=${CJS_BUNDLE}`, `--define:__VERSION__="${pkg.version}"`, '--external:fsevents'], {
  stdio: 'inherit',
});

// Step 2: Generate SEA config and blob
console.log('\n2. Generating SEA blob...');
writeFileSync(SEA_CONFIG, JSON.stringify({
  main: CJS_BUNDLE,
  output: SEA_BLOB,
  disableExperimentalSEAWarning: true,
  useCodeCache: true,
}, null, 2));

execFileSync(process.execPath, ['--experimental-sea-config', SEA_CONFIG], {
  stdio: 'inherit',
});

// Step 3: Copy node binary
console.log('\n3. Copying Node.js binary...');
copyFileSync(process.execPath, outputPath);

// Step 4: Remove macOS code signature (required before injection)
if (isMac) {
  console.log('   Removing macOS code signature...');
  execSync(`codesign --remove-signature "${outputPath}"`);
}

// Step 5: Inject SEA blob with postject
console.log('\n4. Injecting SEA blob...');
const sentinel = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const postjectArgs = [
  'npx', 'postject', outputPath, 'NODE_SEA_BLOB', SEA_BLOB,
  '--sentinel-fuse', sentinel,
];

if (isMac) {
  postjectArgs.push('--macho-segment-name', 'NODE_SEA');
}

execFileSync(postjectArgs[0], postjectArgs.slice(1), {
  stdio: 'inherit',
});

// Step 6: Re-sign on macOS (ad-hoc signature)
if (isMac) {
  console.log('   Re-signing binary (ad-hoc)...');
  execSync(`codesign --sign - "${outputPath}"`);
}

// Step 7: Ensure executable
if (!isWindows) {
  chmodSync(outputPath, 0o755);
}

console.log(`\nDone! Binary: ${outputPath}`);
