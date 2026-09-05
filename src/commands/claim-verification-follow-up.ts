import { getProvider } from '../adapters/index.js';
import type {
  createBudgetTracker,
  createEstimateBudgetTracker,
} from '../core/budget.js';
import { hasCredential } from '../core/credentials.js';
import { buildProviderMetering } from '../core/metering.js';
import { normalizeUsage } from '../core/usage-normalization.js';
import { createNodeCredentialContext } from '../node-credentials.js';
import {
  costMicrousdFromUsd,
  fingerprint,
  PaidRunAdmissionError,
  type RunPaidWallet,
} from '../run-paid-wallet.js';
import type {
  ClaimSupport,
  Config,
  ProviderDispatchResult,
  VerificationAttempt,
  VerificationFollowUp,
} from '../types.js';

export const MAX_VERIFICATION_ATTEMPTS = 3;

export function eligibleProviderIds(
  results: ProviderDispatchResult[],
  config: Config,
): string[] {
  const ids: string[] = [];
  const add = (id: string): void => {
    if (ids.includes(id)) return;
    const provider = getProvider(id);
    const providerConfig = config.providers[id];
    if (
      !provider ||
      (provider.tier !== 'ai-grounded' && provider.tier !== 'raw-search') ||
      !providerConfig ||
      !hasCredential(providerConfig.apiKey, createNodeCredentialContext())
    )
      return;
    ids.push(id);
  };
  for (const result of results)
    if (result.status === 'success') add(result.provider);
  return ids;
}

/** Configured fallback chain first, then eligible original-run alternates. */
export function followupAttemptOrder(
  eligibleIds: string[],
  config: Config,
): string[] {
  const order: string[] = [];
  const add = (id: string): void => {
    if (order.includes(id) || order.length >= MAX_VERIFICATION_ATTEMPTS) return;
    const provider = getProvider(id);
    const providerConfig = config.providers[id];
    if (
      provider &&
      providerConfig &&
      (provider.tier === 'ai-grounded' || provider.tier === 'raw-search') &&
      hasCredential(providerConfig.apiKey, createNodeCredentialContext())
    )
      order.push(id);
  };
  for (const id of eligibleIds) {
    add(id);
    const seen = new Set<string>([id]);
    let fallback = config.providers[id]?.fallback;
    while (
      fallback &&
      !seen.has(fallback) &&
      order.length < MAX_VERIFICATION_ATTEMPTS
    ) {
      seen.add(fallback);
      add(fallback);
      fallback = config.providers[fallback]?.fallback;
    }
  }
  return order;
}

export async function runFollowup(
  claim: ClaimSupport,
  attemptIds: string[],
  config: Config,
  reportedBudget: ReturnType<typeof createBudgetTracker>,
  estimatedBudget: ReturnType<typeof createEstimateBudgetTracker>,
  wallet?: RunPaidWallet,
): Promise<{
  followUp: VerificationFollowUp;
  evidence?: { provider: string; text: string; sourceUrls: string[] };
}> {
  const attempts: VerificationAttempt[] = [];
  const query = `${claim.claim} primary source evidence`;
  for (const id of attemptIds.slice(0, MAX_VERIFICATION_ATTEMPTS)) {
    if (wallet && !wallet.isAuthorized('verification', { provider: id })) {
      continue;
    }
    const provider = getProvider(id);
    if (!provider) continue;
    const metering = buildProviderMetering(id, config.providers[id]);
    const nextEstimate = metering.estimate?.estimatedCostUsd;
    const estimateExceeded =
      estimatedBudget.limitUsd !== undefined &&
      typeof nextEstimate === 'number' &&
      Number.isFinite(nextEstimate) &&
      nextEstimate > 0 &&
      estimatedBudget.reservedUsd + nextEstimate > estimatedBudget.limitUsd;
    if (
      reportedBudget.exceeded() ||
      estimatedBudget.exceeded() ||
      estimateExceeded
    ) {
      attempts.push({
        provider: id,
        tier: provider.tier as VerificationAttempt['tier'],
        status: 'skipped',
        durationMs: 0,
        error: reportedBudget.exceeded()
          ? 'skipped: cost budget reached'
          : 'skipped: estimated cost budget reached',
      });
      break;
    }
    if (!wallet) estimatedBudget.reserve(metering.estimate);
    let paidAttemptId: string | undefined;
    try {
      paidAttemptId = wallet?.begin({
        stage: 'verification',
        provider: id,
        estimated_cost_microusd: costMicrousdFromUsd(
          metering.estimate?.estimatedCostUsd,
        ),
        ...(metering.estimate?.pricingVersion && {
          estimate_source: `pricing:${metering.estimate.pricingVersion}`,
        }),
        input_fingerprint: fingerprint(query),
        input_ref: 'verification.json#/matrix',
      });
    } catch (error) {
      if (!(error instanceof PaidRunAdmissionError)) throw error;
      attempts.push({
        provider: id,
        tier: provider.tier as VerificationAttempt['tier'],
        status: 'skipped',
        durationMs: 0,
        error: `skipped: ${error.reasonCode}`,
      });
      break;
    }
    const started = Date.now();
    try {
      const result = await provider.execute(query, {
        timeout: wallet
          ? Math.max(
              1,
              Math.ceil(
                Math.min(config.defaults.timeout * 1000, wallet.remainingMs()) /
                  1000,
              ),
            )
          : config.defaults.timeout,
        ...(wallet && { signal: wallet.signal }),
      });
      const usage = normalizeUsage(result);
      const sourceUrls = Array.from(
        new Set(
          result.citations.map((citation) => citation.url).filter(Boolean),
        ),
      );
      const success = !result.error && result.content.trim().length > 0;
      attempts.push({
        provider: id,
        tier: provider.tier as VerificationAttempt['tier'],
        status: success ? 'success' : 'error',
        durationMs: result.durationMs || Date.now() - started,
        ...(result.error ? { error: result.error } : {}),
        ...(sourceUrls.length > 0 ? { sourceUrls } : {}),
        ...(usage ? { usage } : {}),
        metering: buildProviderMetering(id, config.providers[id], usage),
      });
      reportedBudget.record(usage);
      if (paidAttemptId) {
        wallet?.finish(paidAttemptId, {
          status: success ? 'succeeded' : 'failed',
          ...(usage && { usage }),
          output_fingerprint: fingerprint({
            content: result.content,
            citations: result.citations,
          }),
          output_ref: 'verification.json',
        });
      }
      if (success)
        return {
          followUp: { claimId: claim.id, query, attempts, sourceUrls },
          evidence: { provider: id, text: result.content, sourceUrls },
        };
    } catch (error) {
      if (paidAttemptId) wallet?.finish(paidAttemptId, { status: 'failed' });
      attempts.push({
        provider: id,
        tier: provider.tier as VerificationAttempt['tier'],
        status: 'error',
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
        metering,
      });
    }
  }
  return { followUp: { claimId: claim.id, query, attempts, sourceUrls: [] } };
}
