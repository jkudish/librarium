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

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.request.slots).toHaveLength(1);
    expect(result.prepared.request.slots[0]?.primary.identity).toMatchObject({
      provider_id: 'exa',
      profile_id: 'search',
    });
    expect(result.prepared.policy.limits).toEqual({
      max_concurrency: 2,
      request_deadline_ms: 120_000,
      inline_attempt_deadline_ms: 30_000,
      background_attempt_deadline_ms: 120_000,
      poll_interval_ms: 5_000,
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

  it('injects the reachable maximum selected background attempt allowance', () => {
    const background: Config = {
      ...config,
      providers: {
        'openai-research': { enabled: true },
        'gemini-deep': { enabled: true },
      },
    };
    const ids = new Map<string, number>();
    const result = compileShadowRequest({
      config: background,
      authoredGroups: { global: {}, project: {} },
      credentials: {
        env: {
          OPENAI_API_KEY: 'worker-test-key',
          GEMINI_API_KEY: 'worker-test-key',
        },
      },
      transport: {
        kind: 'silent_mcp',
        input: {
          query: 'effective background attempt',
          providers: ['openai-research', 'gemini-deep'],
        },
      },
      preparation: {
        clock: { now: () => Date.parse('2026-08-09T12:00:00Z') },
        ids: {
          next: (scope) => {
            const next = (ids.get(scope) ?? 0) + 1;
            ids.set(scope, next);
            return `background-${scope}-${next}`;
          },
        },
      },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.policy.limits).toMatchObject({
      request_deadline_ms: 525_000,
      background_attempt_deadline_ms: 525_000,
    });
  });

  it('keeps an explicit total authoritative and propagates truncation notice', () => {
    const ids = new Map<string, number>();
    const result = compileShadowRequest({
      config: {
        ...config,
        defaults: { ...config.defaults, maxParallel: 1 },
        providers: {
          'openai-research': { enabled: true },
          'gemini-deep': { enabled: true },
        },
      },
      authoredGroups: { global: {}, project: {} },
      credentials: {
        env: {
          OPENAI_API_KEY: 'worker-test-key',
          GEMINI_API_KEY: 'worker-test-key',
        },
      },
      requestDeadlineMs: 600_000,
      transport: {
        kind: 'silent_mcp',
        input: {
          query: 'explicit truncation warning',
          providers: ['openai-research', 'gemini-deep'],
        },
      },
      preparation: {
        clock: { now: () => Date.parse('2026-08-09T12:00:00Z') },
        ids: {
          next: (scope) => {
            const next = (ids.get(scope) ?? 0) + 1;
            ids.set(scope, next);
            return `explicit-${scope}-${next}`;
          },
        },
      },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.policy.limits).toMatchObject({
      request_deadline_ms: 600_000,
      background_attempt_deadline_ms: 525_000,
    });
    expect(result.notices).toContainEqual(
      expect.objectContaining({
        code: 'explicit_request_deadline_may_truncate_plan',
        path: '/deadline_migration/explicit_request_deadline_ms',
      }),
    );
  });

  it.each([
    {
      name: 'explicit total below the effective attempt cap',
      config: {
        ...config,
        providers: { 'openai-research': { enabled: true } },
      } satisfies Config,
      credentials: { env: { OPENAI_API_KEY: 'worker-test-key' } },
      providers: ['openai-research'],
      requestDeadlineMs: 199_999,
      code: 'request_deadline_less_than_attempt_deadline',
    },
    {
      name: 'derived total above seven days',
      config: {
        ...config,
        defaults: {
          ...config.defaults,
          maxParallel: 1,
          timeout: 400_000,
        },
        providers: {
          exa: { enabled: true },
          'brave-search': { enabled: true },
        },
      } satisfies Config,
      credentials: {
        env: {
          EXA_API_KEY: 'worker-test-key',
          BRAVE_API_KEY: 'worker-test-key',
        },
      },
      providers: ['exa', 'brave-search'],
      requestDeadlineMs: undefined,
      code: 'request_deadline_contract_maximum_exceeded',
    },
    {
      name: 'unknown selected provider',
      config,
      credentials: { env: {} },
      providers: ['not-a-provider'],
      requestDeadlineMs: undefined,
      code: 'shadow_provider_token_unknown',
    },
    {
      name: 'async mode with an inline profile',
      config: {
        ...config,
        defaults: { ...config.defaults, mode: 'async' },
      } satisfies Config,
      credentials: { env: { EXA_API_KEY: 'worker-test-key' } },
      providers: ['exa'],
      requestDeadlineMs: undefined,
      code: 'async_requires_durable_profile',
    },
    {
      name: 'hard budget without a network-free estimate',
      config: {
        ...config,
        defaults: { ...config.defaults, maxEstimatedCostUsd: 1 },
      } satisfies Config,
      credentials: { env: { EXA_API_KEY: 'worker-test-key' } },
      providers: ['exa'],
      requestDeadlineMs: undefined,
      code: 'budget_estimate_required',
    },
  ])('keeps clock and IDs untouched when $name is rejected', (fixture) => {
    const counts = { clock: 0, ids: 0 };
    const result = compileShadowRequest({
      config: fixture.config,
      authoredGroups: { global: {}, project: {} },
      credentials: fixture.credentials,
      ...(fixture.requestDeadlineMs !== undefined && {
        requestDeadlineMs: fixture.requestDeadlineMs,
      }),
      transport: {
        kind: 'silent_mcp',
        input: { query: fixture.name, providers: fixture.providers },
      },
      preparation: {
        clock: {
          now: () => {
            counts.clock += 1;
            return Date.parse('2026-08-09T12:00:00Z');
          },
        },
        ids: {
          next: (scope) => {
            counts.ids += 1;
            return `rejected-${scope}`;
          },
        },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: fixture.code })],
    });
    expect(counts).toEqual({ clock: 0, ids: 0 });
  });
});
