import { describe, expect, it } from 'vitest';
import { prefixWindowsLongPath } from '../scripts/typescript-toolchain.mjs';

describe('TypeScript toolchain', () => {
  it('prefixes only Windows compiler paths at the long-path boundary', () => {
    const boundaryPath = `C:\\${'a'.repeat(245)}`;

    expect(boundaryPath).toHaveLength(248);
    expect(prefixWindowsLongPath(boundaryPath, 'win32')).toBe(
      `\\\\?\\${boundaryPath}`,
    );
    expect(prefixWindowsLongPath(boundaryPath, 'darwin')).toBe(boundaryPath);
    expect(prefixWindowsLongPath('C:\\short\\tsc.exe', 'win32')).toBe(
      'C:\\short\\tsc.exe',
    );
    expect(prefixWindowsLongPath(`\\\\?\\${boundaryPath}`, 'win32')).toBe(
      `\\\\?\\${boundaryPath}`,
    );
  });
});
