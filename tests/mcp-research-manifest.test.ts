import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerProvider } from '../src/adapters/index.js';
import { readRunManifest } from '../src/core/run-manifest.js';
import { runResearchSilent } from '../src/mcp/research.js';
import type { Config, Provider } from '../src/types.js';

describe('silent research live manifest', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes run.json before dispatch and terminalizes orchestration failures', async () => {
    const baseDir = join(
      tmpdir(),
      `librarium-write-ahead-${crypto.randomUUID()}`,
    );
    dirs.push(baseDir);
    mkdirSync(baseDir, { recursive: true });
    const provider: Provider = {
      id: 'write-ahead-provider',
      displayName: 'Write ahead provider',
      tier: 'raw-search',
      execution: 'inline',
      envVar: '',
      requiresApiKey: false,
      execute: vi.fn(),
    };
    registerProvider(provider);
    const config: Config = {
      version: 1,
      defaults: {
        outputDir: baseDir,
        maxParallel: 1,
        timeout: 30,
        asyncTimeout: 1800,
        asyncPollInterval: 10,
        mode: 'mixed',
        llmWebSearch: true,
      },
      providers: { [provider.id]: { enabled: true } },
      customProviders: {},
      trustedProviderIds: [],
      groups: {},
    };
    const dispatch = vi.fn(async () => {
      const runDir = readdirSync(baseDir).map((entry) =>
        join(baseDir, entry),
      )[0];
      expect(runDir).toBeDefined();
      expect(existsSync(join(runDir as string, 'run.json'))).toBe(true);
      expect(readRunManifest(runDir as string)).toMatchObject({
        status: 'running',
        exitCode: null,
      });
      throw new Error('dispatch exploded');
    });

    await expect(
      runResearchSilent(
        { query: 'write ahead', providers: [provider.id] },
        {
          loadMergedConfig: () => config,
          initialize: async () => ({
            warnings: [],
            loadedCustomProviders: [],
            skippedCustomProviders: [],
          }),
          dispatch,
          credentials: { env: {} },
        },
      ),
    ).rejects.toThrow('dispatch exploded');

    const runDir = readdirSync(baseDir).map((entry) => join(baseDir, entry))[0];
    expect(readRunManifest(runDir as string)).toMatchObject({
      status: 'failed',
      exitCode: 2,
      error: 'dispatch exploded',
    });
  });
});
