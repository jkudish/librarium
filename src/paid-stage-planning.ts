import {
  preferenceFromConfig,
  resolveLlmClients,
} from './commands/llm-client.js';
import { paidLlmProvider } from './commands/paid-llm-attempt.js';
import { providerIdentityKey } from './contracts/domain/index.js';
import type { CredentialContext, EnvRecord } from './core/credentials.js';
import type { PreparedResearchExecution } from './core/execution-plan.js';
import { buildProviderMetering } from './core/metering.js';
import { getBuiltinProviderDefinition } from './core/provider-descriptor.js';
import {
  costMicrousdFromUsd,
  type PaidStageDeclaration,
} from './run-paid-wallet.js';
import type { Config, ProviderTier } from './types.js';

export interface PaidStageIntent {
  readonly refinement: boolean;
  readonly synthesis: boolean;
  readonly verification: boolean;
}

export interface PaidStagePlanningInput {
  readonly prepared: PreparedResearchExecution;
  readonly config: Config;
  readonly credentials: CredentialContext;
  readonly intent: PaidStageIntent;
  readonly env?: EnvRecord;
}

function semanticTier(
  adapterId: string,
  resultKind: PreparedResearchExecution['request']['slots'][number]['primary']['result_kind'],
): ProviderTier | undefined {
  const builtin = getBuiltinProviderDefinition(adapterId)?.tier;
  if (builtin) return builtin;
  if (resultKind === 'search_results') return 'raw-search';
  if (resultKind === 'grounded_answer') return 'ai-grounded';
  if (resultKind === 'research_report') return 'deep-research';
  return undefined;
}

/** Build the exact four-stage declaration consumed by real and preview wallets. */
export function buildPaidStageDeclarations(
  input: PaidStagePlanningInput,
): readonly PaidStageDeclaration[] {
  const fallbackAuthorized = input.prepared.policy.fallback.kind !== 'disabled';
  const resolveClients = (kind: 'refine' | 'answer') => {
    const clients = resolveLlmClients(
      kind === 'refine'
        ? input.config.refine
        : preferenceFromConfig(input.config, 'answer', 'refine'),
      {
        env: input.env ?? input.credentials.env ?? process.env,
        config: input.config,
        credentials: input.credentials,
      },
    );
    return fallbackAuthorized ? clients : clients.slice(0, 1);
  };
  const refineClients = input.intent.refinement ? resolveClients('refine') : [];
  const answerClients =
    input.intent.synthesis || input.intent.verification
      ? resolveClients('answer')
      : [];
  const plannedProfiles = [
    ...input.prepared.request.slots.map((slot) => slot.primary),
    ...input.prepared.request.fallback_reserve.map(
      (candidate) => candidate.profile,
    ),
  ];
  const researchProviders = plannedProfiles.flatMap((profile) => {
    const plan =
      input.prepared.profile_plans_by_identity[
        providerIdentityKey(profile.identity)
      ];
    return plan
      ? [
          {
            provider: plan.binding.adapter_id,
            profile: providerIdentityKey(profile.identity),
            ...(plan.estimate?.estimated_cost_microusd !== undefined && {
              estimated_cost_microusd: plan.estimate.estimated_cost_microusd,
              estimate_source: 'canonical_profile_plan',
            }),
            result_kind: profile.result_kind,
          },
        ]
      : [];
  });
  const verificationSearchProviders = Array.from(
    new Map(
      researchProviders.map((provider) => [
        `${provider.provider}\0${provider.profile}`,
        provider,
      ]),
    ).values(),
  )
    .filter((provider) => {
      const tier = semanticTier(provider.provider, provider.result_kind);
      return tier === 'ai-grounded' || tier === 'raw-search';
    })
    .map(({ result_kind: _resultKind, ...declared }) => {
      const estimate = buildProviderMetering(
        declared.provider,
        input.config.providers[declared.provider],
      ).estimate;
      const cost = costMicrousdFromUsd(estimate?.estimatedCostUsd);
      return {
        provider: declared.provider,
        profile: declared.profile,
        ...(cost !== undefined && { estimated_cost_microusd: cost }),
        ...(estimate?.pricingVersion && {
          estimate_source: `pricing:${estimate.pricingVersion}`,
        }),
      };
    });

  return [
    {
      stage: 'refinement',
      requested: input.intent.refinement,
      fallback_authorized: fallbackAuthorized,
      prompt_version: 'refine-v1',
      providers: refineClients.map((client) =>
        paidLlmProvider(client, input.config),
      ),
    },
    {
      stage: 'research',
      requested: true,
      fallback_authorized: fallbackAuthorized,
      prompt_version: 'canonical-request-v3',
      providers: researchProviders.map(
        ({ result_kind: _resultKind, ...provider }) => provider,
      ),
    },
    {
      stage: 'synthesis',
      requested: input.intent.synthesis,
      fallback_authorized: fallbackAuthorized,
      prompt_version: 'grounded-synthesis-v1',
      providers: answerClients.map((client) =>
        paidLlmProvider(client, input.config),
      ),
      reserve_first_attempt: true,
    },
    {
      stage: 'verification',
      requested: input.intent.verification,
      fallback_authorized: fallbackAuthorized,
      prompt_version: 'claim-verification-v1',
      providers: [
        ...answerClients.map((client) => paidLlmProvider(client, input.config)),
        ...verificationSearchProviders,
      ],
    },
  ];
}
