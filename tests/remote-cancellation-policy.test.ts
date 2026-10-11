import { describe, expect, it, vi } from 'vitest';
import type {
  DurableHandle,
  ExecutionProfile,
} from '../src/contracts/domain/index.js';
import {
  type AttemptLaunch,
  createCoordinatorState,
} from '../src/core/coordinator.js';
import { CoordinatorStateSchema } from '../src/core/coordinator-state-schema.js';
import {
  admitResearchExecution,
  type ExactProfileRemoteCancellationPolicy,
  materializeResearchExecution,
  profileIdentityKey,
} from '../src/core/execution-plan.js';
import { buildProviderCatalog } from '../src/core/profile-catalog.js';
import { createProviderAttemptBridge } from '../src/core/provider-attempt-bridge.js';
import { createRegisteredProviderAttemptBridge } from '../src/node-canonical-run.js';
import type { Provider } from '../src/types.js';

const START = Date.parse('2026-09-08T12:00:00.000Z');

function request(providerId: string, profileId: string) {
  return {
    query: 'frozen cancellation policy',
    mode: 'sync',
    selector: {
      kind: 'targets',
      targets: [{ provider_id: providerId, profile_id: profileId }],
    },
    fallback: { kind: 'disabled' },
    limits: {
      max_concurrency: 1,
      request_deadline_ms: 60_000,
      inline_attempt_deadline_ms: 10_000,
      background_attempt_deadline_ms: 30_000,
      poll_interval_ms: 1_000,
    },
  } as const;
}

function preparationDependencies() {
  let next = 0;
  return {
    clock: { now: () => START },
    ids: {
      next: (scope: 'request' | 'slot' | 'fallback_candidate') =>
        `${scope}-${++next}`,
    },
  };
}

function coordinatorDependencies() {
  let next = 0;
  return {
    clock: { now: () => START },
    ids: {
      next: (scope: 'attempt' | 'event' | 'delivery_lease') =>
        `${scope}-${++next}`,
    },
  };
}

function durableProfile(): ExecutionProfile {
  return {
    identity: {
      provider_id: 'provider',
      profile_id: 'research',
      target: {
        primary: {
          model_selection: 'fixed',
          kind: 'preset',
          target_id: 'standard',
        },
      },
    },
    result_kind: 'research_report',
    grounding_policy: 'required',
    observation_mode: 'api_output',
    corpora: ['web'],
    retrieval_method: 'research_agent',
    access_mode: 'direct',
    operator_id: 'provider',
    invocation: 'background',
    resumability: 'durable',
  };
}

describe('exact-profile remote cancellation policy', () => {
  it('freezes the actual catalog feature into new plans and persists it', () => {
    const source = buildProviderCatalog({ assumeCredentialAvailability: true });
    const supported = source.resolved.find(
      (candidate) =>
        candidate.binding &&
        candidate.declaration.features?.remote_cancellation === true,
    );
    const reconcileOnly = source.resolved.find(
      (candidate) =>
        candidate.binding &&
        candidate.profile.invocation === 'background' &&
        candidate.profile.resumability === 'durable' &&
        candidate.declaration.features?.remote_cancellation !== true,
    );
    if (!supported?.binding || !reconcileOnly?.binding) {
      throw new Error(
        'Expected supported and reconcile-only catalog profiles.',
      );
    }
    const catalog = buildProviderCatalog({
      assumeCredentialAvailability: true,
      providerConfigs: {
        [supported.binding.adapter_id]: { enabled: true },
        [supported.profile.identity.provider_id]: { enabled: true },
        [reconcileOnly.binding.adapter_id]: { enabled: true },
        [reconcileOnly.profile.identity.provider_id]: { enabled: true },
      },
    });

    const supportedAdmission = admitResearchExecution(
      request(
        supported.profile.identity.provider_id,
        supported.profile.identity.profile_id,
      ),
      catalog,
    );
    const reconcileAdmission = admitResearchExecution(
      request(
        reconcileOnly.profile.identity.provider_id,
        reconcileOnly.profile.identity.profile_id,
      ),
      catalog,
    );
    expect(supportedAdmission.ok).toBe(true);
    expect(reconcileAdmission.ok).toBe(true);
    if (!supportedAdmission.ok || !reconcileAdmission.ok) return;
    expect(supportedAdmission.admission.primaries[0]?.cancel_policy).toBe(
      'supported_exact_profile',
    );
    expect(reconcileAdmission.admission.primaries[0]?.cancel_policy).toBe(
      'reconcile_only',
    );
    expect(Object.isFrozen(supportedAdmission.admission.primaries[0])).toBe(
      true,
    );

    const materialized = materializeResearchExecution(
      supportedAdmission.admission,
      supportedAdmission.limits,
      preparationDependencies(),
    );
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    const key = profileIdentityKey(supported.profile.identity);
    expect(
      materialized.prepared.profile_plans_by_identity[key]?.cancel_policy,
    ).toBe('supported_exact_profile');

    const state = createCoordinatorState(
      materialized.prepared,
      coordinatorDependencies(),
    );
    const persisted = CoordinatorStateSchema.parse(
      JSON.parse(JSON.stringify(state)),
    );
    expect(persisted.profile_plans_by_identity[key]?.cancel_policy).toBe(
      'supported_exact_profile',
    );
    const provider: Provider = {
      id: supported.binding.adapter_id,
      displayName: 'Supported cancellation fixture',
      tier: 'deep-research',
      envVar: '',
      execution: 'background',
      execute: vi.fn(),
      submit: vi.fn(),
      poll: vi.fn(),
      retrieve: vi.fn(),
      cancel: vi.fn(),
    };
    expect(
      createRegisteredProviderAttemptBridge(
        materialized.prepared,
        () => provider,
      ).resolveExactBinding(
        materialized.prepared.profile_plans_by_identity[key]!.binding,
      )?.cancel_policy,
    ).toBe('supported_exact_profile');

    const historical = structuredClone(state);
    const historicalPlan = historical.profile_plans_by_identity[key];
    if (!historicalPlan) throw new Error('Expected a historical profile plan.');
    Reflect.deleteProperty(historicalPlan, 'cancel_policy');
    expect(CoordinatorStateSchema.safeParse(historical).success).toBe(true);
  });

  it.each([
    ['supported_exact_profile', 1, 'cancelled'],
    ['reconcile_only', 0, undefined],
    [undefined, 0, undefined],
  ] as const)(
    'enforces %s immediately before the provider cancellation effect',
    async (cancelPolicy, expectedCalls, expectedStatus) => {
      const profile = durableProfile();
      const cancel = vi.fn(async () => ({ status: 'cancelled' as const }));
      const provider: Provider = {
        id: 'adapter-provider',
        displayName: 'Provider',
        tier: 'deep-research',
        envVar: '',
        execution: 'background',
        execute: vi.fn(),
        submit: vi.fn(),
        poll: vi.fn(),
        retrieve: vi.fn(),
        cancel,
      };
      const binding = {
        adapter_id: provider.id,
        binding_id: 'binding-provider',
      };
      const launch: AttemptLaunch = {
        attempt_id: 'attempt-1',
        slot_id: 'slot-1',
        profile,
        binding,
        catalog_digest: 'catalog-digest',
        query: 'cancel exact work',
        deadline_at: new Date(START + 30_000).toISOString(),
        delivery_lease_id: 'lease-1',
        idempotency_key: 'attempt-1',
      };
      const handle: DurableHandle = {
        handle_id: 'handle-1',
        provider_task_id: 'task-1',
        provider: profile.identity,
        submitted_at: new Date(START).toISOString(),
        status: 'running',
      };
      const bridge = createProviderAttemptBridge({
        resolveExactBinding: () => ({
          binding,
          profile,
          catalog_digest: 'catalog-digest',
          provider,
          ...(cancelPolicy !== undefined && {
            cancel_policy: cancelPolicy as ExactProfileRemoteCancellationPolicy,
          }),
        }),
        now: () => START + 1_000,
      });

      const result = await bridge.cancel?.(launch, handle);

      expect(cancel).toHaveBeenCalledTimes(expectedCalls);
      expect(result?.status).toBe(expectedStatus);
    },
  );
});
