import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';

function assertNoExistingSymlink(path: string, description: string): boolean {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`Refusing symlink snapshot ${description}: ${path}`);
    }
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

function assertContained(
  boundary: string,
  candidate: string,
  description: string,
): void {
  const pathFromBoundary = relative(boundary, candidate);
  if (
    pathFromBoundary === '..' ||
    pathFromBoundary.startsWith(`..${sep}`) ||
    isAbsolute(pathFromBoundary)
  ) {
    throw new Error(`Refusing snapshot ${description} outside safe boundary`);
  }
}

function nearestExistingAncestor(path: string): string {
  let currentPath = path;
  while (!assertNoExistingSymlink(currentPath, 'root ancestor')) {
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath)
      throw new Error(`Unable to establish safe snapshot boundary: ${path}`);
    currentPath = parentPath;
  }
  return currentPath;
}

export function resolveSnapshotWritePath(
  root: string,
  relativePath: string,
): string {
  if (
    relativePath.includes('\\') ||
    isAbsolute(relativePath) ||
    win32.isAbsolute(relativePath) ||
    relativePath.split('/').includes('..')
  ) {
    throw new Error(`Refusing unsafe snapshot output path: ${relativePath}`);
  }

  const resolvedRoot = resolve(root);
  const safeBoundary = nearestExistingAncestor(resolvedRoot);
  assertContained(safeBoundary, resolvedRoot, 'root');
  const outputPath = resolve(resolvedRoot, relativePath);
  const pathFromRoot = relative(resolvedRoot, outputPath);
  if (
    pathFromRoot === '' ||
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(`Refusing to write outside snapshot root: ${relativePath}`);
  }

  assertContained(resolvedRoot, outputPath, 'target');

  if (!assertNoExistingSymlink(resolvedRoot, 'root')) return outputPath;

  let currentPath = resolvedRoot;
  const pathSegments = pathFromRoot.split(sep);
  for (const [index, segment] of pathSegments.entries()) {
    currentPath = resolve(currentPath, segment);
    const description =
      index === pathSegments.length - 1 ? 'target' : 'ancestor';
    if (!assertNoExistingSymlink(currentPath, description)) break;
  }

  return outputPath;
}
