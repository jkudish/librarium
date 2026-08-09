import { describe, expect, it, vi } from 'vitest';
import type {
  ExecutionProfile,
  ProviderIdentity,
} from '../src/contracts/domain/index.js';
import {
  type FrozenPlanningCatalog,
  type PlanningProfile,
  prepareResearchExecution,
} from '../src/core/execution-plan.js';
import {
  CanonicalResearchRequestSchema,
  migrateLegacyResearchRequest,
} from '../src/core/research-request.js';

function groundedProfile(
  providerId: string,
  resumability: 'none' | 'process_local' | 'durable' = 'none',
): ExecutionProfile {
  return {
    identity: {
      provider_id: providerId,
      profile_id: 'grounded-web',
    },
    result_kind: 'grounded_answer',
    grounding_policy: 'required',
    observation_mode: 'api_output',
    corpora: ['web'],
    retrieval_method: 'model_search_tool',
    access_mode: 'direct',
    operator_id: providerId,
    invocation: resumability === 'none' ? 'inline' : 'background',
    resumability,
  };
}

function surfaceProfile(
  providerId: string,
  observationMode: 'api_output' | 'surface_snapshot',
): ExecutionProfile {
  const snapshot = observationMode === 'surface_snapshot';
  return {
    identity: {
      provider_id: providerId,
      profile_id: 'google-ai-mode',
    },
    result_kind: 'surface_observation',
    grounding_policy: 'optional',
    observation_mode: observationMode,
    corpora: ['web'],
    retrieval_method: snapshot ? 'surface_collector' : 'model_only',
    access_mode: snapshot ? 'collected' : 'direct',
    operator_id: 'google',
    collector_id: snapshot ? providerId : undefined,
    surface_id: 'google_ai_mode',
    invocation: 'inline',
    resumability: 'none',
  };
}

function planningProfile(
  profile: ExecutionProfile,
  overrides: Partial<PlanningProfile> = {},
): PlanningProfile {
  return {
    profile,
    binding: {
      adapter_id: `adapter-${profile.identity.provider_id}`,
      binding_id: `binding-${profile.identity.profile_id}`,
    },
    estimate: { estimated_cost_microusd: '10' },
    enabled: true,
    credentialed: true,
    configuration_valid: true,
    ...overrides,
  };
}

class FixtureCatalog implements FrozenPlanningCatalog {
  readonly profiles: readonly PlanningProfile[];
  readonly groupCalls = vi.fn();
  readonly defaultCalls = vi.fn();
  readonly reserveCalls = vi.fn();

  constructor(
    profiles: readonly PlanningProfile[],
    readonly groups: Readonly<Record<string, readonly ProviderIdentity[]>> = {},
    readonly defaults: readonly ProviderIdentity[] = [],
    readonly configuredReserve: readonly ProviderIdentity[] = [],
    readonly revision = 'fixture-r1',
    readonly digest = 'fixture-digest',
  ) {
    this.profiles = Object.freeze([...profiles]);
  }

  resolveGroup(groupId: string): readonly ProviderIdentity[] | undefined {
    this.groupCalls(groupId);
    return this.groups[groupId];
  }

  resolveDefault(): readonly ProviderIdentity[] {
    this.defaultCalls();
    return this.defaults;
  }

  resolveConfiguredReserve(
    primaries: readonly ProviderIdentity[],
  ): readonly ProviderIdentity[] {
    this.reserveCalls(primaries);
    return this.configuredReserve;
  }
}

function dependencies() {
  const counts = new Map<string, number>();
  return {
    clock: { now: () => Date.parse('2026-08-08T12:00:00Z') },
    ids: {
      next: (scope: 'request' | 'slot' | 'fallback_candidate') => {
        const count = (counts.get(scope) ?? 0) + 1;
        counts.set(scope, count);
        return `${scope}-${count}`;
      },
    },
  };
}

function targetRequest(providerId = 'alpha') {
  return {
    query: '  canonical query  ',
    mode: 'sync',
    selector: {
      kind: 'targets',
      targets: [{ provider_id: providerId, profile_id: 'grounded-web' }],
    },
    fallback: { kind: 'disabled' },
    limits: {
      max_concurrency: 2,
      request_deadline_ms: 60_000,
      inline_attempt_deadline_ms: 30_000,
      background_attempt_deadline_ms: 60_000,
      poll_interval_ms: 1_000,
    },
  } as const;
}

describe('canonical research request', () => {
  it('enforces one strict selector, bounded result counts, and strict limits', () => {
    const parsed = CanonicalResearchRequestSchema.parse(targetRequest());
    expect(parsed.query).toBe('canonical query');
    expect(parsed.refinement).toEqual({ kind: 'disabled' });

    expect(
      CanonicalResearchRequestSchema.safeParse({
        ...targetRequest(),
        selector: {
          kind: 'targets',
          targets: [{ provider_id: 'alpha' }],
          group_id: 'quick',
        },
      }).success,
    ).toBe(false);
    expect(
      CanonicalResearchRequestSchema.safeParse({
        ...targetRequest(),
        selector: {
          kind: 'capabilities',
          requirements: {
            result_kind: 'grounded_answer',
            grounding_policy: 'required',
            corpora: ['web'],
          },
          result_count: 0,
        },
      }).success,
    ).toBe(false);
    expect(
      CanonicalResearchRequestSchema.safeParse({
        ...targetRequest(),
        limits: { ...targetRequest().limits, max_concurrency: 65 },
      }).success,
    ).toBe(false);
    expect(
      CanonicalResearchRequestSchema.safeParse({
        ...targetRequest(),
        limits: {
          ...targetRequest().limits,
          inline_attempt_deadline_ms: 61_000,
        },
      }).success,
    ).toBe(false);
  });

  it('accepts an intentional zero micro-USD ceiling and rejects inexact values', () => {
    expect(
      CanonicalResearchRequestSchema.safeParse({
        ...targetRequest(),
        budgets: { max_estimated_cost_microusd: '0' },
      }).success,
    ).toBe(true);
    expect(
      CanonicalResearchRequestSchema.safeParse({
        ...targetRequest(),
        budgets: { max_estimated_cost_microusd: '0.1' },
      }).success,
    ).toBe(false);
  });

  it('keeps mixed outside canonical schemas and migrates it with a stable notice', () => {
    const legacy = { ...targetRequest(), mode: 'mixed' };
    expect(CanonicalResearchRequestSchema.safeParse(legacy).success).toBe(
      false,
    );
    expect(migrateLegacyResearchRequest(legacy)).toEqual({
      input: { ...legacy, mode: 'async' },
      notices: [
        {
          code: 'legacy_mixed_mode_migrated',
          phase: 'migration',
          path: '/mode',
          message:
            'Legacy mixed mode is deprecated and was migrated to async mode.',
        },
      ],
    });
  });
});

describe('research execution preparation', () => {
  it('aggregates canonical issues and suppresses selection cascades', () => {
    const catalog = new FixtureCatalog([]);
    const result = prepareResearchExecution(
      {
        ...targetRequest(),
        query: '   ',
        selector: { kind: 'group', group_id: 'quick' },
        limits: {
          ...targetRequest().limits,
          max_concurrency: 0,
          poll_interval_ms: 999_999,
        },
      },
      catalog,
      dependencies(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.issues.map(({ code, path, phase }) => [code, path, phase]),
    ).toEqual([
      [
        'concurrency_out_of_bounds',
        '/limits/max_concurrency',
        'canonicalization',
      ],
      [
        'poll_interval_exceeds_background_attempt_deadline',
        '/limits/poll_interval_ms',
        'canonicalization',
      ],
      [
        'poll_interval_out_of_bounds',
        '/limits/poll_interval_ms',
        'canonicalization',
      ],
      ['invalid_query', '/query', 'canonicalization'],
    ]);
    expect(catalog.groupCalls).not.toHaveBeenCalled();
  });

  it('rejects duplicate explicit targets, reserve targets, and exclusions at the second path', () => {
    const duplicate = { provider_id: 'alpha', profile_id: 'grounded-web' };
    const result = prepareResearchExecution(
      {
        ...targetRequest(),
        selector: { kind: 'targets', targets: [duplicate, duplicate] },
        fallback: { kind: 'explicit', reserve: [duplicate, duplicate] },
        exclusions: [duplicate, duplicate],
      },
      new FixtureCatalog([planningProfile(groundedProfile('alpha'))]),
      dependencies(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(({ code, path }) => [code, path])).toEqual([
      ['duplicate_exclusion', '/exclusions/1'],
      ['duplicate_explicit_reserve_target', '/fallback/reserve/1'],
      ['duplicate_explicit_target', '/selector/targets/1'],
    ]);
  });

  it('accepts custom group syntax structurally and reports unknown groups during selection', () => {
    for (const groupId of ['custom:visibility', 'quick']) {
      const input = {
        ...targetRequest(),
        selector: { kind: 'group', group_id: groupId },
      };
      expect(CanonicalResearchRequestSchema.safeParse(input).success).toBe(
        true,
      );
      const result = prepareResearchExecution(
        input,
        new FixtureCatalog([]),
        dependencies(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: 'group_not_found',
          path: '/selector/group_id',
        }),
      );
    }
  });

  it('reports unknown explicit providers as compiler selection errors', () => {
    const input = targetRequest('unknown-builtin');
    expect(CanonicalResearchRequestSchema.safeParse(input).success).toBe(true);
    const result = prepareResearchExecution(
      input,
      new FixtureCatalog([]),
      dependencies(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'profile_not_found',
        phase: 'selection',
        path: '/selector/targets/0',
      }),
    );
  });

  it('rejects structurally invalid catalog profiles even when they are unused', () => {
    const valid = planningProfile(groundedProfile('alpha'));
    const invalid = planningProfile({
      ...groundedProfile('unused'),
      result_kind: 'not-a-result-kind',
    } as unknown as ExecutionProfile);
    const result = prepareResearchExecution(
      targetRequest(),
      new FixtureCatalog([valid, invalid]),
      dependencies(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'invalid_catalog_execution_profile',
        phase: 'validation',
        path: '/catalog/profiles/1/profile/result_kind',
      }),
    );
  });

  it('hardens catalog metadata with stable index-addressed diagnostics', () => {
    const result = prepareResearchExecution(
      targetRequest(),
      new FixtureCatalog([
        planningProfile(groundedProfile('alpha'), {
          binding: { adapter_id: ' padded ', binding_id: 'x'.repeat(256) },
          estimate: {
            estimated_cost_microusd: '1'.repeat(65),
            billable_units: [{ unit: 'Not Snake', quantity: '01.2' }],
          },
        }),
        planningProfile(groundedProfile('beta'), {
          binding: { adapter_id: 'adapter\u0007beta', binding_id: 'ok' },
        }),
      ]),
      dependencies(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(({ code, path }) => [code, path])).toEqual([
      [
        'invalid_adapter_binding_identity',
        '/catalog/profiles/0/binding/adapter_id',
      ],
      [
        'invalid_adapter_binding_identity',
        '/catalog/profiles/0/binding/binding_id',
      ],
      [
        'invalid_billable_unit_estimate',
        '/catalog/profiles/0/estimate/billable_units/0/quantity',
      ],
      [
        'invalid_billable_unit_estimate',
        '/catalog/profiles/0/estimate/billable_units/0/unit',
      ],
      [
        'invalid_network_free_estimate',
        '/catalog/profiles/0/estimate/estimated_cost_microusd',
      ],
      [
        'invalid_adapter_binding_identity',
        '/catalog/profiles/1/binding/adapter_id',
      ],
    ]);
  });

  it('rejects unbounded catalog identity metadata without reflecting it', () => {
    const result = prepareResearchExecution(
      targetRequest(),
      new FixtureCatalog(
        [planningProfile(groundedProfile('alpha'))],
        {},
        [],
        [],
        ' padded ',
        'x'.repeat(256),
      ),
      dependencies(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(({ code, path }) => [code, path])).toEqual([
      ['invalid_catalog_digest', '/catalog/digest'],
      ['invalid_catalog_revision', '/catalog/revision'],
    ]);
    expect(JSON.stringify(result.issues)).not.toContain('x'.repeat(256));
  });

  it('rejects over-budget or unestimated primary plans before execution', () => {
    const alpha = planningProfile(groundedProfile('alpha'), {
      estimate: { estimated_cost_microusd: '10' },
    });
    const beta = planningProfile(groundedProfile('beta'), {
      estimate: { estimated_cost_microusd: '10' },
    });
    const selector = {
      kind: 'targets' as const,
      targets: [alpha.profile.identity, beta.profile.identity],
    };
    const exceeded = prepareResearchExecution(
      {
        ...targetRequest(),
        selector,
        budgets: { max_actual_cost_microusd: '15' },
      },
      new FixtureCatalog([alpha, beta]),
      dependencies(),
    );
    expect(exceeded.ok).toBe(false);
    if (exceeded.ok) return;
    expect(exceeded.issues).toContainEqual(
      expect.objectContaining({
        code: 'primary_plan_budget_exceeded',
        path: '/budgets/max_actual_cost_microusd',
      }),
    );

    const unestimated = prepareResearchExecution(
      { ...targetRequest(), budgets: { max_estimated_cost_microusd: '10' } },
      new FixtureCatalog([
        planningProfile(groundedProfile('alpha'), { estimate: undefined }),
      ]),
      dependencies(),
    );
    expect(unestimated.ok).toBe(false);
    if (unestimated.ok) return;
    expect(unestimated.issues).toContainEqual(
      expect.objectContaining({ code: 'budget_estimate_required' }),
    );
  });

  it('bounds billable unit arrays and addresses duplicate catalog profiles by index', () => {
    const alpha = planningProfile(groundedProfile('alpha'));
    const duplicated = prepareResearchExecution(
      targetRequest(),
      new FixtureCatalog([alpha, alpha]),
      dependencies(),
    );
    expect(duplicated.ok).toBe(false);
    if (duplicated.ok) return;
    expect(duplicated.issues).toContainEqual(
      expect.objectContaining({
        code: 'catalog_profile_duplicate',
        path: '/catalog/profiles/1/profile/identity',
      }),
    );

    const oversized = prepareResearchExecution(
      targetRequest(),
      new FixtureCatalog([
        planningProfile(groundedProfile('alpha'), {
          estimate: {
            estimated_cost_microusd: '10',
            billable_units: Array.from({ length: 33 }, () => ({
              unit: 'search_queries',
              quantity: '1',
            })),
          },
        }),
      ]),
      dependencies(),
    );
    expect(oversized.ok).toBe(false);
    if (oversized.ok) return;
    expect(oversized.issues).toEqual([
      expect.objectContaining({
        code: 'invalid_billable_unit_estimate',
        path: '/catalog/profiles/0/estimate/billable_units',
      }),
    ]);

    const bounded = prepareResearchExecution(
      targetRequest(),
      new FixtureCatalog([
        planningProfile(groundedProfile('alpha'), {
          estimate: {
            estimated_cost_microusd: '9'.repeat(64),
            billable_units: [{ unit: 'search_queries', quantity: '2.5' }],
          },
        }),
      ]),
      dependencies(),
    );
    expect(bounded.ok).toBe(true);
  });

  it('compiles equivalent target and group inputs to identical plans with injected clock and ids', () => {
    const alpha = planningProfile(groundedProfile('alpha'));
    const catalog = new FixtureCatalog(
      [alpha],
      { quick: [alpha.profile.identity] },
      [alpha.profile.identity],
    );
    const target = prepareResearchExecution(
      targetRequest(),
      catalog,
      dependencies(),
    );
    const group = prepareResearchExecution(
      {
        ...targetRequest(),
        selector: { kind: 'group', group_id: 'quick' },
        refinement: { kind: 'disabled' },
      },
      catalog,
      dependencies(),
    );

    expect(target.ok).toBe(true);
    expect(group.ok).toBe(true);
    if (!target.ok || !group.ok) return;
    expect(group.prepared).toEqual(target.prepared);
    expect(target.prepared.request.query).toBe('canonical query');
  });

  it('selects a bounded exact capability result count in frozen catalog order', () => {
    const profiles = [
      planningProfile(groundedProfile('alpha')),
      planningProfile(groundedProfile('beta')),
    ];
    const request = {
      ...targetRequest(),
      selector: {
        kind: 'capabilities',
        requirements: {
          result_kind: 'grounded_answer',
          grounding_policy: 'required',
          corpora: ['web'],
        },
        result_count: 1,
      },
    } as const;
    const selected = prepareResearchExecution(
      request,
      new FixtureCatalog(profiles),
      dependencies(),
    );
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.prepared.request.slots).toHaveLength(1);
    expect(
      selected.prepared.request.slots[0]?.primary.identity.provider_id,
    ).toBe('alpha');

    const unavailable = prepareResearchExecution(
      {
        ...request,
        selector: { ...request.selector, result_count: 3 },
      },
      new FixtureCatalog(profiles),
      dependencies(),
    );
    expect(unavailable.ok).toBe(false);
    if (unavailable.ok) return;
    expect(unavailable.issues).toContainEqual(
      expect.objectContaining({
        code: 'capability_result_count_unavailable',
        path: '/selector/result_count',
      }),
    );
  });

  it('rejects every explicit non-durable async profile during preparation', () => {
    const catalog = new FixtureCatalog([
      planningProfile(groundedProfile('alpha')),
      planningProfile(groundedProfile('beta', 'process_local')),
    ]);
    const result = prepareResearchExecution(
      {
        ...targetRequest(),
        mode: 'async',
        selector: {
          kind: 'targets',
          targets: [
            { provider_id: 'alpha', profile_id: 'grounded-web' },
            { provider_id: 'beta', profile_id: 'grounded-web' },
          ],
        },
      },
      catalog,
      dependencies(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'async_requires_durable_profile',
        path: '/selector/targets/0',
      }),
      expect.objectContaining({
        code: 'async_requires_durable_profile',
        path: '/selector/targets/1',
      }),
    ]);
  });

  it('enforces profile uniqueness across primaries and the global reserve', () => {
    const alpha = planningProfile(groundedProfile('alpha'));
    const result = prepareResearchExecution(
      {
        ...targetRequest(),
        fallback: {
          kind: 'explicit',
          reserve: [{ provider_id: 'alpha', profile_id: 'grounded-web' }],
        },
      },
      new FixtureCatalog([alpha]),
      dependencies(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'profile_reused_in_fallback',
        path: '/fallback/reserve/0',
      }),
    );
  });

  it('rejects fallback lane/surface mismatches and compiles compatible eligibility', () => {
    const primary = planningProfile(
      surfaceProfile('collector-a', 'surface_snapshot'),
    );
    const incompatible = planningProfile(
      surfaceProfile('api-proxy', 'api_output'),
    );
    const compatible = planningProfile(
      surfaceProfile('collector-b', 'surface_snapshot'),
    );
    const input = {
      ...targetRequest(),
      selector: {
        kind: 'targets',
        targets: [{ provider_id: 'collector-a', profile_id: 'google-ai-mode' }],
      },
    } as const;

    const rejected = prepareResearchExecution(
      {
        ...input,
        fallback: {
          kind: 'explicit',
          reserve: [{ provider_id: 'api-proxy', profile_id: 'google-ai-mode' }],
        },
      },
      new FixtureCatalog([primary, incompatible]),
      dependencies(),
    );
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.issues).toContainEqual(
      expect.objectContaining({
        code: 'fallback_profile_incompatible',
        path: '/fallback/reserve/0',
      }),
    );

    const accepted = prepareResearchExecution(
      {
        ...input,
        fallback: {
          kind: 'explicit',
          reserve: [
            { provider_id: 'collector-b', profile_id: 'google-ai-mode' },
          ],
        },
      },
      new FixtureCatalog([primary, compatible]),
      dependencies(),
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(
      accepted.prepared.request.fallback_reserve[0]?.eligible_slot_ids,
    ).toEqual([accepted.prepared.request.slots[0]?.slot_id]);
  });
});
