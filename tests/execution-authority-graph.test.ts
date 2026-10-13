import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

async function inputGraph(entry: string): Promise<string[]> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    format: 'esm',
    metafile: true,
    packages: 'external',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  });
  return Object.keys(result.metafile.inputs).map((path) =>
    path.replaceAll('\\', '/'),
  );
}

describe('production execution authority graph', () => {
  for (const entry of [
    '../src/run-cli-program.ts',
    '../src/mcp/run-server.ts',
    '../src/public-entry.ts',
  ])
    it(`${entry} uses the RunStore facade and coordinator CAS`, async () => {
      const inputs = await inputGraph(entry);
      expect(inputs).toContain('src/core/librarium.ts');
      expect(inputs).toContain('src/node-run-store.ts');
      expect(inputs).toContain('src/node-run-json-lock.ts');
      expect(inputs).toContain('src/core/execution-runtime.ts');
      expect(inputs).not.toContain('src/node-canonical-run.ts');
      expect(inputs).not.toContain('src/node-run-artifacts.ts');
      expect(inputs).not.toContain('src/node-request-preflight.ts');
    });

  it('keeps the public core graph runtime-neutral', async () => {
    const inputs = await inputGraph('../src/run-core-entry.ts');
    expect(inputs).toContain('src/core/librarium.ts');
    expect(
      inputs.some((path) => /src\/(?:node-|commands\/|mcp\/)/.test(path)),
    ).toBe(false);
  });
});
