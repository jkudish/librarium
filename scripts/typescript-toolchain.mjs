import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function resolveNativeTypeScript7Compiler(root = process.cwd()) {
  const packageName = `@typescript/typescript-${process.platform}-${process.arch}`;
  const packageJsonPath = require.resolve(`${packageName}/package.json`, {
    paths: [root],
  });
  const executable = prefixWindowsLongPath(
    join(
      dirname(packageJsonPath),
      'lib',
      process.platform === 'win32' ? 'tsc.exe' : 'tsc',
    ),
  );
  statSync(executable);
  return executable;
}

export function prefixWindowsLongPath(executable, platform = process.platform) {
  if (
    platform === 'win32' &&
    executable.length >= 248 &&
    !executable.startsWith('\\\\?\\')
  ) {
    return `\\\\?\\${executable}`;
  }
  return executable;
}

export function verifyTypeScriptToolchain(root = process.cwd()) {
  const packageJson = readJson(resolve(root, 'package.json'));
  const typescriptPackage = readJson(
    resolve(root, 'node_modules/typescript/package.json'),
  );
  const compiler = resolveNativeTypeScript7Compiler(root);
  const compilerVersion = execFileSync(compiler, ['--version'], {
    encoding: 'utf8',
  }).trim();

  if (packageJson.devDependencies?.typescript !== '7.0.2') {
    throw new Error('TypeScript 7 must be pinned at 7.0.2');
  }
  if (
    typescriptPackage.version !== '7.0.2' ||
    compilerVersion !== 'Version 7.0.2'
  ) {
    throw new Error(
      `Expected native TypeScript 7.0.2, received ${compilerVersion}`,
    );
  }
  return compiler;
}
