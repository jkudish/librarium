import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import type { StoredRun } from '../../src/core/run.js';
import { FilesystemRunStore } from '../../src/node-run-store.js';

it('serves complete saved evidence and exactly three tools through built stdio MCP offline', async () => {
  const home = mkdtempSync(join(tmpdir(), 'librarium-mcp-run-'));
  const runs = join(home, 'runs');
  mkdirSync(join(home, '.config/librarium'), { recursive: true });
  writeFileSync(
    join(home, '.config/librarium/config.json'),
    JSON.stringify({
      version: 3,
      sources: { exa: { key: 'env:EXA_API_KEY' } },
      max_cost: '1',
      runs: { path: runs },
    }),
  );
  const doc = JSON.parse(
    readFileSync(
      resolve('node_modules/librarium-spec/fixtures/run-store/stored-run.json'),
      'utf8',
    ),
  ) as StoredRun;
  doc.run.results[0].answer = 'Saved evidence 😀\n'.repeat(4000);
  const store = new FilesystemRunStore(runs);
  await store.save(doc, null);
  const before = await store.get(doc.run.id);
  const client = new Client({ name: 'offline', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, '../../dist/cli.js'), 'mcp'],
    cwd: home,
    env: {
      HOME: home,
      USERPROFILE: home,
      EXA_API_KEY: 'dummy',
      NODE_OPTIONS: `--import=${resolve(import.meta.dirname, '../fixtures/network-denied.mjs')}`,
    },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'research',
      'get_run',
      'list_sources',
    ]);
    expect(
      (await client.callTool({ name: 'list_sources', arguments: {} })).isError,
    ).toBeFalsy();
    expect(
      (
        await client.callTool({
          name: 'research',
          arguments: { question: 'offline', dry_run: true, wait_seconds: 0 },
        })
      ).structuredContent,
    ).toMatchObject({ status: 'planned' });
    expect(
      (
        await client.callTool({
          name: 'research',
          arguments: { question: 'offline', dry_run: true, max_cost: '2' },
        })
      ).isError,
    ).toBe(true);
    let cursor: string | undefined;
    let firstCursor: string | undefined;
    let encoded = '';
    let count = 0;
    do {
      const result = await client.callTool({
        name: 'get_run',
        arguments: {
          id: doc.run.id,
          source: doc.run.results[0].source,
          cursor,
        },
      });
      expect(result.isError).toBeFalsy();
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64000);
      const page = result.structuredContent as {
        content: string;
        cursor: string | null;
        untrusted: boolean;
      };
      expect(page.untrusted).toBe(true);
      encoded += page.content;
      cursor = page.cursor ?? undefined;
      firstCursor ??= cursor;
      count++;
    } while (cursor);
    expect(count).toBeGreaterThan(2);
    expect(JSON.parse(encoded)).toEqual({
      answer: doc.run.results[0].answer,
      citations: doc.run.results[0].citations,
    });
    expect(await store.get(doc.run.id)).toEqual(before);
    doc.run.results[0].answer = 'Changed evidence';
    await store.save(doc, before?.version as number);
    const stale = await client.callTool({
      name: 'get_run',
      arguments: {
        id: doc.run.id,
        source: doc.run.results[0].source,
        cursor: firstCursor,
      },
    });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toContain('Invalid or stale cursor');
    expect(
      (
        await client.callTool({
          name: 'get_run',
          arguments: {
            id: doc.run.id,
            source: doc.run.results[0].source,
            cursor: 'garbage',
          },
        })
      ).isError,
    ).toBe(true);
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
});
