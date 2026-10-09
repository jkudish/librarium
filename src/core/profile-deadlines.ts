import type { ExecutionProfile } from '../contracts/domain/index.js';

/**
 * Default inline attempt deadlines for profiles whose observed latency exceeds
 * the global inline default. They apply only when the caller did not author an
 * inline timeout; an explicit CLI flag or config value always wins.
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

/** The per-profile default inline deadline, or undefined to use the global one. */
export function profileDefaultInlineAttemptDeadlineMs(
  profile: ExecutionProfile,
): number | undefined {
  if (profile.invocation !== 'inline') return undefined;
  const key = `${profile.identity.provider_id}/${profile.identity.profile_id}`;
  return Object.hasOwn(PROFILE_DEFAULT_INLINE_ATTEMPT_DEADLINES_MS, key)
    ? PROFILE_DEFAULT_INLINE_ATTEMPT_DEADLINES_MS[key]
    : undefined;
}
