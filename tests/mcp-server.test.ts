import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ResearchInputError,
  type SilentRunResult,
} from '../src/mcp/research.js';
import { createMcpServer } from '../src/mcp/server.js';
import {
  MAX_PROVIDER_CHARS,
  MAX_SOURCES,
  readRunResults,
  resolveRunDir,
  shapeResearchResult,
  truncateProviderContent,
} from '../src/mcp/shaping.js';
import type {
  Config,
  DeduplicatedSource,
  ProviderReport,
  RunManifest,
} from '../src/types.js';

let baseDir: string;

function makeConfig(overrides: Partial<Config['defaults']> = {}): Config {
  return {
    version: 1,
    defaults: {
      outputDir: baseDir,
      maxParallel: 6,
      timeout: 30,
      asyncTimeout: 1800,
      asyncPollInterval: 10,
      mode: 'mixed',
      ...overrides,
    },
    providers: {
      exa: { enabled: true },
      'brave-search': { enabled: false },
    },
    customProviders: {},
    trustedProviderIds: [],
    groups: { quick: ['exa'], deep: ['openai-deep'] },
  };
}

function makeManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    version: 1,
    timestamp: 1_781_136_000,
    slug: 'q',
    query: 'test query',
    mode: 'mixed',
    outputDir: join(baseDir, 'q'),
    providers: [],
    sources: { total: 0, unique: 0, file: 'sources.json' },
    asyncTasks: [],
    exitCode: 0,
    ...overrides,
  };
}

function makeRunResult(
  manifest: RunManifest,
  sources: DeduplicatedSource[] = [],
): SilentRunResult {
  return {
    manifest,
    reports: manifest.providers,
    results: [],
    sources,
    totalCitations: manifest.sources.total,
    totalDurationMs: 1234,
  };
}

function report(
  over: Partial<ProviderReport> & { id: string },
): ProviderReport {
  return {
    tier: 'ai-grounded',
    status: 'success',
    durationMs: 100,
    wordCount: 50,
    citationCount: 3,
    outputFile: `${over.id}.md`,
    metaFile: `${over.id}.meta.json`,
    ...over,
  };
}

beforeEach(() => {
  baseDir = join(
    tmpdir(),
    `librarium-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(baseDir, { recursive: true });
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

/** Connect an in-memory client to a server built with the given deps. */
async function connect(deps: Parameters<typeof createMcpServer>[0]) {
  const server = createMcpServer({ onWarn: () => {}, ...deps });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

describe('mcp tool surface', () => {
  it('exposes all five tools', async () => {
    const { client, server } = await connect({
      loadMergedConfig: () => makeConfig(),
      initialize: vi.fn().mockResolvedValue({
        warnings: [],
        loadedCustomProviders: [],
        skippedCustomProviders: [],
      }),
    });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_async',
      'get_results',
      'list_groups',
      'list_providers',
      'research',
    ]);
    await server.close();
  });

  it('list_groups returns configured groups', async () => {
    const { client, server } = await connect({
      loadMergedConfig: () => makeConfig(),
    });
    const res = await client.callTool({ name: 'list_groups', arguments: {} });
    const payload = JSON.parse((res.content as { text: string }[])[0].text);
    expect(payload.groups).toEqual([
      { name: 'quick', members: ['exa'] },
      { name: 'deep', members: ['openai-deep'] },
    ]);
    await server.close();
  });
});

describe('research tool', () => {
  it('runs and returns a shaped result without inlining provider content', async () => {
    const manifest = makeManifest({
      providers: [report({ id: 'exa', wordCount: 200, citationCount: 5 })],
      sources: { total: 5, unique: 4, file: 'sources.json' },
    });
    const runResearch = vi.fn().mockResolvedValue(
      makeRunResult(manifest, [
        {
          url: 'https://a.com',
          normalizedUrl: 'a.com',
          title: 'A',
          providers: ['exa'],
          citationCount: 3,
        },
      ]),
    );
    const { client, server } = await connect({ runResearch });

    const res = await client.callTool({
      name: 'research',
      arguments: { query: 'best postgres pooling', group: 'quick' },
    });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse((res.content as { text: string }[])[0].text);

    expect(runResearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'best postgres pooling',
        group: 'quick',
      }),
      expect.anything(),
    );
    expect(payload.outputDir).toBe(manifest.outputDir);
    expect(payload.tallies).toEqual({
      succeeded: 1,
      failed: 0,
      pending: 0,
      skipped: 0,
    });
    expect(payload.providers[0].id).toBe('exa');
    // No full provider markdown inlined.
    expect(JSON.stringify(payload)).not.toContain('content');
    expect(payload.sources.items[0].url).toBe('https://a.com');
    await server.close();
  });

  it('rejects an empty query at the schema boundary', async () => {
    const runResearch = vi.fn();
    const { client, server } = await connect({ runResearch });
    const res = await client.callTool({
      name: 'research',
      arguments: { query: '' },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain('validation');
    expect(runResearch).not.toHaveBeenCalled();
    await server.close();
  });

  it('surfaces a ResearchInputError as a tool error, not a thrown exception', async () => {
    const runResearch = vi
      .fn()
      .mockRejectedValue(new ResearchInputError('Unknown group: __nope__'));
    const { client, server } = await connect({ runResearch });
    const res = await client.callTool({
      name: 'research',
      arguments: { query: 'x', group: '__nope__' },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toContain('Unknown group');
    await server.close();
  });

  it('surfaces a provider/run failure as a detailed tool error', async () => {
    const runResearch = vi.fn().mockRejectedValue(new Error('HTTP 500 boom'));
    const { client, server } = await connect({ runResearch });
    const res = await client.callTool({
      name: 'research',
      arguments: { query: 'x' },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain(
      'HTTP 500 boom',
    );
    await server.close();
  });
});

describe('get_results tool', () => {
  it('reads provider markdown from the most recent run and caps it', async () => {
    const runDir = join(baseDir, 'q');
    mkdirSync(runDir, { recursive: true });
    const big = 'x'.repeat(MAX_PROVIDER_CHARS + 5000);
    writeFileSync(join(runDir, 'exa.md'), big);
    const manifest = makeManifest({
      outputDir: runDir,
      providers: [report({ id: 'exa' })],
    });
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(manifest));

    const { client, server } = await connect({
      loadMergedConfig: () => makeConfig(),
    });
    const res = await client.callTool({ name: 'get_results', arguments: {} });
    const payload = JSON.parse((res.content as { text: string }[])[0].text);
    expect(payload.runDir).toBe(runDir);
    expect(payload.results[0].truncated).toBe(true);
    expect(payload.results[0].fullChars).toBe(big.length);
    expect(payload.results[0].content.length).toBeLessThan(big.length);
    expect(payload.results[0].content).toContain('truncated');
    await server.close();
  });

  it('errors when no runs exist', async () => {
    const { client, server } = await connect({
      loadMergedConfig: () => makeConfig(),
    });
    const res = await client.callTool({ name: 'get_results', arguments: {} });
    expect(res.isError).toBe(true);
    await server.close();
  });
});

describe('shaping helpers', () => {
  it('truncateProviderContent leaves short content untouched', () => {
    const r = truncateProviderContent('short');
    expect(r.truncated).toBe(false);
    expect(r.content).toBe('short');
  });

  it('shapeResearchResult caps sources and flags truncation', () => {
    const sources: DeduplicatedSource[] = Array.from(
      { length: MAX_SOURCES + 10 },
      (_, i) => ({
        url: `https://s${i}.com`,
        normalizedUrl: `s${i}.com`,
        providers: ['exa'],
        citationCount: 1,
      }),
    );
    const manifest = makeManifest({
      providers: [report({ id: 'exa' })],
      sources: { total: 40, unique: sources.length, file: 'sources.json' },
    });
    const shaped = shapeResearchResult(makeRunResult(manifest, sources));
    expect(shaped.sources.shown).toBe(MAX_SOURCES);
    expect(shaped.sources.truncated).toBe(true);
    expect(shaped.sources.items).toHaveLength(MAX_SOURCES);
  });

  it('resolveRunDir returns null for a missing explicit dir', () => {
    expect(resolveRunDir(baseDir, join(baseDir, 'nope'))).toBeNull();
  });

  it('readRunResults returns null for a dir without a manifest', () => {
    expect(readRunResults(baseDir)).toBeNull();
  });
});
