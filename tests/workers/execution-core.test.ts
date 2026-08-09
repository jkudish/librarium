import { describe, expect, it } from 'vitest';
import type { ExecutionProfile } from '../../src/contracts/domain/index.js';
import {
  createCoordinatorState,
  recordLaunchDispatched,
  startLaunchableAttempts,
} from '../../src/core/coordinator.js';
import { InMemoryCoordinationStateStore } from '../../src/core/coordinator-store.js';
import {
  type FrozenPlanningCatalog,
  prepareResearchExecution,
} from '../../src/core/execution-plan.js';
import { CanonicalResearchRequestSchema } from '../../src/core/research-request.js';

const profile: ExecutionProfile = {
  identity: { provider_id: 'worker-fixture', profile_id: 'grounded-web' },
  result_kind: 'grounded_answer',
  grounding_policy: 'required',
  observation_mode: 'api_output',
  corpora: ['web'],
  retrieval_method: 'model_search_tool',
  access_mode: 'direct',
  operator_id: 'worker-fixture',
  invocation: 'inline',
  resumability: 'none',
};

describe('private execution architecture in workerd', () => {
  it('prepares, coordinates, and persists without Node APIs', async () => {
    const catalog: FrozenPlanningCatalog = {
      revision: 'worker-r1',
      digest: 'worker-digest',
      profiles: [
        {
          profile,
          binding: {
            adapter_id: 'worker-adapter',
            binding_id: 'worker-binding',
          },
          estimate: { estimated_cost_microusd: '0' },
          enabled: true,
          credentialed: true,
          configuration_valid: true,
        },
      ],
      resolveGroup: () => undefined,
      resolveDefault: () => [profile.identity],
      resolveConfiguredReserve: () => [],
    };
    const preparationIds = {
      next: (scope: 'request' | 'slot' | 'fallback_candidate') =>
        `worker-${scope}`,
    };
    const request = CanonicalResearchRequestSchema.parse({
      query: '  worker-safe query  ',
      mode: 'sync',
      selector: { kind: 'default' },
      fallback: { kind: 'disabled' },
      limits: {
        max_concurrency: 1,
        request_deadline_ms: 60_000,
        inline_attempt_deadline_ms: 30_000,
        background_attempt_deadline_ms: 60_000,
        poll_interval_ms: 1_000,
      },
    });
    const prepared = prepareResearchExecution(request, catalog, {
      clock: { now: () => Date.parse('2026-08-08T12:00:00Z') },
      ids: preparationIds,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    let id = 0;
    const dependencies = {
      clock: { now: () => Date.parse('2026-08-08T12:00:00Z') },
      ids: {
        next: (scope: 'attempt' | 'event' | 'delivery_lease') => {
          id += 1;
          return `worker-${scope}-${id}`;
        },
      },
    };
    const started = startLaunchableAttempts(
      createCoordinatorState(prepared.prepared, dependencies),
      dependencies,
    );
    expect(started.launches).toHaveLength(1);
    expect(started.launches[0]?.query).toBe('worker-safe query');
    const dispatched = recordLaunchDispatched(
      started.state,
      started.launches[0]?.attempt_id ?? '',
      started.launches[0]?.delivery_lease_id ?? '',
      dependencies,
    );
    expect(dispatched.attempts[0]?.status).toBe('running');

    const store = new InMemoryCoordinationStateStore();
    const created = await store.create(dispatched);
    expect(created.version).toBe(1);
    await expect(store.load(dispatched.request_id)).resolves.toMatchObject({
      version: 1,
      state: { request_id: dispatched.request_id },
    });
  });
});
