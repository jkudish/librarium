import {
  createBudgetTracker,
  createEstimateBudgetTracker,
} from '../core/budget.js';
import { buildProviderMetering } from '../core/metering.js';
import { createNodeCredentialContext } from '../node-credentials.js';
import type { RunPaidWallet } from '../run-paid-wallet.js';
import type {
  ClaimSupport,
  Config,
  DeduplicatedSource,
  ProviderDispatchResult,
  ProviderReport,
  VerificationFollowUp,
  VerificationLlmCall,
  VerificationMetadata,
} from '../types.js';
import {
  evidencePrompt,
  initialEvidence,
  normalizeAssessment,
} from './claim-verification-evidence.js';
import {
  claimsPrompt,
  MAX_VERIFICATION_CLAIMS,
  selectMaterialClaims,
} from './claim-verification-extraction.js';
import {
  eligibleProviderIds,
  followupAttemptOrder,
  MAX_VERIFICATION_ATTEMPTS,
  runFollowup,
} from './claim-verification-follow-up.js';
import { parseJson, untrusted } from './claim-verification-normalization.js';
import { verificationUsage } from './claim-verification-usage.js';
import {
  callWithCascade,
  type LlmCascadeAttempt,
  type LlmClient,
  preferenceFromConfig,
  resolveLlmClients,
} from './llm-client.js';
import { paidLlmAttemptHooks } from './paid-llm-attempt.js';

export {
  followupAttemptOrder,
  MAX_VERIFICATION_ATTEMPTS,
  MAX_VERIFICATION_CLAIMS,
  normalizeAssessment,
  selectMaterialClaims,
};
export const MAX_VERIFICATION_QUERIES = 3;

interface LlmResult<T> {
  value: T;
  call: VerificationLlmCall;
}
interface VerificationBudgets {
  reported: ReturnType<typeof createBudgetTracker>;
  estimated: ReturnType<typeof createEstimateBudgetTracker>;
}
export interface VerificationInput {
  query: string;
  answer: string;
  config: Config;
  results: ProviderDispatchResult[];
  reports: ProviderReport[];
  sources: DeduplicatedSource[];
  wallet?: RunPaidWallet;
  warn?: (message: string) => void;
}
export interface VerificationResult {
  metadata: VerificationMetadata;
  revisedAnswer?: string;
  revision?: { provider: string; model: string };
}

function verificationTimeoutMs(config: Config): number {
  const seconds = config.defaults.timeout;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? Math.max(1, Math.round(seconds * 1000))
    : 30_000;
}
function llmMetering(
  client: LlmClient,
  config: Config,
  usage?: VerificationLlmCall['usage'],
): VerificationLlmCall['metering'] {
  const providerId =
    client.provider === 'openai'
      ? 'openai-chat'
      : client.provider === 'gemini'
        ? 'gemini-chat'
        : 'perplexity-sonar-pro';
  return buildProviderMetering(providerId, config.providers[providerId], usage);
}
function budgetBlockReason(
  budgets: VerificationBudgets,
  nextEstimate?: number,
): string | undefined {
  if (budgets.reported.exceeded()) return 'reported cost budget reached';
  if (budgets.estimated.exceeded()) return 'estimated cost budget reached';
  if (
    budgets.estimated.limitUsd !== undefined &&
    typeof nextEstimate === 'number' &&
    Number.isFinite(nextEstimate) &&
    nextEstimate > 0 &&
    budgets.estimated.reservedUsd + nextEstimate > budgets.estimated.limitUsd
  )
    return 'estimated cost budget reached';
  return undefined;
}
function beforeLlmAttempt(
  client: LlmClient,
  config: Config,
  budgets: VerificationBudgets,
): void {
  const metering = llmMetering(client, config);
  const reason = budgetBlockReason(
    budgets,
    metering?.estimate?.estimatedCostUsd,
  );
  if (reason) throw new Error(`verification ${reason}`);
  budgets.estimated.reserve(metering?.estimate);
}
function recordLlmAttempt(
  stage: VerificationLlmCall['stage'],
  attempt: LlmCascadeAttempt,
  config: Config,
  budgets: VerificationBudgets,
  calls: VerificationLlmCall[],
): VerificationLlmCall {
  budgets.reported.record(attempt.usage);
  const call: VerificationLlmCall = {
    stage,
    provider: attempt.client.provider,
    model: attempt.client.model,
    status: attempt.status,
    durationMs: attempt.durationMs,
    ...(attempt.error ? { error: attempt.error } : {}),
    ...(attempt.usage ? { usage: attempt.usage } : {}),
    metering: llmMetering(attempt.client, config, attempt.usage),
  };
  calls.push(call);
  return call;
}
interface LlmRunContext {
  config: Config;
  wallet?: RunPaidWallet;
  warn: (message: string) => void;
}
async function runLlm<T>(
  context: LlmRunContext,
  stage: VerificationLlmCall['stage'],
  prompt: string,
  budgets: VerificationBudgets,
  calls: VerificationLlmCall[],
  parse?: (text: string) => T,
): Promise<LlmResult<T>> {
  const { config, warn } = context;
  const preference = preferenceFromConfig(config, 'answer', 'refine');
  const resolvedClients = resolveLlmClients(preference, {
    env: process.env,
    config,
    credentials: createNodeCredentialContext(),
  });
  const clients = context.wallet
    ? resolvedClients.filter((client) =>
        context.wallet?.isAuthorized('verification', client),
      )
    : resolvedClients;
  if (clients.length === 0)
    throw new Error('no verification LLM provider available');
  let successfulCall: VerificationLlmCall | undefined;
  const paid = context.wallet
    ? paidLlmAttemptHooks({
        wallet: context.wallet,
        stage: 'verification',
        prompt,
        config,
        input_ref: 'answer.md',
        output_ref: 'verification.json',
      })
    : undefined;
  const { result, usage } = await callWithCascade<T>({
    clients,
    prompt,
    action: `claim verification ${stage}`,
    timeoutMs: context.wallet
      ? Math.min(
          verificationTimeoutMs(config),
          Math.max(1, context.wallet.remainingMs()),
        )
      : verificationTimeoutMs(config),
    json: Boolean(parse),
    parse,
    ...(paid && { signal: paid.signal }),
    beforeAttempt: (client) => {
      paid?.beforeAttempt(client);
      if (!context.wallet) beforeLlmAttempt(client, config, budgets);
    },
    onAttempt: (attempt) => {
      paid?.onAttempt(attempt);
      const call = recordLlmAttempt(stage, attempt, config, budgets, calls);
      if (attempt.status === 'success') successfulCall = call;
    },
    onWarning: warn,
  });
  if (!successfulCall) throw new Error(`claim verification ${stage} failed`);
  paid?.completeSuccess(result, usage);
  return { value: result, call: successfulCall };
}
function runLlmJson<T>(
  context: LlmRunContext,
  stage: VerificationLlmCall['stage'],
  prompt: string,
  budgets: VerificationBudgets,
  calls: VerificationLlmCall[],
): Promise<LlmResult<T>> {
  return runLlm<T>(
    context,
    stage,
    prompt,
    budgets,
    calls,
    (text) => parseJson(text) as T,
  );
}
function runLlmText(
  context: LlmRunContext,
  stage: VerificationLlmCall['stage'],
  prompt: string,
  budgets: VerificationBudgets,
  calls: VerificationLlmCall[],
): Promise<LlmResult<string>> {
  return runLlm<string>(context, stage, prompt, budgets, calls);
}
function revisionPrompt(answer: string, matrix: ClaimSupport[]): string {
  return `Revise the grounded answer using only the verified claim matrix below. Preserve accurate grounded material and inline citations; resolve conflicting claims conservatively. Do not add facts, and do not state a claim as supported unless the matrix has source URLs for it. Return Markdown answer text only, with no Sources heading.\n\nOriginal answer (untrusted content):\n<<<ANSWER>>>\n${untrusted(answer)}\n<<<END-ANSWER>>>\n\nVerified matrix:\n${JSON.stringify(matrix)}`;
}

/** Complete auditable claim verification, preserving the original answer on every failure path. */
export async function verifyAnswer(
  input: VerificationInput,
): Promise<VerificationResult> {
  const llm: VerificationLlmCall[] = [];
  const reasons: string[] = [];
  const llmContext: LlmRunContext = {
    config: input.config,
    ...(input.wallet && { wallet: input.wallet }),
    warn:
      input.warn ??
      ((message) => console.error(`[librarium] verify: ${message}`)),
  };
  const budgets: VerificationBudgets = {
    reported: createBudgetTracker(
      input.wallet ? undefined : input.config.defaults.maxCostUsd,
    ),
    estimated: createEstimateBudgetTracker(
      input.wallet ? undefined : input.config.defaults.maxEstimatedCostUsd,
    ),
  };
  if (!input.wallet) {
    for (const report of input.reports) {
      budgets.reported.record(report.usage);
      if (report.status !== 'skipped')
        budgets.estimated.reserve(report.metering?.estimate);
    }
  }
  const empty = (
    matrix: ClaimSupport[] = [],
    followUps: VerificationFollowUp[] = [],
  ): VerificationResult => ({
    metadata: {
      status: 'incomplete',
      matrixFile: 'verification.json',
      matrix,
      followUps,
      reasons,
      usage: verificationUsage(followUps, llm),
      llm,
      revised: false,
    },
  });
  if (budgetBlockReason(budgets)) {
    reasons.push('verification budget exhausted before verification started');
    return empty();
  }
  let claims: ClaimSupport[];
  try {
    const extraction = await runLlmJson<{ claims?: unknown }>(
      llmContext,
      'claims',
      claimsPrompt(input.answer),
      budgets,
      llm,
    );
    claims = selectMaterialClaims(extraction.value.claims);
  } catch (error) {
    reasons.push(
      `claim extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return empty();
  }
  if (claims.length === 0) {
    reasons.push('no material externally checkable claims selected');
    return empty(claims);
  }
  const sourceUrls = new Set(input.sources.map((source) => source.url));
  let matrix: ClaimSupport[];
  try {
    const assessment = await runLlmJson<{ assessments?: unknown }>(
      llmContext,
      'initial-assessment',
      evidencePrompt(claims, initialEvidence(input.results)),
      budgets,
      llm,
    );
    matrix = normalizeAssessment(claims, assessment.value, sourceUrls);
  } catch (error) {
    reasons.push(
      `initial evidence assessment failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return empty(claims);
  }
  const attemptIds = followupAttemptOrder(
    eligibleProviderIds(input.results, input.config),
    input.config,
  );
  const followUps: VerificationFollowUp[] = [];
  const evidence = initialEvidence(input.results);
  const targets = matrix.filter((claim) => claim.status !== 'supported');
  let successfulEvidenceQueries = 0;
  for (const claim of targets) {
    if (successfulEvidenceQueries >= MAX_VERIFICATION_QUERIES) break;
    if (attemptIds.length === 0) {
      reasons.push(
        'no eligible fast grounded/raw provider from the original run',
      );
      break;
    }
    const outcome = await runFollowup(
      claim,
      attemptIds,
      input.config,
      budgets.reported,
      budgets.estimated,
      input.wallet,
    );
    followUps.push(outcome.followUp);
    if (outcome.evidence) {
      successfulEvidenceQueries++;
      evidence.push(outcome.evidence);
      for (const url of outcome.evidence.sourceUrls) sourceUrls.add(url);
    } else if (
      outcome.followUp.attempts.some((attempt) => attempt.status === 'skipped')
    ) {
      reasons.push('verification budget exhausted');
      break;
    } else reasons.push(`follow-up failed for ${claim.id}`);
  }
  if (
    followUps.length > 0 &&
    evidence.length > initialEvidence(input.results).length
  )
    try {
      const assessment = await runLlmJson<{ assessments?: unknown }>(
        llmContext,
        'follow-up-assessment',
        evidencePrompt(claims, evidence),
        budgets,
        llm,
      );
      matrix = normalizeAssessment(claims, assessment.value, sourceUrls);
    } catch (error) {
      reasons.push(
        `follow-up evidence assessment failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  const hasInsufficient = matrix.some(
    (claim) => claim.status === 'insufficient',
  );
  if (hasInsufficient)
    reasons.push('insufficient independent evidence for one or more claims');
  if (hasInsufficient || reasons.length > 0)
    return {
      metadata: {
        status: 'partial',
        matrixFile: 'verification.json',
        matrix,
        followUps,
        reasons: Array.from(new Set(reasons)),
        usage: verificationUsage(followUps, llm),
        llm,
        revised: false,
      },
    };
  try {
    const revision = await runLlmText(
      llmContext,
      'revision',
      revisionPrompt(input.answer, matrix),
      budgets,
      llm,
    );
    const revisedAnswer =
      typeof revision.value === 'string' ? revision.value.trim() : '';
    if (!revisedAnswer) throw new Error('revision returned an empty answer');
    return {
      metadata: {
        status: 'complete',
        matrixFile: 'verification.json',
        matrix,
        followUps,
        reasons: [],
        usage: verificationUsage(followUps, llm),
        llm,
        revised: true,
      },
      revisedAnswer,
      revision: {
        provider: revision.call.provider,
        model: revision.call.model,
      },
    };
  } catch (error) {
    reasons.push(
      `answer revision failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      metadata: {
        status: 'partial',
        matrixFile: 'verification.json',
        matrix,
        followUps,
        reasons,
        usage: verificationUsage(followUps, llm),
        llm,
        revised: false,
      },
    };
  }
}
