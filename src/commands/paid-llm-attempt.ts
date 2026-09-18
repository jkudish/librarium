import { buildProviderMetering } from '../core/metering.js';
import {
  costMicrousdFromUsd,
  fingerprint,
  type PaidRunStage,
  type PaidStageProvider,
  type RunPaidWallet,
} from '../run-paid-wallet.js';
import type { Config, ProviderUsage } from '../types.js';
import type { LlmCascadeAttempt, LlmClient } from './llm-client.js';

export function llmAdapterId(provider: LlmClient['provider']): string {
  return provider === 'openai'
    ? 'openai-chat'
    : provider === 'gemini'
      ? 'gemini-chat'
      : 'perplexity-sonar-pro';
}

export function paidLlmProvider(
  client: LlmClient,
  config: Config,
): PaidStageProvider {
  const adapterId = llmAdapterId(client.provider);
  const estimate = buildProviderMetering(
    adapterId,
    config.providers[adapterId],
  ).estimate;
  const configuredCost = config.providers[adapterId]?.options?.perRequestUsd;
  const hasConfiguredCost =
    typeof configuredCost === 'number' &&
    Number.isFinite(configuredCost) &&
    configuredCost > 0;
  const cost = costMicrousdFromUsd(
    hasConfiguredCost ? configuredCost : estimate?.estimatedCostUsd,
  );
  return {
    provider: client.provider,
    model: client.model,
    ...(cost !== undefined && { estimated_cost_microusd: cost }),
    ...(cost !== undefined && {
      estimate_source: hasConfiguredCost
        ? 'configured:perRequestUsd'
        : `pricing:${estimate?.pricingVersion ?? 'unknown'}`,
    }),
  };
}

export function paidLlmAttemptHooks(input: {
  readonly wallet: RunPaidWallet;
  readonly stage: Exclude<PaidRunStage, 'research'>;
  readonly prompt: string;
  readonly config: Config;
  readonly input_ref?: string;
  readonly output_ref?: string;
}): {
  readonly signal: AbortSignal;
  readonly beforeAttempt: (client: LlmClient) => void;
  readonly onAttempt: (attempt: LlmCascadeAttempt) => void;
  readonly completeSuccess: (output: unknown, usage?: ProviderUsage) => void;
  readonly completeFailure: (usage?: ProviderUsage) => void;
} {
  let activeAttemptId: string | undefined;
  return {
    signal: input.wallet.signal,
    beforeAttempt(client) {
      const provider = paidLlmProvider(client, input.config);
      activeAttemptId = input.wallet.begin({
        stage: input.stage,
        ...provider,
        input_fingerprint: fingerprint(input.prompt),
        ...(input.input_ref && { input_ref: input.input_ref }),
      });
    },
    onAttempt(attempt) {
      if (!activeAttemptId) return;
      if (attempt.status === 'error') {
        input.wallet.finish(activeAttemptId, {
          status: 'failed',
          ...(attempt.usage && { usage: attempt.usage }),
        });
        activeAttemptId = undefined;
      }
    },
    completeSuccess(output, usage) {
      if (!activeAttemptId) return;
      input.wallet.finish(activeAttemptId, {
        status: 'succeeded',
        ...(usage && { usage }),
        output_fingerprint: fingerprint(output),
        ...(input.output_ref && { output_ref: input.output_ref }),
      });
      activeAttemptId = undefined;
    },
    completeFailure(usage) {
      if (!activeAttemptId) return;
      input.wallet.finish(activeAttemptId, {
        status: 'failed',
        ...(usage && { usage }),
      });
      activeAttemptId = undefined;
    },
  };
}
