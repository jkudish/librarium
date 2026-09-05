import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerArtifactFileNames } from '../src/node-run-artifacts.js';
import type {
  AsyncPollResult,
  AsyncTaskHandle,
  Provider,
  ProviderResult,
  RunManifest,
} from '../src/types.js';
import { seedHistoricalV2AsyncTasks } from './fixtures/historical-v2-run.js';

let registerProvider: typeof import('../src/adapters/index.js').registerProvider;
let checkAsyncTasks: typeof import('../src/mcp/async.js').checkAsyncTasks;

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
      execution: 'background',
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
      submit: async (query) => ({
        provider: 'perplexity-sonar-deep',
        taskId: 'unused',
        query,
        submittedAt: Date.now(),
        status: 'pending',
      }),
      poll: async () => ({ status: 'completed' }),
    };
    registerProvider(provider);

    const manifest: RunManifest = {
      schemaVersion: 2,
      revision: 0,
      status: 'awaiting_async',
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
          task: {
            taskId: 'task-1',
            submittedAt: 1,
            status: 'completed',
          },
        },
      ],
      sources: { total: 0, unique: 0, file: 'sources.json' },
      exitCode: null,
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
    seedHistoricalV2AsyncTasks(dir, [task]);

    const result = await checkAsyncTasks(dir, true);
    expect(result.retrieved).toBe(1);

    // .meta.json carries metering.
    const meta = JSON.parse(
      readFileSync(
        join(dir, providerArtifactFileNames('perplexity-sonar-deep').metaFile),
        'utf-8',
      ),
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
    expect(report?.task).toMatchObject({
      taskId: 'task-1',
      status: 'completed',
      retrievedAt: expect.any(Number),
    });

    // A later inspection must not present the durable historical retrieval as
    // an ordinary completed-and-unretrieved task.
    const secondPass = await checkAsyncTasks(dir, false);
    expect(secondPass.tasks).toEqual([
      expect.objectContaining({
        taskId: 'task-1',
        status: 'completed',
        retrieved: true,
      }),
    ]);
  });

  it('does not recover tasks from a corrupt run.json', async () => {
    const provider: Provider = {
      id: 'perplexity-sonar-deep',
      displayName: 'Mock deep',
      tier: 'deep-research',
      execution: 'background',
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
      submit: async (query) => ({
        provider: 'perplexity-sonar-deep',
        taskId: 'unused',
        query,
        submittedAt: Date.now(),
        status: 'pending',
      }),
      poll: async () => ({ status: 'completed' }),
    };
    registerProvider(provider);
    seedHistoricalV2AsyncTasks(dir, [
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
    expect(result).toMatchObject({ retrieved: 0, tasks: [] });
  });
});

describe('MCP check_async poll state persistence', () => {
  let dir: string;

  beforeEach(async () => {
    vi.resetModules();
    registerProvider = (await import('../src/adapters/index.js'))
      .registerProvider;
    checkAsyncTasks = (await import('../src/mcp/async.js')).checkAsyncTasks;
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
      execution: 'background',
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
      submit: async (query) => ({
        provider: 'mock-async',
        taskId: 'unused',
        query,
        submittedAt: Date.now(),
        status: 'pending',
      }),
      retrieve: async () => ({
        provider: 'mock-async',
        tier: 'deep-research',
        content: '',
        citations: [],
        durationMs: 0,
      }),
    };
    registerProvider(provider);
    seedHistoricalV2AsyncTasks(dir, [
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
      error: 'provider.poll_failed',
    });
    const persisted = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    expect(persisted.providers[0].task).toMatchObject({
      status: 'cancelled',
      providerStatus: 'CANCELLED',
      lastPollError: 'provider.poll_failed',
    });
    expect(persisted.providers[0].task.completedAt).toEqual(expect.any(Number));
    expect(persisted.providers[0].task.lastPolledAt).toEqual(
      expect.any(Number),
    );
  });

  it('keeps an unknown raw status retryable while persisting its diagnostic', async () => {
    const provider: Provider = {
      id: 'mock-unknown',
      displayName: 'Mock unknown',
      tier: 'deep-research',
      execution: 'background',
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
      submit: async (query) => ({
        provider: 'mock-unknown',
        taskId: 'unused',
        query,
        submittedAt: Date.now(),
        status: 'pending',
      }),
      retrieve: async () => ({
        provider: 'mock-unknown',
        tier: 'deep-research',
        content: '',
        citations: [],
        durationMs: 0,
      }),
    };
    registerProvider(provider);
    seedHistoricalV2AsyncTasks(dir, [
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
    });
    const persisted = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    expect(persisted.providers[0].task).toMatchObject({
      status: 'running',
      providerStatus: 'MIGRATING',
    });
    expect(persisted.providers[0].task.completedAt).toBeUndefined();
  });

  it('terminalizes a pending task whose retired provider is no longer registered', async () => {
    seedHistoricalV2AsyncTasks(dir, [
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
      error: 'provider.unavailable',
    });
    const persisted = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    expect(persisted.providers[0].task).toMatchObject({
      status: 'failed',
      providerStatus: 'unsupported_provider',
      lastPollError: 'provider.unavailable',
    });
    expect(persisted.providers[0].task.completedAt).toEqual(expect.any(Number));
  });
});
