import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { createRunManifest } from '../../src/core/run-manifest.js';
import {
  CONTENT_DELIMITER_BEGIN,
  CONTENT_DELIMITER_END,
  type resultPage,
} from '../../src/mcp/result-pages.js';

it('serves complete saved evidence through the built stdio MCP without changing artifacts', async () => {
  const home = mkdtempSync(resolve(tmpdir(), 'librarium-mcp-stdio-'));
  const runDir = resolve(home, 'runs/example');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(resolve(home, '.config/librarium'), { recursive: true });
  writeFileSync(
    resolve(home, '.config/librarium/config.json'),
    JSON.stringify({
      version: 1,
      defaults: { outputDir: resolve(home, 'runs') },
      providers: {},
      groups: {},
      customProviders: {},
      trustedProviderIds: [],
    }),
  );
  const content = 'Saved evidence 😀\n'.repeat(4000);
  writeFileSync(resolve(runDir, 'saved.md'), content);
  createRunManifest(runDir, {
    status: 'completed',
    timestamp: 1,
    slug: 'example',
    query: 'Offline saved evidence',
    mode: 'sync',
    outputDir: runDir,
    providers: [
      {
        id: 'saved',
        tier: 'ai-grounded',
        status: 'success',
        durationMs: 1,
        wordCount: 8000,
        citationCount: 0,
        outputFile: 'saved.md',
        metaFile: 'saved.meta.json',
      },
    ],
    sources: { total: 0, unique: 0, file: 'sources.json' },
    exitCode: 0,
  });
  const before = Object.fromEntries(
    readdirSync(runDir).map((name) => [
      name,
      readFileSync(resolve(runDir, name)),
    ]),
  );
  const client = new Client({ name: 'stdio-pages-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, '../../dist/cli.js'), 'mcp'],
    cwd: home,
    env: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: resolve(home, '.config'),
    },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(
      tools.find(({ name }) => name === 'get_results')?.annotations
        ?.readOnlyHint,
    ).toBe(true);
    let cursor: string | undefined;
    let restored = '';
    let count = 0;
    do {
      const result = await client.callTool({
        name: 'get_results',
        arguments: { runDir, provider: 'saved', cursor },
      });
      expect(result.isError).toBeFalsy();
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        64_000,
      );
      const page = result.structuredContent as ReturnType<typeof resultPage>;
      expect(page.kind).toBe('librarium.mcp.evidence-page');
      const chunk = page.results[0];
      expect(chunk.offset).toBe(restored.length);
      expect(chunk.content.startsWith(`${CONTENT_DELIMITER_BEGIN}\n`)).toBe(
        true,
      );
      expect(chunk.content.endsWith(`\n${CONTENT_DELIMITER_END}`)).toBe(true);
      restored += chunk.content.slice(
        CONTENT_DELIMITER_BEGIN.length + 1,
        -CONTENT_DELIMITER_END.length - 1,
      );
      cursor = page.nextCursor ?? undefined;
      expect(++count).toBeLessThan(100);
    } while (cursor);
    expect(count).toBeGreaterThan(1);
    expect(restored).toBe(content);
    expect(
      Object.fromEntries(
        readdirSync(runDir).map((name) => [
          name,
          readFileSync(resolve(runDir, name)),
        ]),
      ),
    ).toEqual(before);
  } finally {
    await client.close();
    await transport.close();
    rmSync(home, { recursive: true, force: true });
  }
});
