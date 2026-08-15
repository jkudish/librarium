import {
  type ExecutionProfile,
  providerIdentityKey,
} from '../contracts/domain/index.js';
import {
  isMintedResearchExecutionAdmission,
  type ResearchExecutionAdmission,
} from './execution-plan.js';
import {
  comparePreparationDiagnostics,
  type PreparationIssue,
  type PreparationNotice,
  RESEARCH_REQUEST_LIMITS,
} from './research-request.js';

/**
 * Validated v1 timing facts which are not yet a canonical execution policy.
 *
 * A caller must first resolve the concrete ordered primary and reserve plans,
 * call {@link deriveV1RequestDeadline}, then construct and schema-validate the
 * final canonical limits. This type deliberately cannot be mistaken for
 * `CanonicalTransportDefaults` or a completed request.
 */
export interface V1RequestDeadlineMigrationContext {
  readonly kind: 'v1_request_deadline_migration';
  readonly max_parallel: number;
  readonly inline_attempt_deadline_ms: number;
  readonly raw_background_attempt_deadline_ms: number;
  /** Final canonical limit data; polling cadence is excluded from arithmetic. */
  readonly poll_interval_ms: number;
  readonly legacy_mode: 'sync' | 'async' | 'mixed';
  readonly explicit_request_deadline_ms?: number;
}

export type V1RequestDeadlineDerivationResult =
  | {
      readonly ok: true;
      readonly request_deadline_ms: number;
      readonly effective_background_attempt_deadline_ms: number;
      readonly derived_full_plan_minimum_ms: number;
      readonly source: 'explicit_override' | 'derived_v1_plan';
      readonly notices: readonly PreparationNotice[];
    }
  | {
      readonly ok: false;
      readonly issues: readonly PreparationIssue[];
      readonly notices: readonly PreparationNotice[];
    };

export interface BackgroundTransportOverheadPolicy {
  readonly submit_timeout_ms: number;
  readonly final_poll_sleep_ms: number;
  readonly poll_attempt_timeout_ms: number;
  readonly poll_ceiling_ms: number;
  readonly retrieve_attempt_timeout_ms: number;
  readonly retrieve_ceiling_ms: number;
  readonly total_ms: number;
}

/**
 * Audited against `http-client.ts`: default safe GETs use MAX_RETRIES + 1 = 4
 * attempts, three intervening delays, INITIAL_RETRY_DELAY_MS exponential
 * jitter caps of 1s/2s/4s, and a 30s maxDelayMs cap for Retry-After. Because
 * Retry-After replaces jitter when present, its 90s aggregate is the ceiling.
 */
export const V1_SAFE_GET_RETRY_CEILING = Object.freeze({
  max_attempts: 4,
  retry_delay_count: 3,
  retry_after_cap_ms: 30_000,
  jitter_caps_ms: Object.freeze([1_000, 2_000, 4_000] as const),
  maximum_retry_delay_ms: 90_000,
});

function safeGetCeilingMs(attemptTimeoutMs: number): number {
  return (
    V1_SAFE_GET_RETRY_CEILING.max_attempts * attemptTimeoutMs +
    V1_SAFE_GET_RETRY_CEILING.maximum_retry_delay_ms
  );
}

const OPENAI_BACKGROUND_TRANSPORT = Object.freeze({
  submit_timeout_ms: 30_000,
  final_poll_sleep_ms: 5_000,
  poll_attempt_timeout_ms: 15_000,
  poll_ceiling_ms: safeGetCeilingMs(15_000),
  retrieve_attempt_timeout_ms: 30_000,
  retrieve_ceiling_ms: safeGetCeilingMs(30_000),
  total_ms: 395_000,
});

const GEMINI_BACKGROUND_TRANSPORT = Object.freeze({
  submit_timeout_ms: 30_000,
  final_poll_sleep_ms: 15_000,
  poll_attempt_timeout_ms: 15_000,
  poll_ceiling_ms: safeGetCeilingMs(15_000),
  retrieve_attempt_timeout_ms: 30_000,
  retrieve_ceiling_ms: safeGetCeilingMs(30_000),
  total_ms: 405_000,
});

const PERPLEXITY_BACKGROUND_TRANSPORT = Object.freeze({
  submit_timeout_ms: 30_000,
  final_poll_sleep_ms: 0,
  poll_attempt_timeout_ms: 15_000,
  poll_ceiling_ms: safeGetCeilingMs(15_000),
  retrieve_attempt_timeout_ms: 30_000,
  retrieve_ceiling_ms: safeGetCeilingMs(30_000),
  total_ms: 390_000,
});

/**
 * Audited v1 adapter transport ceilings outside the configured remote-work
 * allowance. `asyncPollInterval` is intentionally absent: it is cadence, not a
 * timeout, and therefore is not request-deadline budget.
 */
export const V1_BACKGROUND_TRANSPORT_OVERHEAD_BY_PROFILE: Readonly<
  Record<string, BackgroundTransportOverheadPolicy>
> = Object.freeze({
  'openai-research/research': OPENAI_BACKGROUND_TRANSPORT,
  'gemini-deep/research': GEMINI_BACKGROUND_TRANSPORT,
  'perplexity-deep-research/research': PERPLEXITY_BACKGROUND_TRANSPORT,
  'perplexity-sonar-deep/research': PERPLEXITY_BACKGROUND_TRANSPORT,
});

function sortDiagnostics<T extends PreparationIssue | PreparationNotice>(
  diagnostics: readonly T[],
): T[] {
  return [...diagnostics].sort(comparePreparationDiagnostics);
}

export function v1BackgroundTransportOverheadMs(
  profile: Pick<ExecutionProfile, 'identity' | 'invocation'>,
): number {
  if (profile.invocation !== 'background') return 0;
  return (
    V1_BACKGROUND_TRANSPORT_OVERHEAD_BY_PROFILE[
      `${profile.identity.provider_id}/${profile.identity.profile_id}`
    ]?.total_ms ?? 0
  );
}

function invalidIntegerIssue(path: string, label: string): PreparationIssue {
  return {
    code: 'request_deadline_invalid_integer',
    phase: 'migration',
    path,
    message: `${label} must be a safe integer of at least ${RESEARCH_REQUEST_LIMITS.minDeadlineMs} milliseconds.`,
  };
}

function validateContext(
  context: V1RequestDeadlineMigrationContext,
  issues: PreparationIssue[],
): void {
  if (context.kind !== 'v1_request_deadline_migration') {
    issues.push({
      code: 'request_deadline_invalid_migration_context',
      phase: 'migration',
      path: '/deadline_migration/kind',
      message:
        'Deadline derivation requires an explicit v1 request-deadline migration context.',
    });
  }
  if (!['sync', 'async', 'mixed'].includes(context.legacy_mode)) {
    issues.push({
      code: 'request_deadline_invalid_legacy_mode',
      phase: 'migration',
      path: '/deadline_migration/legacy_mode',
      message: 'Legacy mode must be exactly sync, async, or mixed.',
    });
  }
  if (
    !Number.isSafeInteger(context.max_parallel) ||
    context.max_parallel < RESEARCH_REQUEST_LIMITS.minConcurrency ||
    context.max_parallel > RESEARCH_REQUEST_LIMITS.maxConcurrency
  ) {
    issues.push({
      code: 'request_deadline_concurrency_out_of_bounds',
      phase: 'migration',
      path: '/deadline_migration/max_parallel',
      message: `Deadline derivation concurrency must be an integer from ${RESEARCH_REQUEST_LIMITS.minConcurrency} through ${RESEARCH_REQUEST_LIMITS.maxConcurrency}.`,
    });
  }

  for (const [field, label] of [
    ['inline_attempt_deadline_ms', 'Inline attempt deadline'],
    ['raw_background_attempt_deadline_ms', 'Raw background attempt deadline'],
  ] as const) {
    const value = context[field];
    if (
      !Number.isSafeInteger(value) ||
      value < RESEARCH_REQUEST_LIMITS.minDeadlineMs
    ) {
      issues.push(invalidIntegerIssue(`/deadline_migration/${field}`, label));
    }
  }

  if (
    !Number.isSafeInteger(context.poll_interval_ms) ||
    context.poll_interval_ms < RESEARCH_REQUEST_LIMITS.minPollIntervalMs ||
    context.poll_interval_ms > RESEARCH_REQUEST_LIMITS.maxPollIntervalMs
  ) {
    issues.push({
      code: 'request_deadline_poll_interval_out_of_bounds',
      phase: 'migration',
      path: '/deadline_migration/poll_interval_ms',
      message: `Poll interval must be a safe integer from ${RESEARCH_REQUEST_LIMITS.minPollIntervalMs} through ${RESEARCH_REQUEST_LIMITS.maxPollIntervalMs} milliseconds.`,
    });
  } else if (
    Number.isSafeInteger(context.raw_background_attempt_deadline_ms) &&
    context.poll_interval_ms > context.raw_background_attempt_deadline_ms
  ) {
    issues.push({
      code: 'request_deadline_poll_interval_exceeds_background_attempt',
      phase: 'migration',
      path: '/deadline_migration/poll_interval_ms',
      message: 'Poll interval cannot exceed the background attempt deadline.',
    });
  }

  const explicit = context.explicit_request_deadline_ms;
  if (
    explicit !== undefined &&
    (!Number.isSafeInteger(explicit) ||
      explicit < RESEARCH_REQUEST_LIMITS.minDeadlineMs)
  ) {
    issues.push(
      invalidIntegerIssue(
        '/deadline_migration/explicit_request_deadline_ms',
        'Explicit request deadline',
      ),
    );
  }
}

function allowanceMs(
  profile: ExecutionProfile,
  context: V1RequestDeadlineMigrationContext,
  effectiveBackgroundAttemptDeadlineMs: bigint,
): bigint {
  return profile.invocation === 'inline'
    ? BigInt(context.inline_attempt_deadline_ms)
    : effectiveBackgroundAttemptDeadlineMs;
}

function overflowIssue(path: string): PreparationIssue {
  return {
    code: 'request_deadline_arithmetic_overflow',
    phase: 'migration',
    path,
    message:
      'The exact derived deadline value cannot be represented as a safe integer.',
  };
}

function contractMaximumIssue(path: string): PreparationIssue {
  return {
    code: 'request_deadline_contract_maximum_exceeded',
    phase: 'migration',
    path,
    message: `The deadline exceeds the ${RESEARCH_REQUEST_LIMITS.maxDeadlineMs}ms contract maximum.`,
  };
}

/**
 * Derive the bounded v2 request deadline from a fully selected v1 plan.
 *
 * Primaries use deterministic list scheduling in their supplied selection
 * order. Every ordered unique reserve is then added sequentially because any
 * one request slot may consume the complete reserve chain. Arithmetic remains
 * exact in BigInt until the 7-day contract boundary has been checked.
 */
export function deriveV1RequestDeadline(
  context: V1RequestDeadlineMigrationContext,
  admission: ResearchExecutionAdmission,
): V1RequestDeadlineDerivationResult {
  if (!isMintedResearchExecutionAdmission(admission)) {
    return {
      ok: false,
      issues: [
        {
          code: 'research_admission_invalid',
          phase: 'validation',
          path: '/admission',
          message:
            'Deadline derivation requires an admission minted by the execution planner.',
        },
      ],
      notices: [],
    };
  }
  const issues: PreparationIssue[] = [];
  const notices: PreparationNotice[] =
    context.legacy_mode === 'async' || context.legacy_mode === 'mixed'
      ? [
          {
            code: 'legacy_wait_is_bounded_in_v2',
            phase: 'migration',
            path: '/deadline_migration/legacy_mode',
            message:
              'Legacy async and mixed status --wait behavior is migrated to a bounded v2 request deadline.',
          },
        ]
      : [];

  validateContext(context, issues);
  if (issues.length > 0) {
    return {
      ok: false,
      issues: sortDiagnostics(issues),
      notices: sortDiagnostics(notices),
    };
  }

  const selected = [...admission.primaries, ...admission.reserve];
  const maximumBackgroundOverheadMs = selected.reduce(
    (maximum, selection) =>
      selection.entry.profile.invocation === 'background'
        ? Math.max(
            maximum,
            v1BackgroundTransportOverheadMs(selection.entry.profile),
          )
        : maximum,
    0,
  );
  const effectiveBackgroundExact =
    BigInt(context.raw_background_attempt_deadline_ms) +
    BigInt(maximumBackgroundOverheadMs);
  const effectivePath =
    '/deadline_migration/effective_background_attempt_deadline_ms';
  if (effectiveBackgroundExact > BigInt(Number.MAX_SAFE_INTEGER)) {
    return {
      ok: false,
      issues: [overflowIssue(effectivePath)],
      notices: sortDiagnostics(notices),
    };
  }
  if (
    effectiveBackgroundExact > BigInt(RESEARCH_REQUEST_LIMITS.maxDeadlineMs)
  ) {
    return {
      ok: false,
      issues: [contractMaximumIssue(effectivePath)],
      notices: sortDiagnostics(notices),
    };
  }

  const workers = Array.from({ length: context.max_parallel }, () => 0n);
  for (const { entry } of admission.primaries) {
    let workerIndex = 0;
    for (let index = 1; index < workers.length; index += 1) {
      if (workers[index] < workers[workerIndex]) workerIndex = index;
    }
    workers[workerIndex] += allowanceMs(
      entry.profile,
      context,
      effectiveBackgroundExact,
    );
  }
  let fullPlanExact = workers.reduce(
    (maximum, value) => (value > maximum ? value : maximum),
    0n,
  );

  const seenReserve = new Set<string>();
  for (const { entry } of admission.reserve) {
    const key = providerIdentityKey(entry.profile.identity);
    if (seenReserve.has(key)) continue;
    seenReserve.add(key);
    fullPlanExact += allowanceMs(
      entry.profile,
      context,
      effectiveBackgroundExact,
    );
  }

  const requestPath = '/deadline_migration/request_deadline_ms';
  if (fullPlanExact > BigInt(Number.MAX_SAFE_INTEGER)) {
    return {
      ok: false,
      issues: [overflowIssue(requestPath)],
      notices: sortDiagnostics(notices),
    };
  }
  const fullPlanMinimum = Number(fullPlanExact);
  const effectiveBackgroundAttemptDeadlineMs = Number(effectiveBackgroundExact);
  const explicit = context.explicit_request_deadline_ms;
  if (explicit !== undefined) {
    if (explicit > RESEARCH_REQUEST_LIMITS.maxDeadlineMs) {
      return {
        ok: false,
        issues: [
          contractMaximumIssue(
            '/deadline_migration/explicit_request_deadline_ms',
          ),
        ],
        notices: sortDiagnostics(notices),
      };
    }
    const attemptCap = Math.max(
      context.inline_attempt_deadline_ms,
      effectiveBackgroundAttemptDeadlineMs,
    );
    if (explicit < attemptCap) {
      return {
        ok: false,
        issues: [
          {
            code: 'request_deadline_less_than_attempt_deadline',
            phase: 'migration',
            path: '/deadline_migration/explicit_request_deadline_ms',
            message:
              'The explicit request deadline cannot be shorter than the effective attempt deadline cap.',
          },
        ],
        notices: sortDiagnostics(notices),
      };
    }
    if (fullPlanExact > BigInt(explicit)) {
      notices.push({
        code: 'explicit_request_deadline_may_truncate_plan',
        phase: 'migration',
        path: '/deadline_migration/explicit_request_deadline_ms',
        message:
          'The explicit request deadline is shorter than the derived full-plan minimum; later primaries or reserves may be truncated.',
      });
    }
    return {
      ok: true,
      request_deadline_ms: explicit,
      effective_background_attempt_deadline_ms:
        effectiveBackgroundAttemptDeadlineMs,
      derived_full_plan_minimum_ms: fullPlanMinimum,
      source: 'explicit_override',
      notices: sortDiagnostics(notices),
    };
  }

  const derivedRequestExact = [
    fullPlanExact,
    BigInt(context.inline_attempt_deadline_ms),
    effectiveBackgroundExact,
  ].reduce((maximum, value) => (value > maximum ? value : maximum));
  if (derivedRequestExact > BigInt(RESEARCH_REQUEST_LIMITS.maxDeadlineMs)) {
    return {
      ok: false,
      issues: [contractMaximumIssue(requestPath)],
      notices: sortDiagnostics(notices),
    };
  }
  return {
    ok: true,
    request_deadline_ms: Number(derivedRequestExact),
    effective_background_attempt_deadline_ms:
      effectiveBackgroundAttemptDeadlineMs,
    derived_full_plan_minimum_ms: fullPlanMinimum,
    source: 'derived_v1_plan',
    notices: sortDiagnostics(notices),
  };
}
