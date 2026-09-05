import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const canonicalEntries = [
  '../src/commands/run.ts',
  '../src/commands/answer.ts',
  '../src/mcp/research.ts',
] as const;

const forbiddenCanonicalInputs =
  /(?:^|\/)(?:core\/run-manifest|node-run-artifacts|node-run-reconciliation(?:-runtime)?|commands\/(?:html-report-v2|jsonl-report-v2))\.ts$/;

async function inputGraph(entry: string): Promise<string[]> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    format: 'esm',
    metafile: true,
    packages: 'external',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  });
  return Object.keys(result.metafile.inputs).map((path) =>
    path.replaceAll('\\', '/'),
  );
}

describe('production execution authority graph', () => {
  for (const entry of canonicalEntries) {
    it(`${entry} reaches only the canonical run authority`, async () => {
      const inputs = await inputGraph(entry);
      expect(
        inputs.filter((path) => path.endsWith('/node-canonical-run.ts')),
      ).toHaveLength(1);
      expect(
        inputs.filter((path) => forbiddenCanonicalInputs.test(path)),
      ).toEqual([]);
      expect(inputs).toContain('src/node-run-json-lock.ts');
      expect(inputs).not.toContain('src/core/run-manifest.ts');
    });
  }

  it('keeps root and core public graphs Worker-safe and legacy-free', async () => {
    for (const entry of ['../src/index.ts', '../src/core-entry.ts']) {
      const inputs = await inputGraph(entry);
      expect(inputs.some((path) => forbiddenCanonicalInputs.test(path))).toBe(
        false,
      );
      expect(inputs.some((path) => path.startsWith('node:'))).toBe(false);
    }
  });

  it('keeps v2 reconciliation behind explicit schema routing', () => {
    const asyncSource = readFileSync(
      fileURLToPath(new URL('../src/mcp/async.ts', import.meta.url)),
      'utf8',
    );
    expect(asyncSource.indexOf('schemaVersion === 3')).toBeGreaterThan(-1);
    expect(asyncSource.indexOf('schemaVersion !== 2')).toBeGreaterThan(
      asyncSource.indexOf('schemaVersion === 3'),
    );
    expect(
      asyncSource.indexOf('createNodeRunReconciliationRuntime('),
    ).toBeGreaterThan(asyncSource.indexOf('schemaVersion !== 2'));

    const statusSource = readFileSync(
      fileURLToPath(new URL('../src/commands/status.ts', import.meta.url)),
      'utf8',
    );
    expect(statusSource).toContain('discoverCanonicalRunDirectories');
    expect(statusSource).toContain('createNodeRunReconciliationRuntime');
  });
});
