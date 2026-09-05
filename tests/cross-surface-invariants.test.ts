import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRegisteredProviderAttemptBridge,
  runCanonicalPreparedExecution,
} from '../src/node-canonical-run.js';
import { preflightProductionRequest } from '../src/node-request-preflight.js';
import type { Config, Provider } from '../src/types.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('cross-surface release invariants', () => {
  it('keeps an exact CLI matrix fallback-free through canonical execution', async () => {
    const root = join(
      tmpdir(),
      `librarium-exact-matrix-${crypto.randomUUID()}`,
    );
    const runDirectory = join(root, 'run');
    mkdirSync(runDirectory, { recursive: true });
    roots.push(root);

    const config: Config = {
      version: 1,
      defaults: {
        outputDir: root,
        maxParallel: 1,
        timeout: 30,
        asyncTimeout: 300,
        asyncPollInterval: 5,
        mode: 'sync',
        llmWebSearch: true,
      },
      providers: {
        exa: { enabled: true, fallback: 'brave-search' },
        'brave-search': { enabled: false },
      },
      customProviders: {},
      trustedProviderIds: [],
      groups: {},
    };
    const preflight = preflightProductionRequest(
      {
        config,
        transport: {
          kind: 'cli',
          input: {
            query: 'exact matrix must not fall back',
            providers: ['exa'],
            mode: 'sync',
            fallback: false,
          },
        },
      },
      {
        createCredentials: () => ({ env: { EXA_API_KEY: 'test-key' } }),
      },
    );
    expect(preflight.prepared.policy.fallback).toEqual({ kind: 'disabled' });
    expect(preflight.prepared.request.fallback_reserve).toEqual([]);
    expect(preflight.admittedAdapterIds).toEqual(['exa']);

    const primary: Provider = {
      id: 'exa',
      displayName: 'Network-denied primary',
      tier: 'raw-search',
      envVar: '',
      execution: 'inline',
      execute: vi.fn(async () => {
        throw new Error('network denied');
      }),
    };
    const fallbackExecute = vi.fn<Provider['execute']>();
    const fallback: Provider = {
      id: 'brave-search',
      displayName: 'Forbidden fallback',
      tier: 'raw-search',
      envVar: '',
      execution: 'inline',
      execute: fallbackExecute,
    };
    const providers: Readonly<Record<string, Provider>> = {
      exa: primary,
      'brave-search': fallback,
    };
    let nextId = 0;
    const result = await runCanonicalPreparedExecution(preflight.prepared, {
      runs_root: root,
      run_directory: runDirectory,
      coordinator: {
        clock: { now: () => Date.parse('2026-09-05T12:00:00.000Z') },
        ids: {
          next: (scope) => `${scope}-${++nextId}`,
        },
      },
      attempt_bridge: createRegisteredProviderAttemptBridge(
        preflight.prepared,
        (id) => providers[id],
      ),
    });

    expect(primary.execute).toHaveBeenCalledTimes(1);
    expect(fallbackExecute).not.toHaveBeenCalled();
    expect(result.response).toMatchObject({ status: 'failed' });
    expect(result.manifest.coordination_state.attempts).toHaveLength(1);
  });
});
