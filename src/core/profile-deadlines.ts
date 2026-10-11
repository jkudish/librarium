import type { ExecutionProfile } from '../contracts/domain/index.js';

/**
 * Default attempt deadlines for profiles whose documented or observed latency
 * differs from the global default. They apply only when the caller did not
 * author the matching deadline; an explicit CLI flag or config value always
 * wins.
 *
 * xAI: grok-4.6 defaults to high reasoning effort and runs a multi-turn
 * server-side search loop before its non-streaming response. A live recheck on
 * 2026-10-09 (#4767) took 44.7 s for a one-line factual query, and every 30 s
 * attempt timed out for web, X-only, and combined search.
 */
const XAI_INLINE_ATTEMPT_DEADLINE_MS = 120_000;

const PROFILE_DEFAULT_INLINE_ATTEMPT_DEADLINES_MS: Readonly<
  Record<string, number>
> = Object.freeze({
  'grok/web': XAI_INLINE_ATTEMPT_DEADLINE_MS,
  'grok-x-only/x': XAI_INLINE_ATTEMPT_DEADLINE_MS,
  'grok-combined/combined': XAI_INLINE_ATTEMPT_DEADLINE_MS,
});

const MINUTE_MS = 60_000;

/**
 * Background deadlines keyed by `provider/profile/target`, where the target is
 * the resolved Parallel processor or Valyu mode. Targets absent here use the
 * global background deadline (30 minutes by default).
 *
 * Parallel (https://docs.parallel.ai/task-api/guides/choose-a-processor,
 * accessed 2026-10-11) documents running-phase latency of up to 25 min for
 * ultra, 50 min for ultra2x, 90 min for ultra4x and 2 h for ultra8x; queue
 * time is extra. Each gets 1.5x its upper bound, rounded up to 15 minutes.
 * lite through pro finish within 10 min and keep the global default.
 *
 * Valyu (https://docs.valyu.ai/guides/deepresearch, accessed 2026-10-11)
 * recommends client timeouts of 10, 30, 120 and 180 minutes for fast,
 * standard, heavy and max; heavy runs take up to ~90 min and max up to
 * ~180 min.
 */
const PROFILE_DEFAULT_BACKGROUND_ATTEMPT_DEADLINES_MS: Readonly<
  Record<string, number>
> = Object.freeze({
  'parallel/research/ultra': 45 * MINUTE_MS,
  'parallel/research/ultra2x': 75 * MINUTE_MS,
  'parallel/research/ultra4x': 135 * MINUTE_MS,
  'parallel/research/ultra8x': 180 * MINUTE_MS,
  'valyu/research/fast': 10 * MINUTE_MS,
  'valyu/research/standard': 30 * MINUTE_MS,
  'valyu/research/heavy': 120 * MINUTE_MS,
  'valyu/research/max': 180 * MINUTE_MS,
});

function lookup(
  table: Readonly<Record<string, number>>,
  key: string,
): number | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The per-profile default inline deadline, or undefined to use the global one. */
export function profileDefaultInlineAttemptDeadlineMs(
  profile: ExecutionProfile,
): number | undefined {
  if (profile.invocation !== 'inline') return undefined;
  const { provider_id, profile_id } = profile.identity;
  return lookup(
    PROFILE_DEFAULT_INLINE_ATTEMPT_DEADLINES_MS,
    `${provider_id}/${profile_id}`,
  );
}

/**
 * The per-target default background deadline, or undefined to use the global
 * one. The target is the processor or mode the adapter will send.
 */
export function profileDefaultBackgroundAttemptDeadlineMs(
  profile: ExecutionProfile,
): number | undefined {
  if (profile.invocation !== 'background') return undefined;
  const { provider_id, profile_id, target } = profile.identity;
  return lookup(
    PROFILE_DEFAULT_BACKGROUND_ATTEMPT_DEADLINES_MS,
    `${provider_id}/${profile_id}/${target.primary.target_id ?? ''}`,
  );
}
