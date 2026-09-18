import { describe, expect, it } from 'vitest';
import type { ExecutionProfile } from '../src/contracts/domain/index.js';
import {
  admitResearchExecution,
  type FrozenPlanningCatalog,
  materializeResearchExecution,
  type PlanningProfile,
  type PreparationDependencies,
  prepareResearchExecution,
  type ResearchExecutionAdmission,
} from '../src/core/execution-plan.js';
import {
  deriveV1RequestDeadline,
  type V1RequestDeadlineMigrationContext,
} from '../src/core/request-deadline-migration.js';

function profile(providerId: string): ExecutionProfile {
  return {
    identity: {
      provider_id: providerId,
      profile_id: 'search',
      target: { primary: { model_selection: 'not_applicable' } },
    },
    result_kind: 'search_results',
    observation_mode: 'api_output',
    corpora: ['web'],
    retrieval_method: 'search_endpoint',
    access_mode: 'direct',
    operator_id: providerId,
    invocation: 'inline',
    resumability: 'none',
  };
}

function entry(candidate: ExecutionProfile, index: number): PlanningProfile {
  return {
    profile: candidate,
    binding: {
      adapter_id: `adapter-${index}`,
      binding_id: `binding-${index}`,
    },
    enabled: true,
    credentialed: true,
    configuration_valid: true,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    query: 'phase parity',
    mode: 'sync',
    selector: { kind: 'default' },
    fallback: { kind: 'configured' },
    limits: {
      max_concurrency: 2,
      request_deadline_ms: 60_000,
      inline_attempt_deadline_ms: 10_000,
      background_attempt_deadline_ms: 20_000,
      poll_interval_ms: 1_000,
    },
    exclusions: [],
    refinement: { kind: 'disabled' },
    ...overrides,
  };
}

function dependencies() {
  const counts = { clock: 0, ids: 0 };
  const perScope = new Map<string, number>();
  const value: PreparationDependencies = {
    clock: {
      now: () => {
        counts.clock += 1;
        return Date.parse('2026-08-09T12:00:00Z');
      },
    },
    ids: {
      next: (scope) => {
        counts.ids += 1;
        const next = (perScope.get(scope) ?? 0) + 1;
        perScope.set(scope, next);
        return `${scope}-${next}`;
      },
    },
  };
  return { counts, value };
}

function catalog(
  primary: ExecutionProfile,
  reserve?: ExecutionProfile,
): FrozenPlanningCatalog {
  return {
    revision: 'phase-revision',
    digest: 'phase-digest',
    profiles: [entry(primary, 1), ...(reserve ? [entry(reserve, 2)] : [])],
    resolveGroup: () => undefined,
    resolveDefault: () => [primary.identity],
    resolveConfiguredReserve: () => (reserve ? [reserve.identity] : []),
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function deadlineContext(): V1RequestDeadlineMigrationContext {
  return {
    kind: 'v1_request_deadline_migration',
    max_parallel: 2,
    inline_attempt_deadline_ms: 10_000,
    raw_background_attempt_deadline_ms: 20_000,
    poll_interval_ms: 1_000,
    legacy_mode: 'sync',
  };
}

describe('research execution admission phases', () => {
  it('keeps native explicit-deadline preparation byte-equivalent', () => {
    const built = catalog(profile('primary'), profile('reserve'));
    const directDependencies = dependencies();
    const phasedDependencies = dependencies();
    const direct = prepareResearchExecution(
      request(),
      built,
      directDependencies.value,
    );
    const admitted = admitResearchExecution(request(), built);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const phased = materializeResearchExecution(
      admitted.admission,
      admitted.limits,
      phasedDependencies.value,
    );
    expect(JSON.stringify(phased)).toBe(JSON.stringify(direct));
    expect(phasedDependencies.counts).toEqual(directDependencies.counts);
  });

  it('does not reselect or drift after admission', () => {
    const first = profile('first');
    const second = profile('second');
    let selections = 0;
    const built: FrozenPlanningCatalog = {
      revision: 'drift-revision',
      digest: 'drift-digest',
      profiles: [entry(first, 1), entry(second, 2)],
      resolveGroup: () => undefined,
      resolveDefault: () => {
        selections += 1;
        return [selections === 1 ? first.identity : second.identity];
      },
      resolveConfiguredReserve: () => [],
    };
    const admitted = admitResearchExecution(
      request({ fallback: { kind: 'disabled' } }),
      built,
    );
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;

    first.identity.provider_id = 'mutated-after-admission';
    const effects = dependencies();
    const materialized = materializeResearchExecution(
      admitted.admission,
      admitted.limits,
      effects.value,
    );
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    expect(selections).toBe(1);
    expect(
      materialized.prepared.request.slots[0]?.primary.identity.provider_id,
    ).toBe('first');
    expect(Object.isFrozen(admitted.admission)).toBe(true);
    expect(
      Object.isFrozen(admitted.admission.primaries[0]?.entry.profile),
    ).toBe(true);
  });

  it('rejects invalid finalized limits before clock or ID effects', () => {
    const admitted = admitResearchExecution(
      request({ fallback: { kind: 'disabled' } }),
      catalog(profile('primary')),
    );
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const effects = dependencies();
    const result = materializeResearchExecution(
      admitted.admission,
      { ...admitted.limits, request_deadline_ms: 500 },
      effects.value,
    );
    expect(result.ok).toBe(false);
    expect(effects.counts).toEqual({ clock: 0, ids: 0 });
  });

  it('rejects a forged admission before clock or ID effects', () => {
    const effects = dependencies();
    const result = materializeResearchExecution(
      {} as ResearchExecutionAdmission,
      request().limits,
      effects.value,
    );
    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'research_admission_invalid' })],
    });
    expect(effects.counts).toEqual({ clock: 0, ids: 0 });
  });

  it('rejects stolen-brand deep and partial admission forgeries at both boundaries', () => {
    const admitted = admitResearchExecution(
      request({ fallback: { kind: 'disabled' } }),
      catalog(profile('primary')),
    );
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;

    const [stolenBrand] = Object.getOwnPropertySymbols(admitted.admission);
    expect(stolenBrand).toBeDefined();
    if (!stolenBrand) return;

    const deepForgery = structuredClone({
      request: admitted.admission.request,
      primaries: admitted.admission.primaries,
      reserve: admitted.admission.reserve,
      provisional_slots: admitted.admission.provisional_slots,
      catalog: admitted.admission.catalog,
      notices: admitted.admission.notices,
    }) as Record<PropertyKey, unknown>;
    Object.defineProperty(deepForgery, stolenBrand, {
      value: true,
      enumerable: true,
    });
    deepFreeze(deepForgery);

    const partialForgery = {
      ...admitted.admission,
      request: { ...admitted.admission.request, query: 'forged mutation' },
    } as unknown as ResearchExecutionAdmission;
    Object.freeze(partialForgery);
    expect(Object.isFrozen(partialForgery)).toBe(true);
    expect(Object.isFrozen(partialForgery.request)).toBe(false);

    for (const forgery of [
      deepForgery as unknown as ResearchExecutionAdmission,
      partialForgery,
    ]) {
      const derived = deriveV1RequestDeadline(deadlineContext(), forgery);
      expect(derived).toMatchObject({
        ok: false,
        issues: [
          expect.objectContaining({ code: 'research_admission_invalid' }),
        ],
      });

      const effects = dependencies();
      const materialized = materializeResearchExecution(
        forgery,
        admitted.limits,
        effects.value,
      );
      expect(materialized).toMatchObject({
        ok: false,
        issues: [
          expect.objectContaining({ code: 'research_admission_invalid' }),
        ],
      });
      expect(effects.counts).toEqual({ clock: 0, ids: 0 });
    }
  });
});
