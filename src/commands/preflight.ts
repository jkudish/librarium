import type { ProviderTier } from '../types.js';

/**
 * Pure gating logic for the deep-research pre-flight confirm. No I/O here so
 * the TTY / count / --yes / wizard matrix stays trivially testable; the actual
 * clack prompt lives in run.ts and only fires when this returns true.
 */

/** A run with this many deep-research providers triggers the pre-flight confirm. */
export const DEEP_RESEARCH_CONFIRM_THRESHOLD = 3;

export interface PreflightInput {
  /** Number of deep-research-tier providers the run would dispatch. */
  deepResearchCount: number;
  /** True only in an interactive terminal (both stdin and stdout are TTYs). */
  isTTY: boolean;
  /** True when --yes was passed (skip the prompt). */
  yes: boolean;
  /**
   * True when invoked through the wizard, whose own confirm step already
   * counts as consent. Avoids double-prompting.
   */
  fromWizard: boolean;
}

/**
 * Decide whether to show the deep-research pre-flight confirm. Only in a TTY,
 * only when the deep-research count reaches the threshold, and never when the
 * user already consented (--yes or the wizard's confirm). Non-TTY runs never
 * prompt and are never refused, so pipes and CI never hang.
 */
export function shouldConfirmDeepResearch(input: PreflightInput): boolean {
  if (input.yes || input.fromWizard) return false;
  if (!input.isTTY) return false;
  return input.deepResearchCount >= DEEP_RESEARCH_CONFIRM_THRESHOLD;
}

/** Count providers whose tier is deep-research. */
export function countDeepResearch(
  providerIds: string[],
  tierById: Map<string, ProviderTier>,
): number {
  let count = 0;
  for (const id of providerIds) {
    if (tierById.get(id) === 'deep-research') count += 1;
  }
  return count;
}

/**
 * Build the plain warning shown in the confirm. Lists the deep-research
 * providers and states, without hype, that deep research takes minutes and
 * bills per call. No em-dashes (user-facing string).
 */
export function deepResearchWarning(deepResearchIds: string[]): string {
  const list = deepResearchIds.join(', ');
  return `This run dispatches ${deepResearchIds.length} deep-research providers (${list}). Deep research can take several minutes and bills per call.`;
}
