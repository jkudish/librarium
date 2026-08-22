import { describe, expect, it } from 'vitest';
import type { ExecutionProfile } from '../src/contracts/domain/index.js';
import {
  admitResearchExecution,
  type FrozenPlanningCatalog,
  type PlanningProfile,
  type ResearchExecutionAdmission,
} from '../src/core/execution-plan.js';
import {
  BUILTIN_PROFILE_BINDING_SPECS,
  buildProfileBindings,
} from '../src/core/profile-bindings.js';
import { BUILTIN_PROVIDER_DEFINITIONS } from '../src/core/provider-descriptor.js';
import {
  BUILTIN_PROVIDER_CATALOG,
  catalogProfileRefs,
} from '../src/core/provider-profiles.js';
import {
  deriveV1RequestDeadline,
  V1_BACKGROUND_TRANSPORT_OVERHEAD_BY_PROFILE,
  V1_SAFE_GET_RETRY_CEILING,
  type V1RequestDeadlineMigrationContext,
  v1BackgroundTransportOverheadMs,
} from '../src/core/request-deadline-migration.js';
import { RESEARCH_REQUEST_LIMITS } from '../src/core/research-request.js';

function profile(
  providerId: string,
  invocation: 'inline' | 'background' = 'inline',
): ExecutionProfile {
  return {
    identity: {
      provider_id: providerId,
      profile_id: invocation === 'inline' ? 'search' : 'research',
      target: { primary: { model_selection: 'not_applicable' } },
    },
    result_kind: 'search_results',
    observation_mode: 'api_output',
    corpora: ['web'],
    retrieval_method: 'search_endpoint',
    access_mode: 'direct',
    operator_id: providerId,
    invocation,
    resumability: invocation === 'inline' ? 'none' : 'durable',
  };
}

function context(
  overrides: Partial<V1RequestDeadlineMigrationContext> = {},
): V1RequestDeadlineMigrationContext {
  return {
    kind: 'v1_request_deadline_migration',
    max_parallel: 2,
    inline_attempt_deadline_ms: 10_000,
    raw_background_attempt_deadline_ms: 20_000,
    poll_interval_ms: 1_000,
    legacy_mode: 'sync',
    ...overrides,
  };
}

function admittedPlan(
  primaries: readonly ExecutionProfile[],
  reserve: readonly ExecutionProfile[] = [],
): ResearchExecutionAdmission {
  const entriesByIdentity = new Map<string, PlanningProfile>();
  for (const candidate of [...primaries, ...reserve]) {
    const key = JSON.stringify(candidate.identity);
    if (entriesByIdentity.has(key)) continue;
    const reserveOnly = candidate.identity.provider_id === 'disabled-reserve';
    entriesByIdentity.set(key, {
      profile: candidate,
      binding: {
        adapter_id: `adapter-${entriesByIdentity.size}`,
        binding_id: `binding-${entriesByIdentity.size}`,
      },
      enabled: !reserveOnly,
      credentialed: true,
      configuration_valid: true,
      ...(reserveOnly && { reserve_only: true }),
    });
  }
  const catalog: FrozenPlanningCatalog = {
    revision: 'deadline-test-revision',
    digest: 'deadline-test-digest',
    profiles: [...entriesByIdentity.values()],
    resolveGroup: () => undefined,
    resolveDefault: () => primaries.map((candidate) => candidate.identity),
    resolveConfiguredReserve: () =>
      reserve.map((candidate) => candidate.identity),
  };
  const admitted = admitResearchExecution(
    {
      query: 'deadline test',
      mode: 'sync',
      selector: { kind: 'default' },
      fallback:
        reserve.length === 0 ? { kind: 'disabled' } : { kind: 'configured' },
      limits: {
        max_concurrency: 2,
        request_deadline_ms: 600_000,
        inline_attempt_deadline_ms: 10_000,
        background_attempt_deadline_ms: 20_000,
        poll_interval_ms: 1_000,
      },
      exclusions: [],
      refinement: { kind: 'disabled' },
    },
    catalog,
  );
  if (!admitted.ok) throw new Error(JSON.stringify(admitted.issues));
  return admitted.admission;
}

describe('v1 total request-deadline migration', () => {
  it('uses one primary attempt allowance when there is no reserve', () => {
    expect(
      deriveV1RequestDeadline(context(), admittedPlan([profile('inline-one')])),
    ).toMatchObject({
      ok: true,
      request_deadline_ms: 20_000,
      source: 'derived_v1_plan',
    });
  });

  it('list-schedules primaries in selection order across max_parallel workers', () => {
    const result = deriveV1RequestDeadline(
      context({ max_parallel: 2 }),
      admittedPlan([
        profile('inline-one'),
        profile('inline-two'),
        profile('inline-three'),
        profile('inline-four'),
        profile('inline-five'),
      ]),
    );
    expect(result).toMatchObject({ ok: true, request_deadline_ms: 30_000 });
  });

  it('uses deterministic selection order when primary durations differ', () => {
    const result = deriveV1RequestDeadline(
      context({ max_parallel: 2 }),
      admittedPlan([
        profile('background-one', 'background'),
        profile('inline-one'),
        profile('inline-two'),
        profile('background-two', 'background'),
      ]),
    );
    expect(result).toMatchObject({ ok: true, request_deadline_ms: 40_000 });
  });

  it('adds every unique reserve sequentially despite primary parallelism', () => {
    const result = deriveV1RequestDeadline(
      context({ max_parallel: 64 }),
      admittedPlan(
        [profile('primary')],
        [profile('reserve-one'), profile('reserve-two')],
      ),
    );
    expect(result).toMatchObject({ ok: true, request_deadline_ms: 30_000 });
  });

  it('keeps inline and background allowances distinct and adds known transport overhead', () => {
    const result = deriveV1RequestDeadline(
      context({ max_parallel: 1 }),
      admittedPlan([
        profile('inline'),
        profile('openai-research', 'background'),
      ]),
    );
    expect(result).toMatchObject({ ok: true, request_deadline_ms: 425_000 });
  });

  it('uses trusted custom profile invocation as the canonical attempt class', () => {
    // Trusted custom executionProfile metadata is the contract assertion. A
    // runtime adapter which disagrees with it violates that trust boundary.
    const result = deriveV1RequestDeadline(
      context(),
      admittedPlan([profile('trusted-custom-inline')]),
    );
    expect(result).toMatchObject({ ok: true, request_deadline_ms: 20_000 });
  });

  it('counts a selected disabled reserve-only profile but deduplicates reserve identities', () => {
    // Availability is settled by selection before this API. A disabled v1
    // fallback admitted as reserve-only is therefore a concrete candidate and
    // must count exactly once even if defensive input repeats it.
    const disabledReserve = profile('disabled-reserve');
    const result = deriveV1RequestDeadline(
      context(),
      admittedPlan(
        [profile('primary')],
        [disabledReserve, disabledReserve, profile('reserve-two')],
      ),
    );
    expect(result).toMatchObject({ ok: true, request_deadline_ms: 30_000 });
  });

  it('deduplicates reserve identities with collision-free canonical tuple keys', () => {
    const slashInProvider = {
      ...profile('a/b'),
      identity: {
        ...profile('a/b').identity,
        profile_id: 'c',
      },
    };
    const slashInProfile = {
      ...profile('a'),
      identity: {
        ...profile('a').identity,
        profile_id: 'b/c',
      },
    };
    const result = deriveV1RequestDeadline(
      context(),
      admittedPlan([profile('primary')], [slashInProvider, slashInProfile]),
    );
    expect(result).toMatchObject({ ok: true, request_deadline_ms: 30_000 });
  });

  it('lets a valid explicit request deadline override the formula', () => {
    const result = deriveV1RequestDeadline(
      context({ explicit_request_deadline_ms: 1_000_000 }),
      admittedPlan(
        [profile('primary')],
        [
          profile('openai-research', 'background'),
          profile('gemini-deep', 'background'),
        ],
      ),
    );
    expect(result).toEqual({
      ok: true,
      request_deadline_ms: 1_000_000,
      effective_background_attempt_deadline_ms: 425_000,
      derived_full_plan_minimum_ms: 860_000,
      source: 'explicit_override',
      notices: [],
    });
  });

  it('warns when an authoritative explicit total may truncate the full plan', () => {
    const result = deriveV1RequestDeadline(
      context({
        max_parallel: 1,
        explicit_request_deadline_ms: 500_000,
      }),
      admittedPlan([
        profile('openai-research', 'background'),
        profile('background-two', 'background'),
      ]),
    );
    expect(result).toMatchObject({
      ok: true,
      request_deadline_ms: 500_000,
      effective_background_attempt_deadline_ms: 415_000,
      derived_full_plan_minimum_ms: 830_000,
      source: 'explicit_override',
      notices: [
        expect.objectContaining({
          code: 'explicit_request_deadline_may_truncate_plan',
          path: '/deadline_migration/explicit_request_deadline_ms',
        }),
      ],
    });
  });

  it('rejects an explicit total below the effective attempt cap', () => {
    const result = deriveV1RequestDeadline(
      context({ explicit_request_deadline_ms: 414_999 }),
      admittedPlan([profile('openai-research', 'background')]),
    );
    expect(result).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: 'request_deadline_less_than_attempt_deadline',
        }),
      ],
    });
  });

  it('uses the maximum selected overhead as one reachable global background attempt cap', () => {
    const result = deriveV1RequestDeadline(
      context(),
      admittedPlan([
        profile('openai-research', 'background'),
        profile('gemini-deep', 'background'),
        profile('unknown-background', 'background'),
      ]),
    );
    expect(result).toMatchObject({
      ok: true,
      effective_background_attempt_deadline_ms: 425_000,
      derived_full_plan_minimum_ms: 850_000,
      request_deadline_ms: 850_000,
    });
  });

  it('does not treat legacy async polling cadence as deadline allowance', () => {
    const plan = admittedPlan([profile('background', 'background')]);
    const frequent = deriveV1RequestDeadline(
      context({ poll_interval_ms: 1_000 }),
      plan,
    );
    const sparse = deriveV1RequestDeadline(
      context({ poll_interval_ms: 20_000 }),
      plan,
    );
    expect(frequent).toMatchObject({ ok: true, request_deadline_ms: 20_000 });
    expect(sparse).toEqual(frequent);
  });

  it.each(['async', 'mixed'] as const)(
    'emits the bounded wait migration notice for legacy %s mode',
    (legacyMode) => {
      const result = deriveV1RequestDeadline(
        context({ legacy_mode: legacyMode }),
        admittedPlan([profile('primary')]),
      );
      expect(result.notices).toContainEqual(
        expect.objectContaining({
          code: 'legacy_wait_is_bounded_in_v2',
          path: '/deadline_migration/legacy_mode',
        }),
      );
    },
  );

  it.each([
    {
      label: 'invalid migration kind',
      overrides: {
        kind: 'forged-kind',
      } as unknown as Partial<V1RequestDeadlineMigrationContext>,
      code: 'request_deadline_invalid_migration_context',
      path: '/deadline_migration/kind',
    },
    {
      label: 'invalid legacy mode',
      overrides: {
        legacy_mode: 'forever',
      } as unknown as Partial<V1RequestDeadlineMigrationContext>,
      code: 'request_deadline_invalid_legacy_mode',
      path: '/deadline_migration/legacy_mode',
    },
    {
      label: 'fractional concurrency',
      overrides: { max_parallel: 1.5 },
      code: 'request_deadline_concurrency_out_of_bounds',
      path: '/deadline_migration/max_parallel',
    },
    {
      label: 'concurrency above the maximum',
      overrides: { max_parallel: 65 },
      code: 'request_deadline_concurrency_out_of_bounds',
      path: '/deadline_migration/max_parallel',
    },
    {
      label: 'fractional inline deadline',
      overrides: { inline_attempt_deadline_ms: 1.5 },
      code: 'request_deadline_invalid_integer',
      path: '/deadline_migration/inline_attempt_deadline_ms',
    },
    {
      label: 'negative background deadline',
      overrides: { raw_background_attempt_deadline_ms: -1 },
      code: 'request_deadline_invalid_integer',
      path: '/deadline_migration/raw_background_attempt_deadline_ms',
    },
    {
      label: 'unsafe inline deadline',
      overrides: { inline_attempt_deadline_ms: Number.MAX_SAFE_INTEGER + 1 },
      code: 'request_deadline_invalid_integer',
      path: '/deadline_migration/inline_attempt_deadline_ms',
    },
    {
      label: 'poll interval below its minimum',
      overrides: { poll_interval_ms: 99 },
      code: 'request_deadline_poll_interval_out_of_bounds',
      path: '/deadline_migration/poll_interval_ms',
    },
    {
      label: 'poll interval above the background attempt',
      overrides: {
        raw_background_attempt_deadline_ms: 1_000,
        poll_interval_ms: 2_000,
      },
      code: 'request_deadline_poll_interval_exceeds_background_attempt',
      path: '/deadline_migration/poll_interval_ms',
    },
    {
      label: 'invalid explicit request deadline integer',
      overrides: { explicit_request_deadline_ms: -1 },
      code: 'request_deadline_invalid_integer',
      path: '/deadline_migration/explicit_request_deadline_ms',
    },
  ])('rejects $label with the exact context diagnostic', (fixture) => {
    const result = deriveV1RequestDeadline(
      context(fixture.overrides),
      admittedPlan([profile('primary')]),
    );
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(
      result.issues.map(({ code, path }) => ({ code, path })),
    ).toContainEqual({ code: fixture.code, path: fixture.path });
  });

  it('accepts the exact 7-day boundary', () => {
    const half = RESEARCH_REQUEST_LIMITS.maxDeadlineMs / 2;
    const result = deriveV1RequestDeadline(
      context({
        max_parallel: 1,
        inline_attempt_deadline_ms: half,
      }),
      admittedPlan([profile('one'), profile('two')]),
    );
    expect(result).toMatchObject({
      ok: true,
      request_deadline_ms: RESEARCH_REQUEST_LIMITS.maxDeadlineMs,
    });
  });

  it('rejects one millisecond beyond the 7-day boundary without clamping', () => {
    const plusOne = deriveV1RequestDeadline(
      context({
        max_parallel: 1,
        inline_attempt_deadline_ms: 1_000,
        raw_background_attempt_deadline_ms:
          RESEARCH_REQUEST_LIMITS.maxDeadlineMs - 999,
      }),
      admittedPlan([profile('one', 'background')], [profile('one-ms-reserve')]),
    );
    expect(plusOne).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: 'request_deadline_contract_maximum_exceeded',
        }),
      ],
    });
  });

  it('applies selected retry overhead exactly at the 7-day boundary without clamping', () => {
    const selected = admittedPlan([profile('gemini-deep', 'background')]);
    const boundary = deriveV1RequestDeadline(
      context({
        max_parallel: 1,
        raw_background_attempt_deadline_ms: 604_395_000,
      }),
      selected,
    );
    expect(boundary).toMatchObject({
      ok: true,
      request_deadline_ms: 604_800_000,
      effective_background_attempt_deadline_ms: 604_800_000,
    });

    const plusOne = deriveV1RequestDeadline(
      context({
        max_parallel: 1,
        raw_background_attempt_deadline_ms: 604_395_001,
      }),
      selected,
    );
    expect(plusOne).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: 'request_deadline_contract_maximum_exceeded',
          path: '/deadline_migration/effective_background_attempt_deadline_ms',
        }),
      ],
    });
  });

  it('reports safe-integer overflow separately from the contract maximum', () => {
    const result = deriveV1RequestDeadline(
      context({
        max_parallel: 1,
        raw_background_attempt_deadline_ms: Number.MAX_SAFE_INTEGER,
      }),
      admittedPlan([profile('openai-research', 'background')]),
    );
    expect(result).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: 'request_deadline_arithmetic_overflow',
          path: '/deadline_migration/effective_background_attempt_deadline_ms',
        }),
      ],
    });
  });

  it('pins the audited safe-GET Retry-After ceiling above jitter backoff', () => {
    expect(V1_SAFE_GET_RETRY_CEILING).toEqual({
      max_attempts: 4,
      retry_delay_count: 3,
      retry_after_cap_ms: 30_000,
      jitter_caps_ms: [1_000, 2_000, 4_000],
      maximum_retry_delay_ms: 90_000,
    });
    expect(3 * 30_000).toBeGreaterThan(1_000 + 2_000 + 4_000);
    expect(V1_SAFE_GET_RETRY_CEILING.maximum_retry_delay_ms).toBe(3 * 30_000);
  });

  it('classifies audited OpenAI, Gemini, and Perplexity background overhead explicitly', () => {
    expect(V1_BACKGROUND_TRANSPORT_OVERHEAD_BY_PROFILE).toEqual({
      'openai-research/research': {
        submit_timeout_ms: 30_000,
        final_poll_sleep_ms: 5_000,
        poll_attempt_timeout_ms: 15_000,
        poll_ceiling_ms: 150_000,
        retrieve_attempt_timeout_ms: 30_000,
        retrieve_ceiling_ms: 210_000,
        total_ms: 395_000,
      },
      'gemini-deep/research': {
        submit_timeout_ms: 30_000,
        final_poll_sleep_ms: 15_000,
        poll_attempt_timeout_ms: 15_000,
        poll_ceiling_ms: 150_000,
        retrieve_attempt_timeout_ms: 30_000,
        retrieve_ceiling_ms: 210_000,
        total_ms: 405_000,
      },
      'perplexity-sonar-deep/research': {
        submit_timeout_ms: 30_000,
        final_poll_sleep_ms: 0,
        poll_attempt_timeout_ms: 15_000,
        poll_ceiling_ms: 150_000,
        retrieve_attempt_timeout_ms: 30_000,
        retrieve_ceiling_ms: 210_000,
        total_ms: 390_000,
      },
      'perplexity-deep-research/research': {
        submit_timeout_ms: 30_000,
        final_poll_sleep_ms: 0,
        poll_attempt_timeout_ms: 15_000,
        poll_ceiling_ms: 150_000,
        retrieve_attempt_timeout_ms: 30_000,
        retrieve_ceiling_ms: 210_000,
        total_ms: 390_000,
      },
    });
    for (const policy of Object.values(
      V1_BACKGROUND_TRANSPORT_OVERHEAD_BY_PROFILE,
    )) {
      expect(policy.poll_ceiling_ms).toBe(4 * 15_000 + 3 * 30_000);
      expect(policy.retrieve_ceiling_ms).toBe(4 * 30_000 + 3 * 30_000);
      expect(policy.total_ms).toBe(
        policy.submit_timeout_ms +
          policy.final_poll_sleep_ms +
          policy.poll_ceiling_ms +
          policy.retrieve_ceiling_ms,
      );
    }
    expect(
      v1BackgroundTransportOverheadMs(profile('openai-research', 'background')),
    ).toBe(395_000);
    expect(
      v1BackgroundTransportOverheadMs(profile('gemini-deep', 'background')),
    ).toBe(405_000);
    expect(
      v1BackgroundTransportOverheadMs(
        profile('perplexity-sonar-deep', 'background'),
      ),
    ).toBe(390_000);
    expect(
      v1BackgroundTransportOverheadMs(
        profile('unknown-background', 'background'),
      ),
    ).toBe(0);
    expect(v1BackgroundTransportOverheadMs(profile('openai-research'))).toBe(0);
  });

  it('keeps target identity in reserve deduplication', () => {
    const first = profile('targeted-reserve');
    const second = profile('targeted-reserve');
    first.identity.target.primary = {
      model_selection: 'fixed',
      kind: 'model',
      target_id: 'model-one',
    };
    second.identity.target.primary = {
      model_selection: 'fixed',
      kind: 'model',
      target_id: 'model-two',
    };
    const result = deriveV1RequestDeadline(
      context(),
      admittedPlan([profile('primary')], [first, second]),
    );
    expect(result).toMatchObject({ ok: true, request_deadline_ms: 30_000 });
  });

  it('matches v2 invocation to the v1 tier deadline class for every built-in adapter', () => {
    const expectedAdapterIds = [
      'parallel-research',
      'parallel-chat',
      'parallel-search',
      'parallel-turbo',
      'perplexity-sonar-deep',
      'perplexity-deep-research',
      'openai-research',
      'gemini-deep',
      'perplexity-sonar-pro',
      'gemini-grounded',
      'grok',
      'grok-x-only',
      'grok-combined',
      'openrouter-online',
      'brave-answers',
      'you-research',
      'you-research-background',
      'you-answer',
      'kagi-fastgpt',
      'exa',
      'exa-research',
      'perplexity-search',
      'brave-search',
      'jina-search',
      'firecrawl-search',
      'searchapi',
      'serpapi',
      'tavily',
      'tavily-research',
      'valyu-search',
      'valyu-research',
      'searchapi-chatgpt',
      'searchapi-gemini',
      'searchapi-perplexity',
      'searchapi-google-ai-mode',
      'searchapi-bing-copilot',
      'searchapi-google-ai-overview',
      'claude',
      'openai-chat',
      'gemini-chat',
      'openrouter-chat',
    ];
    expect(
      BUILTIN_PROFILE_BINDING_SPECS.map((spec) => spec.adapter_id),
    ).toEqual(expectedAdapterIds);
    expect(new Set(expectedAdapterIds).size).toBe(41);
    const declarations = new Map(
      catalogProfileRefs(BUILTIN_PROVIDER_CATALOG).map(
        ({ entry, declaration }) => [
          `${entry.provider_id}/${declaration.profile_id}`,
          declaration,
        ],
      ),
    );
    const bindings = buildProfileBindings(declarations);
    const tiers = new Map(
      BUILTIN_PROVIDER_DEFINITIONS.map((definition) => [
        definition.id,
        definition.tier,
      ]),
    );
    for (const spec of BUILTIN_PROFILE_BINDING_SPECS) {
      const resolved = bindings
        .get(`${spec.provider_id}/${spec.profile_id}`)
        ?.resolve().profile;
      expect(resolved, spec.adapter_id).toBeDefined();
      expect(resolved?.invocation, spec.adapter_id).toBe(
        tiers.get(spec.adapter_id) === 'deep-research'
          ? 'background'
          : 'inline',
      );
    }
  });
});
