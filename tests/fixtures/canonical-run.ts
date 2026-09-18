import type { ExecutionProfile } from '../../src/contracts/domain/index.js';
import type { PreparedResearchExecution } from '../../src/core/execution-plan.js';
import { profileIdentityKey } from '../../src/core/execution-plan.js';
import type { Provider, ProviderResult } from '../../src/types.js';

export const CANONICAL_FIXTURE_TIME = Date.parse('2026-08-11T12:00:00.000Z');

export function canonicalFixtureProfile(
  providerId: string,
  invocation: 'inline' | 'background' = 'inline',
): ExecutionProfile {
  return {
    identity: {
      provider_id: providerId,
      profile_id: 'fixture',
      target: {
        primary: {
          model_selection: 'fixed',
          kind: 'model',
          target_id: `${providerId}-model`,
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
    invocation,
    resumability: invocation === 'inline' ? 'none' : 'durable',
  };
}

export function canonicalFixturePrepared(
  profiles: readonly ExecutionProfile[],
  options: {
    readonly mode?: 'sync' | 'async';
    readonly requestId?: string;
    readonly query?: string;
    readonly requestedAtMs?: number;
  } = {},
): PreparedResearchExecution {
  const requestId = options.requestId ?? 'request-1';
  return {
    request: {
      interchange_version: '1.0.0',
      message_type: 'request',
      request_id: requestId,
      requested_at: new Date(
        options.requestedAtMs ?? CANONICAL_FIXTURE_TIME,
      ).toISOString(),
      mode: options.mode ?? 'sync',
      query: options.query ?? 'canonical fixture query',
      slots: profiles.map((profile, position) => ({
        slot_id: `slot-${position}`,
        position,
        requirements: {
          result_kind: profile.result_kind,
          grounding_policy: profile.grounding_policy,
          corpora: [...profile.corpora],
          retrieval_methods: [profile.retrieval_method],
        },
        primary: profile,
      })),
      fallback_reserve: [],
    },
    policy: {
      limits: {
        max_concurrency: profiles.length,
        request_deadline_ms: 60_000,
        inline_attempt_deadline_ms: 10_000,
        background_attempt_deadline_ms: 20_000,
        poll_interval_ms: 1_000,
      },
      fallback: { kind: 'disabled' },
      exclusions: [],
      refinement: { kind: 'disabled' },
    },
    profile_plans_by_identity: Object.fromEntries(
      profiles.map((profile) => {
        const key = profileIdentityKey(profile.identity);
        return [
          key,
          {
            profile_key: key,
            identity: profile.identity,
            binding: {
              adapter_id: `adapter-${profile.identity.provider_id}`,
              binding_id: `binding-${profile.identity.provider_id}`,
            },
          },
        ];
      }),
    ),
    catalog: { revision: 'fixture-r1', digest: 'fixture-digest' },
    notices: [],
  };
}

export function canonicalFixtureCoordinator(now = CANONICAL_FIXTURE_TIME) {
  let next = 0;
  return {
    clock: { now: () => now },
    ids: {
      next: (scope: 'attempt' | 'event' | 'delivery_lease') =>
        `${scope}-${++next}`,
    },
  };
}

export function canonicalFixtureResult(
  provider: string,
  content = '# Canonical result\n\nEvidence.',
): ProviderResult {
  return {
    provider,
    tier: 'ai-grounded',
    content,
    citations: [
      {
        provider,
        url: 'https://example.com/canonical-source',
        title: 'Canonical source',
        snippet: 'Evidence',
      },
    ],
    durationMs: 5,
    model: 'fixture-model',
  };
}

export function canonicalFixtureBridge(
  profiles: readonly ExecutionProfile[],
  providers: Readonly<Record<string, Provider>>,
  now = CANONICAL_FIXTURE_TIME,
) {
  return {
    resolveExactBinding(binding: { adapter_id: string; binding_id: string }) {
      const profile = profiles.find(
        (candidate) =>
          `adapter-${candidate.identity.provider_id}` === binding.adapter_id,
      );
      const provider = providers[binding.adapter_id];
      return profile && provider
        ? {
            binding,
            profile,
            catalog_digest: 'fixture-digest',
            provider,
          }
        : undefined;
    },
    now: () => now,
    wait: async () => {},
  };
}
