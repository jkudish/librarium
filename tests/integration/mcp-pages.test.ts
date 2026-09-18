import { spawnSync } from 'node:child_process';
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
import { loadConfig, loadProjectConfig } from '../../src/core/config.js';
import {
  createRunManifest,
  readRunManifest,
} from '../../src/core/run-manifest.js';
import {
  CONTENT_DELIMITER_BEGIN,
  CONTENT_DELIMITER_END,
  type resultPage,
} from '../../src/mcp/result-pages.js';
import {
  readCanonicalRunManifest,
  readRunJsonSchemaVersion,
} from '../../src/node-canonical-run.js';

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
      NODE_OPTIONS: `--import=${resolve(import.meta.dirname, '../fixtures/network-denied.mjs')}`,
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

it('keeps historical and malformed-file diagnostics private through built stdio and offline doctor', async () => {
  const home = mkdtempSync(resolve(tmpdir(), 'librarium-mcp-private-'));
  const runDir = resolve(home, 'runs/example');
  const configPath = resolve(home, '.config/librarium/config.json');
  const projectPath = resolve(home, '.librarium.json');
  const manifestPath = resolve(runDir, 'run.json');
  const cli = resolve(import.meta.dirname, '../../dist/cli.js');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(resolve(home, '.config/librarium'), { recursive: true });
  const config = JSON.stringify({
    version: 1,
    defaults: { outputDir: resolve(home, 'runs') },
    providers: {},
    groups: {},
    customProviders: {},
    trustedProviderIds: [],
  });
  writeFileSync(configPath, config);
  createRunManifest(runDir, {
    status: 'failed',
    timestamp: 1,
    slug: 'example',
    query: 'Offline',
    mode: 'sync',
    outputDir: runDir,
    providers: [
      {
        id: 'saved',
        tier: 'ai-grounded',
        status: 'error',
        durationMs: 1,
        wordCount: 0,
        citationCount: 0,
        outputFile: 'saved.md',
        metaFile: 'saved.meta.json',
        error:
          'API returned 401: https://example.invalid/?api_key=HISTORICAL_PRIVATE',
      },
    ],
    sources: { total: 0, unique: 0, file: 'sources.json' },
    exitCode: 2,
  });
  const env = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: resolve(home, '.config'),
    NODE_OPTIONS: `--import=${resolve(import.meta.dirname, '../fixtures/network-denied.mjs')}`,
  };
  const client = new Client({ name: 'private-errors-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp'],
    cwd: home,
    env,
    stderr: 'pipe',
  });
  const safe = (value: unknown) => {
    expect(JSON.stringify(value)).not.toMatch(
      /HISTORICAL_PRIVATE|HANDLE_PRIVATE|CONFIG_PRIVATE/,
    );
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(
      64_000,
    );
  };
  try {
    await client.connect(transport);
    const historicalBefore = readFileSync(manifestPath);
    expect(historicalBefore.toString()).toContain('HISTORICAL_PRIVATE');
    for (const part of ['content', 'citations']) {
      const result = await client.callTool({
        name: 'get_results',
        arguments: { runDir, part },
      });
      expect(result.isError).toBeFalsy();
      safe(result);
      expect(
        (result.structuredContent as ReturnType<typeof resultPage>).results[0]
          .error,
      ).toBe('Saved provider diagnostic omitted. Inspect the run locally.');
    }
    expect(readFileSync(manifestPath)).toEqual(historicalBefore);
    for (const raw of [
      '{"schemaVersion":3,"taskId":HANDLE_PRIVATE}',
      '{"schemaVersion":3,"HANDLE_PRIVATE":true}',
      '{"schemaVersion":2,"taskId":HANDLE_PRIVATE}',
    ]) {
      writeFileSync(manifestPath, raw);
      const result = await client.callTool({
        name: 'get_results',
        arguments: { runDir },
      });
      expect(result.isError).toBe(true);
      safe(result);
      expect(readFileSync(manifestPath, 'utf8')).toBe(raw);
      for (const read of [
        () => readCanonicalRunManifest(resolve(home, 'runs'), runDir),
        () =>
          raw.includes('taskId')
            ? readRunJsonSchemaVersion(resolve(home, 'runs'), runDir)
            : readRunManifest(runDir),
      ]) {
        expect(read).toThrow();
        try {
          read();
        } catch (error) {
          safe((error as Error).message);
        }
      }
    }
    for (const target of [configPath, projectPath]) {
      for (const raw of [
        '{"apiKey":CONFIG_PRIVATE}',
        '{"providers":{"CONFIG_PRIVATE":{"enabled":"invalid"}}}',
        target === configPath
          ? '{"version":2,"CONFIG_PRIVATE":true}'
          : '{"defaults":{"mode":"CONFIG_PRIVATE"}}',
      ]) {
        writeFileSync(configPath, config);
        writeFileSync(target, raw);
        const result = await client.callTool({
          name: 'list_providers',
          arguments: {},
        });
        expect(result.isError).toBe(true);
        safe(result);
        const read =
          target === configPath
            ? () => loadConfig(configPath)
            : () => loadProjectConfig(home);
        expect(read).toThrow();
        try {
          read();
        } catch (error) {
          safe((error as Error).message);
        }
        const doctor = spawnSync(process.execPath, [cli, 'doctor', '--json'], {
          cwd: home,
          env,
          encoding: 'utf8',
        });
        expect(doctor.status).toBe(1);
        safe(doctor.stdout);
        safe(doctor.stderr);
        expect(readFileSync(target, 'utf8')).toBe(raw);
      }
      if (target === projectPath) rmSync(projectPath);
    }
  } finally {
    await client.close();
    await transport.close();
    rmSync(home, { recursive: true, force: true });
  }
});
