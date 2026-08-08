import { lstatSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';

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

  if (!assertNoExistingSymlink(resolvedRoot, 'root')) {
    return outputPath;
  }

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
