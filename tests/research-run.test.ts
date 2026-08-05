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
import type { Config, ProviderOptions, ProviderResult } from '../src/types.js';

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

    const result = await executeResearchRun(
      {
        query: 'observer isolation',
        config: { ...config, defaults: { ...config.defaults, outputDir } },
        providerIds: [provider.id],
        outputDir,
        slug: 'observer-isolation',
        onEvent: () => {
          throw new Error('observer exploded');
        },
        postDispatch: async () => {
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
