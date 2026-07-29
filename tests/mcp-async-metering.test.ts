import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AsyncPollResult,
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
      asyncTasks: [
        {
          provider: 'perplexity-sonar-deep',
          taskId: 'task-1',
          query: 'q',
          submittedAt: 1,
          status: 'completed',
          outputDir: dir,
        },
      ],
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
    expect(updated.asyncTasks).toEqual([]);
  });

  it('keeps the completed handle when run.json cannot be reconciled', async () => {
    const provider: Provider = {
      id: 'perplexity-sonar-deep',
      displayName: 'Mock deep',
      tier: 'deep-research',
      envVar: 'MOCK_PPLX_KEY',
      execute: async (): Promise<ProviderResult> => ({
        provider: 'perplexity-sonar-deep',
        tier: 'deep-research',
        content: '',
        citations: [],
        durationMs: 0,
      }),
      retrieve: async (): Promise<ProviderResult> => ({
        provider: 'perplexity-sonar-deep',
        tier: 'deep-research',
        content: 'retrieved body',
        citations: [],
        durationMs: 1,
      }),
    };
    registerProvider(provider);
    saveAsyncTasks(dir, [
      {
        provider: 'perplexity-sonar-deep',
        taskId: 'task-1',
        query: 'q',
        submittedAt: 1,
        status: 'completed',
        outputDir: dir,
      },
    ]);
    writeFileSync(join(dir, 'run.json'), '{ malformed');

    const result = await checkAsyncTasks(dir, true);

    expect(result.retrieved).toBe(0);
    expect(result.tasks[0]).toMatchObject({
      status: 'completed',
      retrieveError: 'Retrieved result, but could not update run.json',
    });
    const persisted = JSON.parse(
      readFileSync(join(dir, 'async-tasks.json'), 'utf8'),
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0].taskId).toBe('task-1');
  });
});

describe('MCP check_async poll state persistence', () => {
  let dir: string;

  beforeEach(async () => {
    vi.resetModules();
    registerProvider = (await import('../src/adapters/index.js'))
      .registerProvider;
    checkAsyncTasks = (await import('../src/mcp/async.js')).checkAsyncTasks;
    saveAsyncTasks = (await import('../src/core/async-manager.js'))
      .saveAsyncTasks;
    dir = join(tmpdir(), `librarium-mcp-poll-${randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists a terminal cancelled state plus raw provider status', async () => {
    const provider: Provider = {
      id: 'mock-async',
      displayName: 'Mock async',
      tier: 'deep-research',
      envVar: 'MOCK_KEY',
      execute: async (): Promise<ProviderResult> => ({
        provider: 'mock-async',
        tier: 'deep-research',
        content: '',
        citations: [],
        durationMs: 0,
      }),
      poll: async (): Promise<AsyncPollResult> => ({
        status: 'cancelled',
        rawStatus: 'CANCELLED',
        message: 'cancelled by provider',
      }),
    };
    registerProvider(provider);
    saveAsyncTasks(dir, [
      {
        provider: 'mock-async',
        taskId: 'task-cancelled',
        query: 'q',
        submittedAt: 1,
        status: 'running',
      },
    ]);

    const result = await checkAsyncTasks(dir, false);
    expect(result.tasks[0]).toMatchObject({
      status: 'cancelled',
      providerStatus: 'CANCELLED',
      error: 'cancelled by provider',
    });
    const persisted = JSON.parse(
      readFileSync(join(dir, 'async-tasks.json'), 'utf8'),
    );
    expect(persisted[0]).toMatchObject({
      status: 'cancelled',
      providerStatus: 'CANCELLED',
      lastPollError: 'cancelled by provider',
    });
    expect(persisted[0].completedAt).toEqual(expect.any(Number));
    expect(persisted[0].lastPolledAt).toEqual(expect.any(Number));
  });

  it('keeps an unknown raw status retryable while persisting its diagnostic', async () => {
    const provider: Provider = {
      id: 'mock-unknown',
      displayName: 'Mock unknown',
      tier: 'deep-research',
      envVar: 'MOCK_KEY',
      execute: async (): Promise<ProviderResult> => ({
        provider: 'mock-unknown',
        tier: 'deep-research',
        content: '',
        citations: [],
        durationMs: 0,
      }),
      poll: async (): Promise<AsyncPollResult> => ({
        status: 'running',
        rawStatus: 'MIGRATING',
        message: 'Unknown remote status: MIGRATING',
      }),
    };
    registerProvider(provider);
    saveAsyncTasks(dir, [
      {
        provider: 'mock-unknown',
        taskId: 'task-unknown',
        query: 'q',
        submittedAt: 1,
        status: 'running',
      },
    ]);

    const result = await checkAsyncTasks(dir, false);
    expect(result.tasks[0]).toMatchObject({
      status: 'running',
      providerStatus: 'MIGRATING',
      error: 'Unknown remote status: MIGRATING',
    });
    const persisted = JSON.parse(
      readFileSync(join(dir, 'async-tasks.json'), 'utf8'),
    );
    expect(persisted[0]).toMatchObject({
      status: 'running',
      providerStatus: 'MIGRATING',
      lastPollError: 'Unknown remote status: MIGRATING',
    });
    expect(persisted[0].completedAt).toBeUndefined();
  });

  it('terminalizes a pending task whose retired provider is no longer registered', async () => {
    saveAsyncTasks(dir, [
      {
        provider: 'openai-deep',
        taskId: 'retired-task',
        query: 'q',
        submittedAt: 1,
        status: 'pending',
      },
    ]);

    const result = await checkAsyncTasks(dir, false);
    expect(result.tasks[0]).toMatchObject({
      status: 'failed',
      providerStatus: 'unsupported_provider',
      error: 'Provider openai-deep does not support polling after this upgrade',
    });
    const persisted = JSON.parse(
      readFileSync(join(dir, 'async-tasks.json'), 'utf8'),
    );
    expect(persisted[0]).toMatchObject({
      status: 'failed',
      providerStatus: 'unsupported_provider',
      lastPollError:
        'Provider openai-deep does not support polling after this upgrade',
    });
    expect(persisted[0].completedAt).toEqual(expect.any(Number));
  });
});
