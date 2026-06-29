import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AsyncTaskHandle,
  Provider,
  ProviderResult,
  RunManifest,
} from '../src/types.js';

let registerProvider: typeof import('../src/adapters/index.js').registerProvider;
let checkAsyncTasks: typeof import('../src/mcp/async.js').checkAsyncTasks;
let saveAsyncTasks: typeof import('../src/core/async-manager.js').saveAsyncTasks;

/**
 * Regression for the MCP `check_async` retrieval path: a completed async result
 * retrieved via the MCP tool must persist metering on run.json and .meta.json,
 * matching the CLI `status --retrieve` path. (deep-review #1609 finding.)
 */
describe('MCP check_async retrieval persists metering', () => {
  let dir: string;

  beforeEach(async () => {
    vi.resetModules();
    registerProvider = (await import('../src/adapters/index.js'))
      .registerProvider;
    checkAsyncTasks = (await import('../src/mcp/async.js')).checkAsyncTasks;
    saveAsyncTasks = (await import('../src/core/async-manager.js'))
      .saveAsyncTasks;
    dir = join(tmpdir(), `librarium-mcp-async-${randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes metering (kind + provider_reported actual) on retrieval', async () => {
    // perplexity-sonar-deep is native_cost: retrieval reports costUsd, which the
    // metering normalization turns into a provider_reported actual lane.
    const provider: Provider = {
      id: 'perplexity-sonar-deep',
      displayName: 'Mock deep',
      tier: 'deep-research',
      envVar: 'MOCK_PPLX_KEY',
      execute: async (): Promise<ProviderResult> => ({
        provider: 'perplexity-sonar-deep',
        tier: 'deep-research',
        content: 'final',
        citations: [],
        durationMs: 1,
      }),
      retrieve: async (): Promise<ProviderResult> => ({
        provider: 'perplexity-sonar-deep',
        tier: 'deep-research',
        content: 'retrieved body',
        citations: [],
        durationMs: 10,
        usage: { costUsd: 0.42, totalTokens: 100 },
      }),
    };
    registerProvider(provider);

    const manifest: RunManifest = {
      version: 1,
      timestamp: 1_781_136_000,
      slug: 'async-meter',
      query: 'q',
      mode: 'async',
      outputDir: dir,
      providers: [
        {
          id: 'perplexity-sonar-deep',
          tier: 'deep-research',
          status: 'async-pending',
          durationMs: 0,
          wordCount: 0,
          citationCount: 0,
          outputFile: '',
          metaFile: '',
        },
      ],
      sources: { total: 0, unique: 0, file: 'sources.json' },
      asyncTasks: [],
      exitCode: 0,
    };
    writeFileSync(join(dir, 'run.json'), JSON.stringify(manifest));

    const task: AsyncTaskHandle = {
      provider: 'perplexity-sonar-deep',
      taskId: 'task-1',
      query: 'q',
      submittedAt: 1,
      status: 'completed',
      outputDir: dir,
    };
    saveAsyncTasks(dir, [task]);

    const result = await checkAsyncTasks(dir, true);
    expect(result.retrieved).toBe(1);

    // .meta.json carries metering.
    const meta = JSON.parse(
      readFileSync(join(dir, 'perplexity-sonar-deep.meta.json'), 'utf-8'),
    );
    expect(meta.metering.kind).toBe('native_cost');
    expect(meta.metering.actual).toEqual({
      costUsd: 0.42,
      source: 'provider_reported',
    });

    // run.json's folded-in provider report carries metering too.
    const updated = JSON.parse(
      readFileSync(join(dir, 'run.json'), 'utf-8'),
    ) as RunManifest;
    const report = updated.providers.find(
      (p) => p.id === 'perplexity-sonar-deep',
    );
    expect(report?.status).toBe('success');
    expect(report?.metering?.kind).toBe('native_cost');
    expect(report?.metering?.actual?.source).toBe('provider_reported');
  });
});
