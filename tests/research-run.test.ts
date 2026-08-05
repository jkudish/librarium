import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaseProvider } from '../src/adapters/base.js';
import {
  defaultRunManifestStore,
  executeResearchRun,
  type ProviderRegistry,
  type ResearchRunEvent,
  type RunManifestStore,
} from '../src/core/research-run.js';
import { readRunManifest } from '../src/core/run-manifest.js';
import type {
  AsyncTaskHandle,
  Config,
  ProviderOptions,
  ProviderReport,
  ProviderResult,
} from '../src/types.js';

const config: Config = {
  version: 1,
  defaults: {
    outputDir: '',
    maxParallel: 1,
    timeout: 30,
    asyncTimeout: 1800,
    asyncPollInterval: 10,
    mode: 'mixed',
    llmWebSearch: true,
  },
  providers: { embedded: { enabled: true } },
  customProviders: {},
  trustedProviderIds: [],
  groups: {},
};

class EmbeddedProvider extends BaseProvider {
  readonly id = 'embedded';
  readonly tier = 'raw-search' as const;
  readonly requiresApiKey = false;

  async execute(
    _query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const response = await this.request<{ answer: string }>(
      'https://example.test/research',
      { timeout: options.timeout },
    );
    return {
      provider: this.id,
      tier: this.tier,
      content: response.data.answer,
      citations: [{ provider: this.id, url: 'https://example.test/source' }],
      durationMs: response.durationMs,
    };
  }
}

describe('executeResearchRun', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses injected registry, task store, and HTTP client with typed events', async () => {
    const outputDir = join(
      tmpdir(),
      `librarium-service-${crypto.randomUUID()}`,
    );
    dirs.push(outputDir);
    mkdirSync(outputDir, { recursive: true });
    const provider = new EmbeddedProvider();
    const registry: ProviderRegistry = {
      getProvider: (id) => (id === provider.id ? provider : undefined),
      getAllProviders: () => [provider],
    };
    const httpClient = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      data: { answer: 'Embedded result' },
      headers: {},
      durationMs: 7,
    }));
    const create = vi.fn(defaultRunManifestStore.create);
    const taskStore: RunManifestStore = {
      ...defaultRunManifestStore,
      create,
    };
    const events: ResearchRunEvent[] = [];

    const result = await executeResearchRun(
      {
        query: 'dependency injection',
        config: { ...config, defaults: { ...config.defaults, outputDir } },
        providerIds: [provider.id],
        outputDir,
        slug: 'dependency-injection',
        onEvent: (event) => events.push(event),
      },
      { providerRegistry: registry, taskStore, httpClient },
    );

    expect(httpClient).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual([
      'manifest-created',
      'dispatch-progress',
      'dispatch-progress',
      'dispatch-completed',
      'completed',
    ]);
    expect(result.manifest).toMatchObject({
      schemaVersion: 2,
      status: 'completed',
      exitCode: 0,
    });
    expect(readFileSync(join(outputDir, 'embedded.md'), 'utf8')).toBe(
      'Embedded result',
    );
    expect(existsSync(join(outputDir, 'embedded.meta.json'))).toBe(true);
    expect(existsSync(join(outputDir, 'sources.json'))).toBe(true);
    expect(existsSync(join(outputDir, 'summary.md'))).toBe(true);
    expect(existsSync(join(outputDir, 'prompt.md'))).toBe(true);
  });

  it('fails open when an observer or post-dispatch hook throws', async () => {
    const outputDir = join(tmpdir(), `librarium-events-${crypto.randomUUID()}`);
    dirs.push(outputDir);
    const provider = new EmbeddedProvider();
    const registry: ProviderRegistry = {
      getProvider: () => provider,
      getAllProviders: () => [provider],
    };

    const events: ResearchRunEvent[] = [];
    let postDispatchStartedAfterDispatch = false;
    const result = await executeResearchRun(
      {
        query: 'observer isolation',
        config: { ...config, defaults: { ...config.defaults, outputDir } },
        providerIds: [provider.id],
        outputDir,
        slug: 'observer-isolation',
        onEvent: (event) => {
          events.push(event);
        },
        postDispatch: async () => {
          postDispatchStartedAfterDispatch =
            events.at(-1)?.type === 'dispatch-completed';
          throw new Error('hook exploded');
        },
      },
      {
        providerRegistry: registry,
        httpClient: async () => ({
          status: 200,
          statusText: 'OK',
          data: { answer: 'Still completed' },
          headers: {},
          durationMs: 1,
        }),
      },
    );

    expect(result.manifest.status).toBe('completed');
    expect(postDispatchStartedAfterDispatch).toBe(true);
    expect(events).toContainEqual({
      type: 'post-dispatch-warning',
      message: 'hook exploded',
    });
  });

  it('isolates rejecting async observers', async () => {
    const outputDir = join(tmpdir(), `librarium-async-${crypto.randomUUID()}`);
    dirs.push(outputDir);
    const provider = new EmbeddedProvider();

    const result = await executeResearchRun(
      {
        query: 'async observer isolation',
        config: { ...config, defaults: { ...config.defaults, outputDir } },
        providerIds: [provider.id],
        outputDir,
        slug: 'async-observer-isolation',
        onEvent: async () => {
          throw new Error('async observer exploded');
        },
      },
      {
        providerRegistry: {
          getProvider: () => provider,
          getAllProviders: () => [provider],
        },
        httpClient: async () => ({
          status: 200,
          statusText: 'OK',
          data: { answer: 'Still completed asynchronously' },
          headers: {},
          durationMs: 1,
        }),
      },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(result.manifest.status).toBe('completed');
  });

  it('keeps HTTP overrides isolated across concurrent and later runs', async () => {
    const outputDirA = join(
      tmpdir(),
      `librarium-client-a-${crypto.randomUUID()}`,
    );
    const outputDirB = join(
      tmpdir(),
      `librarium-client-b-${crypto.randomUUID()}`,
    );
    dirs.push(outputDirA, outputDirB);
    const defaultClient = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      data: { answer: 'Default transport' },
      headers: {},
      durationMs: 1,
    }));
    const provider = new EmbeddedProvider({ httpClient: defaultClient });
    const registry: ProviderRegistry = {
      getProvider: () => provider,
      getAllProviders: () => [provider],
    };
    const clientA = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      data: { answer: 'Transport A' },
      headers: {},
      durationMs: 1,
    }));
    const clientB = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      data: { answer: 'Transport B' },
      headers: {},
      durationMs: 1,
    }));

    const [runA, runB] = await Promise.all([
      executeResearchRun(
        {
          query: 'client a',
          config: {
            ...config,
            defaults: { ...config.defaults, outputDir: outputDirA },
          },
          providerIds: [provider.id],
          outputDir: outputDirA,
          slug: 'client-a',
        },
        { providerRegistry: registry, httpClient: clientA },
      ),
      executeResearchRun(
        {
          query: 'client b',
          config: {
            ...config,
            defaults: { ...config.defaults, outputDir: outputDirB },
          },
          providerIds: [provider.id],
          outputDir: outputDirB,
          slug: 'client-b',
        },
        { providerRegistry: registry, httpClient: clientB },
      ),
    ]);

    expect(runA.results[0]?.text).toBe('Transport A');
    expect(runB.results[0]?.text).toBe('Transport B');
    expect(clientA).toHaveBeenCalledOnce();
    expect(clientB).toHaveBeenCalledOnce();

    const direct = await provider.execute('default', { timeout: 1 });
    expect(direct.content).toBe('Default transport');
    expect(defaultClient).toHaveBeenCalledOnce();
  });

  it('embeds accepted background tasks in the final manifest', async () => {
    const outputDir = join(tmpdir(), `librarium-task-${crypto.randomUUID()}`);
    dirs.push(outputDir);
    const task: AsyncTaskHandle = {
      provider: 'embedded',
      taskId: 'task-123',
      query: 'background acceptance',
      submittedAt: 1_780_000_000_000,
      status: 'pending',
      outputDir,
    };
    const report: ProviderReport = {
      id: 'embedded',
      tier: 'raw-search',
      status: 'async-pending',
      durationMs: 0,
      wordCount: 0,
      citationCount: 0,
      outputFile: '',
      metaFile: '',
    };

    const result = await executeResearchRun(
      {
        query: task.query,
        config: { ...config, defaults: { ...config.defaults, outputDir } },
        providerIds: [task.provider],
        outputDir,
        slug: 'background-acceptance',
      },
      {
        providerRegistry: {
          getProvider: () => undefined,
          getAllProviders: () => [],
        },
        dispatch: async () => ({
          reports: [report],
          results: [
            {
              provider: task.provider,
              tier: report.tier,
              status: 'async-pending',
              text: '',
              sourceUrls: [],
              citations: [],
              durationMs: 0,
            },
          ],
          asyncTasks: [task],
        }),
      },
    );

    expect(result.asyncTasks).toEqual([task]);
    expect(result.manifest).toMatchObject({
      status: 'awaiting_async',
      exitCode: null,
      providers: [
        {
          id: task.provider,
          status: 'async-pending',
          task: {
            taskId: task.taskId,
            status: 'pending',
            submittedAt: task.submittedAt,
          },
        },
      ],
    });
  });

  it('terminalizes the manifest when orchestration fails', async () => {
    const outputDir = join(tmpdir(), `librarium-failed-${crypto.randomUUID()}`);
    dirs.push(outputDir);
    const failedEvents: ResearchRunEvent[] = [];

    await expect(
      executeResearchRun(
        {
          query: 'failure lifecycle',
          config: { ...config, defaults: { ...config.defaults, outputDir } },
          providerIds: ['embedded'],
          outputDir,
          slug: 'failure-lifecycle',
          onEvent: (event) => failedEvents.push(event),
        },
        {
          providerRegistry: {
            getProvider: () => undefined,
            getAllProviders: () => [],
          },
          dispatch: async () => {
            throw new Error('dispatch exploded');
          },
        },
      ),
    ).rejects.toThrow('dispatch exploded');

    expect(readRunManifest(outputDir)).toMatchObject({
      status: 'failed',
      exitCode: 2,
      error: 'dispatch exploded',
    });
    expect(failedEvents.at(-1)?.type).toBe('failed');
  });
});
