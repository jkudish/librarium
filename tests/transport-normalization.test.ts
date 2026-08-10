import { describe, expect, it } from 'vitest';
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
  type CanonicalTransportDefaults,
  compileNormalizedTransportRequest,
  normalizeCliRequest,
  normalizeConfigurationRequest,
  normalizeLibraryRequest,
  normalizeMcpRequest,
  normalizeSilentMcpRequest,
} from '../src/core/transport-normalization.js';

/**
 * Test-owned fixture context. The transport module deliberately ships no
 * built-in default policy values; canonical defaults remain an open
 * maintainer decision, so these values are arbitrary fixture data only.
 */
const FIXTURE_DEFAULTS: CanonicalTransportDefaults = Object.freeze({
  mode: 'sync',
  limits: Object.freeze({
    max_concurrency: 4,
    request_deadline_ms: 300_000,
    inline_attempt_deadline_ms: 30_000,
    background_attempt_deadline_ms: 180_000,
    poll_interval_ms: 5_000,
  }),
  fallback: Object.freeze({ kind: 'configured' as const }),
  refinement: Object.freeze({ kind: 'disabled' as const }),
});

function groundedProfile(
  providerId: string,
  resumability: 'none' | 'durable' = 'none',
): ExecutionProfile {
  return {
    identity: {
      provider_id: providerId,
      profile_id: 'grounded-web',
      target: {
        primary: {
          model_selection: 'fixed',
          kind: 'model',
          target_id: `${providerId}-fixture-model`,
        },
      },
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

function planningProfile(profile: ExecutionProfile): PlanningProfile {
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
  };
}

function catalogFor(
  profiles: readonly PlanningProfile[],
  groups: Readonly<Record<string, readonly ProviderIdentity[]>> = {},
): FrozenPlanningCatalog {
  return {
    revision: 'transport-r1',
    digest: 'transport-digest',
    profiles,
    resolveGroup: (groupId) => groups[groupId],
    resolveDefault: () => profiles.map((entry) => entry.profile.identity),
    resolveConfiguredReserve: () => [],
  };
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

describe('shadow transport golden equality', () => {
  it('compiles semantically equivalent inputs from all five transports to byte-identical prepared executions', () => {
    const catalog = catalogFor([planningProfile(groundedProfile('alpha'))]);
    const query = '  transport parity query  ';
    const normalized = [
      normalizeLibraryRequest(
        {
          query,
          mode: 'sync',
          targets: [{ provider_id: 'alpha' }],
          limits: {
            max_concurrency: 4,
            inline_attempt_deadline_ms: 30_000,
          },
        },
        FIXTURE_DEFAULTS,
      ),
      normalizeCliRequest(
        {
          query,
          providers: ['alpha'],
          mode: 'sync',
          parallel: 4,
          timeoutSeconds: 30,
        },
        FIXTURE_DEFAULTS,
      ),
      normalizeMcpRequest(
        { query, providers: [' alpha '], mode: 'sync' },
        FIXTURE_DEFAULTS,
      ),
      normalizeSilentMcpRequest(
        { query, providers: ['alpha'] },
        FIXTURE_DEFAULTS,
      ),
      normalizeConfigurationRequest(
        {
          query,
          providers: ['alpha'],
          defaults: { mode: 'sync', maxParallel: 4, timeoutSeconds: 30 },
        },
        FIXTURE_DEFAULTS,
      ),
    ];

    const serialized = normalized.map((result) => {
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('normalization unexpectedly failed');
      expect(result.notices).toEqual([]);
      const compiled = prepareResearchExecution(
        result.request,
        catalog,
        dependencies(),
      );
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) throw new Error('compilation unexpectedly failed');
      expect(compiled.prepared.request.query).toBe('transport parity query');
      return JSON.stringify(compiled.prepared);
    });

    const [library, ...others] = serialized;
    for (const other of others) expect(other).toBe(library);
  });

  it('converts USD budgets exactly and identically to library-provided micro-USD strings', () => {
    const catalog = catalogFor([planningProfile(groundedProfile('alpha'))]);
    const shared = { query: 'budget parity', providers: ['alpha'] } as const;
    const normalized = [
      normalizeLibraryRequest(
        {
          query: shared.query,
          targets: [{ provider_id: 'alpha' }],
          budgets: {
            max_estimated_cost_microusd: '100000',
            max_actual_cost_microusd: '250000',
          },
        },
        FIXTURE_DEFAULTS,
      ),
      normalizeCliRequest(
        { ...shared, maxCostUsd: 0.25, maxEstimatedCostUsd: 0.1 },
        FIXTURE_DEFAULTS,
      ),
      normalizeConfigurationRequest(
        {
          query: shared.query,
          providers: [...shared.providers],
          defaults: { maxCostUsd: 0.25, maxEstimatedCostUsd: 0.1 },
        },
        FIXTURE_DEFAULTS,
      ),
    ];

    const serialized = normalized.map((result) => {
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('normalization unexpectedly failed');
      const compiled = prepareResearchExecution(
        result.request,
        catalog,
        dependencies(),
      );
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) throw new Error('compilation unexpectedly failed');
      expect(compiled.prepared.policy.budgets).toEqual({
        max_estimated_cost_microusd: '100000',
        max_actual_cost_microusd: '250000',
      });
      return JSON.stringify(compiled.prepared);
    });
    expect(new Set(serialized).size).toBe(1);
  });
});

describe('selector conflicts', () => {
  it('rejects raw provider tokens plus private exact targets deterministically', () => {
    const result = normalizeMcpRequest(
      {
        query: 'q',
        providers: ['alpha'],
        exactTargets: [{ provider_id: 'alpha', profile_id: 'grounded-web' }],
      },
      FIXTURE_DEFAULTS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'transport_raw_and_exact_targets_conflict',
        path: '/providers',
      }),
    ]);
  });

  it('lets explicit providers override a group for CLI and MCP ingress with a notice', () => {
    const input = { query: 'q', providers: ['alpha'], group: 'quick' };
    for (const normalize of [
      normalizeCliRequest,
      normalizeMcpRequest,
      normalizeSilentMcpRequest,
    ]) {
      const result = normalize(input, FIXTURE_DEFAULTS);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.request.selector).toEqual({
        kind: 'targets',
        targets: [{ provider_id: 'alpha' }],
      });
      expect(result.notices).toEqual([
        expect.objectContaining({
          code: 'transport_explicit_providers_override_group',
          phase: 'transport',
          path: '/group',
        }),
      ]);
    }
  });

  it('rejects providers plus group ambiguity for library and configuration', () => {
    const configuration = normalizeConfigurationRequest(
      { query: 'q', providers: ['alpha'], group: 'quick' },
      FIXTURE_DEFAULTS,
    );
    expect(configuration.ok).toBe(false);
    if (configuration.ok) return;
    expect(configuration.issues).toEqual([
      expect.objectContaining({
        code: 'transport_selector_conflict',
        phase: 'transport',
        path: '/group',
      }),
    ]);

    const library = normalizeLibraryRequest(
      {
        query: 'q',
        targets: [{ provider_id: 'alpha' }],
        group: 'quick',
        capabilities: {
          requirements: {
            result_kind: 'grounded_answer',
            grounding_policy: 'required',
            corpora: ['web'],
          },
        },
      },
      FIXTURE_DEFAULTS,
    );
    expect(library.ok).toBe(false);
    if (library.ok) return;
    expect(library.issues.map(({ code, path }) => [code, path])).toEqual([
      ['transport_selector_conflict', '/capabilities'],
      ['transport_selector_conflict', '/group'],
    ]);
  });

  it('treats a provided-but-empty provider selection as a caller mistake, mirroring v1', () => {
    const result = normalizeMcpRequest(
      { query: 'q', providers: [' '] },
      FIXTURE_DEFAULTS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'transport_empty_provider_selection',
        path: '/providers',
      }),
    ]);
  });

  it('falls back to the default selector when no selection is present', () => {
    const result = normalizeSilentMcpRequest({ query: 'q' }, FIXTURE_DEFAULTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.selector).toEqual({ kind: 'default' });
    expect(result.request.fallback).toEqual(FIXTURE_DEFAULTS.fallback);
    expect(result.request.limits).toEqual(FIXTURE_DEFAULTS.limits);
    expect(result.request.refinement).toEqual(FIXTURE_DEFAULTS.refinement);
  });
});

describe('transport budgets and legacy mode', () => {
  it('rejects USD budgets that do not convert exactly to micro-USD', () => {
    const inexact = normalizeCliRequest(
      { query: 'q', providers: ['alpha'], maxCostUsd: 0.0000001 },
      FIXTURE_DEFAULTS,
    );
    expect(inexact.ok).toBe(false);
    if (inexact.ok) return;
    expect(inexact.issues).toEqual([
      expect.objectContaining({
        code: 'transport_budget_not_exact',
        path: '/maxCostUsd',
      }),
    ]);

    const negative = normalizeConfigurationRequest(
      {
        query: 'q',
        providers: ['alpha'],
        defaults: { maxEstimatedCostUsd: -1 },
      },
      FIXTURE_DEFAULTS,
    );
    expect(negative.ok).toBe(false);
    if (negative.ok) return;
    expect(negative.issues).toEqual([
      expect.objectContaining({
        code: 'transport_budget_not_exact',
        path: '/defaults/maxEstimatedCostUsd',
      }),
    ]);

    const zero = normalizeCliRequest(
      { query: 'q', providers: ['alpha'], maxEstimatedCostUsd: 0 },
      FIXTURE_DEFAULTS,
    );
    expect(zero.ok).toBe(true);
    if (!zero.ok) return;
    expect(zero.request.budgets).toEqual({
      max_estimated_cost_microusd: '0',
    });
  });

  it('passes legacy mixed mode through to the migration boundary unchanged (v1 surface preserved in shadow)', () => {
    const catalog = catalogFor([
      planningProfile(groundedProfile('alpha', 'durable')),
    ]);
    const normalized = normalizeSilentMcpRequest(
      { query: 'legacy mixed query', providers: ['alpha'], mode: 'mixed' },
      FIXTURE_DEFAULTS,
    );
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.request.mode).toBe('mixed');

    const compiled = compileNormalizedTransportRequest(
      normalized,
      catalog,
      dependencies(),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.prepared.request.mode).toBe('async');
    expect(compiled.notices).toContainEqual(
      expect.objectContaining({ code: 'legacy_mixed_mode_migrated' }),
    );
  });

  it('preserves approved selector precedence through the shadow helper', () => {
    const catalog = catalogFor([planningProfile(groundedProfile('alpha'))]);
    const compiled = compileNormalizedTransportRequest(
      normalizeCliRequest(
        { query: 'q', providers: ['alpha'], group: 'quick' },
        FIXTURE_DEFAULTS,
      ),
      catalog,
      dependencies(),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.notices).toContainEqual(
      expect.objectContaining({
        code: 'transport_explicit_providers_override_group',
        path: '/group',
      }),
    );

    const rejected = compileNormalizedTransportRequest(
      normalizeLibraryRequest(
        { query: 'q', targets: [{ provider_id: 'alpha' }], group: 'quick' },
        FIXTURE_DEFAULTS,
      ),
      catalog,
      dependencies(),
    );
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.issues).toEqual([
      expect.objectContaining({ code: 'transport_selector_conflict' }),
    ]);
  });

  it('still compiles an unambiguous selector without transport notices', () => {
    const catalog = catalogFor([planningProfile(groundedProfile('alpha'))]);
    const normalized = normalizeCliRequest(
      { query: 'q', providers: ['alpha'] },
      FIXTURE_DEFAULTS,
    );
    const compiled = compileNormalizedTransportRequest(
      normalized,
      catalog,
      dependencies(),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.notices).toEqual([]);
  });
});
