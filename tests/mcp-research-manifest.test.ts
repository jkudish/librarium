import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerProvider } from '../src/adapters/index.js';
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
    const sentinel = 'sentinel-mcp-credential';
    const baseDir = join(
      tmpdir(),
      `librarium-write-ahead-${crypto.randomUUID()}`,
    );
    dirs.push(baseDir);
    mkdirSync(baseDir, { recursive: true });
    const provider: Provider = {
      id: 'exa',
      displayName: 'Write ahead provider',
      tier: 'raw-search',
      execution: 'inline',
      envVar: '',
      requiresApiKey: false,
      execute: vi.fn(async () => {
        const runDir = readdirSync(baseDir).map((entry) =>
          join(baseDir, entry),
        )[0];
        expect(runDir).toBeDefined();
        const persisted = JSON.parse(
          readFileSync(join(runDir as string, 'run.json'), 'utf8'),
        );
        expect(persisted).toMatchObject({
          schemaVersion: 3,
          coordination_state: { status: 'running' },
        });
        expect(
          Date.parse(persisted.coordination_state.request_deadline_at) -
            Date.parse(persisted.coordination_state.created_at),
        ).toBe(45_000);
        throw new Error(
          `dispatch exploded at https://provider.example/run?api_key=${sentinel}`,
        );
      }),
    };
    registerProvider(provider);
    const config: Config = {
      version: 1,
      defaults: {
        outputDir: baseDir,
        maxParallel: 1,
        timeout: 30,
        asyncTimeout: 30,
        asyncPollInterval: 10,
        requestDeadlineMs: 45_000,
        mode: 'mixed',
        llmWebSearch: true,
      },
      providers: { [provider.id]: { enabled: true } },
      customProviders: {},
      trustedProviderIds: [],
      groups: {},
    };
    const warnings: string[] = [];

    const result = await runResearchSilent(
      { query: 'write ahead', providers: [provider.id], mode: 'sync' },
      {
        loadMergedConfig: () => config,
        initialize: async () => ({
          warnings: [],
          loadedCustomProviders: [],
          skippedCustomProviders: [],
        }),
        registeredAdapterIds: () => ['exa'],
        resolveExactProvider: () => provider,
        credentials: { env: { EXA_API_KEY: 'test-key' } },
        onWarn: (message) => warnings.push(message),
      },
    );

    expect(warnings).toEqual([]);

    const runDir = readdirSync(baseDir).map((entry) => join(baseDir, entry))[0];
    expect(result.response).toMatchObject({
      status: 'failed',
      errors: [{ code: 'librarium.adapter_execute_failed' }],
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    const persisted = readFileSync(join(runDir as string, 'run.json'), 'utf8');
    expect(persisted).not.toContain(sentinel);
    expect(JSON.parse(persisted)).toMatchObject({
      schemaVersion: 3,
      coordination_state: { status: 'unsuccessful' },
      terminal_response: { status: 'failed' },
    });
    expect(
      JSON.parse(
        readFileSync(
          join(runDir as string, 'paid-attempt-ledger.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      artifact: 'librarium.paid-attempt-ledger',
      artifact_version: '1.0.0',
      request_id: result.manifest.request.request_id,
      canonical_run_ref: 'run.json',
      stages: [
        { stage: 'refinement', status: 'not_requested' },
        { stage: 'research', status: 'requested' },
        { stage: 'synthesis', status: 'not_requested' },
        { stage: 'verification', status: 'not_requested' },
      ],
      attempts: [{ stage: 'research', provider: 'exa', status: 'failed' }],
    });
    expect(existsSync(join(runDir as string, 'coordination.json'))).toBe(false);
  });

  it('does not launch an unadmitted fallback after an MCP primary failure', async () => {
    const baseDir = join(
      tmpdir(),
      `librarium-mcp-fallback-${crypto.randomUUID()}`,
    );
    dirs.push(baseDir);
    mkdirSync(baseDir, { recursive: true });
    const primary: Provider = {
      id: 'exa',
      displayName: 'Failing primary',
      tier: 'raw-search',
      execution: 'inline',
      envVar: '',
      requiresApiKey: false,
      execute: async () => {
        throw new Error('primary failed');
      },
    };
    const fallback: Provider = {
      id: 'brave-answers',
      displayName: 'Forbidden fallback',
      tier: 'ai-grounded',
      execution: 'inline',
      envVar: '',
      requiresApiKey: false,
      execute: vi.fn(async () => ({
        provider: 'brave-answers',
        tier: 'ai-grounded',
        content: 'must not run',
        citations: [],
        durationMs: 0,
      })),
    };
    registerProvider(primary);
    registerProvider(fallback);
    const config: Config = {
      version: 1,
      defaults: {
        outputDir: baseDir,
        maxParallel: 1,
        timeout: 30,
        asyncTimeout: 1800,
        asyncPollInterval: 10,
        mode: 'sync',
        llmWebSearch: true,
      },
      providers: {
        exa: { enabled: true, fallback: 'brave-answers' },
        'brave-answers': { enabled: false },
      },
      customProviders: {},
      trustedProviderIds: [],
      groups: {},
    };

    const result = await runResearchSilent(
      { query: 'forced primary failure', providers: ['exa'], mode: 'sync' },
      {
        loadMergedConfig: () => config,
        initialize: async () => ({
          warnings: [],
          loadedCustomProviders: [],
          skippedCustomProviders: [],
        }),
        registeredAdapterIds: () => ['exa'],
        credentials: { env: { EXA_API_KEY: 'test-key' } },
        onWarn: () => {},
      },
    );

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({ id: 'exa', status: 'error' });
    expect(fallback.execute).not.toHaveBeenCalled();
  });
});
