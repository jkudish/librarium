import { describe, expect, it } from 'vitest';
import { compileShadowRequest } from '../../src/core/shadow-compilation.js';
import type { Config } from '../../src/types.js';

const config: Config = {
  version: 1,
  defaults: {
    outputDir: './agents/librarium',
    maxParallel: 2,
    timeout: 30,
    asyncTimeout: 120,
    asyncPollInterval: 5,
    mode: 'sync',
    llmWebSearch: true,
  },
  providers: { exa: { enabled: true } },
  customProviders: {},
  trustedProviderIds: [],
  groups: {},
};

describe('private shadow compiler in workerd', () => {
  it('imports and prepares a plan without Node runtime dependencies', () => {
    const counts = new Map<string, number>();
    const result = compileShadowRequest({
      config,
      authoredGroups: { global: {}, project: {} },
      credentials: { env: { EXA_API_KEY: 'worker-test-key' } },
      requestDeadlineMs: 300_000,
      transport: {
        kind: 'silent_mcp',
        input: { query: 'worker-safe shadow plan', providers: ['Exa Search'] },
      },
      preparation: {
        clock: { now: () => Date.parse('2026-08-09T12:00:00Z') },
        ids: {
          next: (scope) => {
            const count = (counts.get(scope) ?? 0) + 1;
            counts.set(scope, count);
            return `worker-${scope}-${count}`;
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.request.slots).toHaveLength(1);
    expect(result.prepared.request.slots[0]?.primary.identity).toMatchObject({
      provider_id: 'exa',
      profile_id: 'search',
    });
  });

  it('plans trusted custom metadata without importing provider code', () => {
    const custom: Config = {
      ...config,
      providers: { 'edge-custom': { enabled: true } },
      customProviders: {
        'edge-custom': {
          type: 'npm',
          module: 'node-only-module-that-must-not-load',
          executionProfile: {
            bindingId: 'edge.search.v1',
            profile: {
              identity: {
                provider_id: 'edge-provider',
                profile_id: 'search',
                target: {
                  primary: { model_selection: 'not_applicable' },
                },
              },
              result_kind: 'search_results',
              observation_mode: 'api_output',
              corpora: ['web'],
              retrieval_method: 'search_endpoint',
              access_mode: 'direct',
              operator_id: 'edge-provider',
              invocation: 'inline',
              resumability: 'none',
            },
          },
        },
      },
      trustedProviderIds: ['edge-custom'],
    };
    const result = compileShadowRequest({
      config: custom,
      authoredGroups: { global: {}, project: {} },
      credentials: {},
      requestDeadlineMs: 300_000,
      transport: {
        kind: 'silent_mcp',
        input: { query: 'worker custom plan', providers: ['edge-custom'] },
      },
      preparation: {
        clock: { now: () => Date.parse('2026-08-09T12:00:00Z') },
        ids: { next: (scope) => `edge-${scope}` },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.request.slots[0]?.primary.identity).toMatchObject({
      provider_id: 'edge-provider',
      profile_id: 'search',
    });
  });
});
