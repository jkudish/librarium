import type { Command } from 'commander';
import { providerIdentityKey } from '../contracts/domain/index.js';
import { getBuiltinProviderDefinition } from '../core/provider-descriptor.js';
import type { PreparationDiagnostic } from '../core/research-request.js';
import type { PreparedPaidStage } from '../run-paid-wallet.js';
import type { Config } from '../types.js';
import {
  addRunRequestArguments,
  type PreparedRunRequest,
  type PrepareRunRequestDeps,
  prepareRunRequest,
  RequestPreflightError,
  type RunRequestOptions,
} from './run-request.js';

export interface PlanOptions extends RunRequestOptions {
  answer?: boolean;
  verify?: boolean;
  json?: boolean;
}

interface OutputSink {
  write(chunk: string): unknown;
}

export interface ExecutePlanDeps extends PrepareRunRequestDeps {
  readonly prepare?: typeof prepareRunRequest;
  readonly stdout?: OutputSink;
  readonly stderr?: OutputSink;
}

interface PlanGuarantees {
  readonly meaning: 'preflight_ready_only';
  readonly provider_requests_made: false;
  readonly provider_authentication_verified: false;
  readonly live_availability_verified: false;
  readonly final_price_guaranteed: false;
  readonly adapters_loaded_or_tested: false;
  readonly custom_code_loaded: false;
  readonly run_artifacts_created: false;
  readonly executable_plan_created: false;
}

const GUARANTEES: PlanGuarantees = {
  meaning: 'preflight_ready_only',
  provider_requests_made: false,
  provider_authentication_verified: false,
  live_availability_verified: false,
  final_price_guaranteed: false,
  adapters_loaded_or_tested: false,
  custom_code_loaded: false,
  run_artifacts_created: false,
  executable_plan_created: false,
};

interface EstimateOutput {
  readonly state: 'known' | 'unknown';
  readonly cost_microusd?: string;
  readonly cost_usd?: string;
  readonly source?: string;
  readonly billable_units?: readonly {
    readonly unit: string;
    readonly quantity: string;
  }[];
}

function usdFromMicrousd(value: string): string {
  const padded = value.padStart(7, '0');
  return `${padded.slice(0, -6)}.${padded.slice(-6)}`;
}

function estimate(
  cost: string | undefined,
  source?: string,
  billableUnits?: readonly { unit: string; quantity: string }[],
): EstimateOutput {
  return cost === undefined
    ? { state: 'unknown' }
    : {
        state: 'known',
        cost_microusd: cost,
        cost_usd: usdFromMicrousd(cost),
        ...(source && { source }),
        ...(billableUnits && { billable_units: billableUnits }),
      };
}

function profileCredentialStatus(config: Config, adapterId: string): string {
  const builtin = getBuiltinProviderDefinition(adapterId);
  if (builtin) {
    return builtin.credential.required ? 'locally_resolved' : 'not_required';
  }
  return config.customProviders[adapterId]?.executionProfile?.credential
    ? 'locally_resolved'
    : 'not_required';
}

function planProfile(
  preparation: PreparedRunRequest,
  profile: PreparedRunRequest['preflight']['prepared']['request']['slots'][number]['primary'],
) {
  const plan =
    preparation.preflight.prepared.profile_plans_by_identity[
      providerIdentityKey(profile.identity)
    ];
  if (!plan) throw new Error('Admitted profile is missing its frozen binding.');
  return {
    provider_id: profile.identity.provider_id,
    profile_id: profile.identity.profile_id,
    adapter_id: plan.binding.adapter_id,
    binding_id: plan.binding.binding_id,
    result_kind: profile.result_kind,
    invocation: profile.invocation,
    resumability: profile.resumability,
    credential_availability: profileCredentialStatus(
      preparation.config,
      plan.binding.adapter_id,
    ),
    estimate: estimate(
      plan.estimate?.estimated_cost_microusd,
      'canonical_profile_plan',
      plan.estimate?.billable_units,
    ),
  };
}

function totalEstimate(profiles: readonly { estimate: EstimateOutput }[]) {
  const unknown = profiles.filter(
    ({ estimate }) => estimate.state === 'unknown',
  );
  if (unknown.length > 0) {
    return { state: 'unknown' as const, unknown_profiles: unknown.length };
  }
  const total = profiles
    .reduce(
      (sum, profile) => sum + BigInt(profile.estimate.cost_microusd ?? '0'),
      0n,
    )
    .toString();
  return {
    state: 'known' as const,
    cost_microusd: total,
    cost_usd: usdFromMicrousd(total),
  };
}

function stageOutput(stage: PreparedPaidStage) {
  return {
    stage: stage.stage,
    status: stage.status,
    requested: stage.requested,
    fallback_authorized: stage.fallback_authorized,
    prompt_version: stage.prompt_version,
    ...(stage.reason_code && { reason_code: stage.reason_code }),
    ...(stage.reserved_cost_microusd !== undefined && {
      synthesis_reservation: estimate(
        stage.reserved_cost_microusd,
        stage.providers[0]?.estimate_source,
      ),
    }),
    providers: stage.providers.map((provider) => ({
      provider: provider.provider,
      ...(provider.profile && { profile: provider.profile }),
      ...(provider.model && { model: provider.model }),
      estimate: estimate(
        provider.estimated_cost_microusd,
        provider.estimate_source,
      ),
    })),
  };
}

function omissions(notices: readonly PreparationDiagnostic[]) {
  return notices
    .filter(({ code }) => code === 'workflow_profile_unavailable')
    .map((notice) => {
      const match = /omitted unavailable profile "([^"]+)" \(([^)]+)\)\.$/.exec(
        notice.message,
      );
      return {
        code: notice.code,
        ...(match?.[1] && { profile: match[1] }),
        ...(match?.[2] && { reason: match[2] }),
        message: notice.message,
      };
    });
}

function effectiveSelector(
  options: PlanOptions,
  notices: readonly PreparationDiagnostic[],
) {
  if (options.providers) {
    return {
      kind: 'providers' as const,
      source: 'cli' as const,
      requested: options.providers,
      ...(options.group !== undefined && {
        ignored_group: options.group,
      }),
    };
  }
  if (options.group !== undefined) {
    const group = options.group.trim();
    const migrated = notices.some(
      ({ code, path }) =>
        code === 'configuration_group_alias_migrated' && path === '/group',
    );
    return {
      kind: 'group' as const,
      source: 'cli' as const,
      requested: group,
      effective: migrated ? `custom:${group}` : group,
    };
  }
  return {
    kind: 'group' as const,
    source: 'builtin_default' as const,
    effective: 'quick',
  };
}

function planWarnings(preparation: PreparedRunRequest) {
  const hardBudget =
    preparation.preflight.prepared.policy.budgets !== undefined;
  const warnings: Array<{
    code: string;
    stage: PreparedPaidStage['stage'];
    message: string;
    reason?: string;
    providers?: string[];
  }> = [];
  for (const stage of preparation.stages) {
    if (stage.status === 'skipped') {
      warnings.push({
        code: 'paid_stage_skipped',
        stage: stage.stage,
        reason: stage.reason_code ?? 'unavailable',
        message: `Requested ${stage.stage} will be skipped (${stage.reason_code ?? 'unavailable'}).`,
      });
      continue;
    }
    if (
      !hardBudget ||
      stage.status !== 'requested' ||
      stage.stage === 'research'
    ) {
      continue;
    }
    const unknown = stage.providers.filter(
      ({ estimated_cost_microusd }) => estimated_cost_microusd === undefined,
    );
    if (unknown.length > 0) {
      warnings.push({
        code: 'paid_stage_provider_unknown_cost_under_hard_budget',
        stage: stage.stage,
        providers: unknown.map(({ provider }) => provider),
        message: `${stage.stage} provider attempts with unknown estimates will be blocked by the hard budget.`,
      });
    }
  }
  return warnings;
}

export function buildPlanReceipt(
  preparation: PreparedRunRequest,
  options: PlanOptions,
) {
  const prepared = preparation.preflight.prepared;
  const primaryProfiles = prepared.request.slots.map((slot) =>
    planProfile(preparation, slot.primary),
  );
  const primaryBySlot = new Map(
    prepared.request.slots.map((slot) => [
      slot.slot_id,
      `${slot.primary.identity.provider_id}/${slot.primary.identity.profile_id}`,
    ]),
  );
  const fallbackReserve = prepared.request.fallback_reserve.map(
    (candidate) => ({
      ...planProfile(preparation, candidate.profile),
      eligible_primary_profiles: candidate.eligible_slot_ids.flatMap(
        (slotId) => {
          const profile = primaryBySlot.get(slotId);
          return profile ? [profile] : [];
        },
      ),
    }),
  );
  const notices = preparation.preflight.notices;
  return {
    schema_version: 1 as const,
    artifact: 'librarium.plan' as const,
    status: 'ready' as const,
    ready_means: 'preflight_ready_only' as const,
    selector: effectiveSelector(options, notices),
    primary_profiles: primaryProfiles,
    workflow_omissions: omissions(notices),
    fallback_reserve: fallbackReserve,
    estimates: {
      primary: totalEstimate(primaryProfiles),
      fallback_reserve: totalEstimate(fallbackReserve),
    },
    effective_settings: {
      mode: {
        value: prepared.request.mode,
        source: preparation.settingSources.mode,
      },
      limits: {
        value: prepared.policy.limits,
        source: {
          max_concurrency: preparation.settingSources.max_concurrency,
          inline_attempt_deadline_ms:
            preparation.settingSources.inline_attempt_deadline,
          request_deadline_ms: preparation.settingSources.request_deadline,
          background_attempt_deadline_ms: 'configuration' as const,
          poll_interval_ms: 'configuration' as const,
        },
      },
      budgets: {
        value: prepared.policy.budgets ?? null,
        source: {
          max_actual_cost_microusd: preparation.settingSources.max_actual_cost,
          max_estimated_cost_microusd:
            preparation.settingSources.max_estimated_cost,
        },
      },
      fallback: {
        value: prepared.policy.fallback.kind,
        source: preparation.settingSources.fallback,
      },
    },
    paid_stages: preparation.stages.map(stageOutput),
    warnings: planWarnings(preparation),
    diagnostics: notices,
    credential_check: {
      semantics: 'local_presence_or_reference_resolution_only' as const,
      structural_validation_ran_first: true as const,
      keychain_lookup_allowed: true as const,
      authentication_tested: false as const,
    },
    guarantees: GUARANTEES,
  };
}

function humanPlan(receipt: ReturnType<typeof buildPlanReceipt>): string {
  const lines = [
    'Plan ready — preflight only',
    'No provider requests, adapter loading, custom code, or run artifacts.',
    '',
    `Selection: ${receipt.selector.kind === 'providers' ? receipt.selector.requested.join(', ') : receipt.selector.effective} (${receipt.selector.source})`,
    `Mode: ${receipt.effective_settings.mode.value} (${receipt.effective_settings.mode.source})`,
    '',
    'Primary research:',
    ...receipt.primary_profiles.map(
      (profile) =>
        `  ${profile.provider_id}/${profile.profile_id}  ${profile.invocation}/${profile.resumability}  estimate ${profile.estimate.state === 'known' ? `$${profile.estimate.cost_usd}` : 'unknown'}`,
    ),
  ];
  if (receipt.workflow_omissions.length > 0) {
    lines.push('', 'Workflow omissions:');
    lines.push(
      ...receipt.workflow_omissions.map(
        (item) =>
          `  ${item.profile ?? 'profile'} — ${item.reason ?? item.message}`,
      ),
    );
  }
  lines.push('', 'Fallback reserve:');
  lines.push(
    ...(receipt.fallback_reserve.length === 0
      ? ['  none']
      : receipt.fallback_reserve.map(
          (profile) =>
            `  ${profile.provider_id}/${profile.profile_id}  estimate ${profile.estimate.state === 'known' ? `$${profile.estimate.cost_usd}` : 'unknown'}  for ${profile.eligible_primary_profiles.join(', ')}`,
        )),
  );
  lines.push('', 'Paid stages:');
  lines.push(
    ...receipt.paid_stages.map(
      (stage) =>
        `  ${stage.stage}: ${stage.status}${stage.reason_code ? ` (${stage.reason_code})` : ''}${stage.synthesis_reservation?.state === 'known' ? `; reserved $${stage.synthesis_reservation.cost_usd}` : ''}`,
    ),
  );
  if (receipt.warnings.length > 0) {
    lines.push('', 'WARNINGS:');
    lines.push(...receipt.warnings.map((warning) => `  ! ${warning.message}`));
  }
  lines.push(
    '',
    `Limits: ${JSON.stringify(receipt.effective_settings.limits.value)}`,
    `Budgets: ${receipt.effective_settings.budgets.value ? JSON.stringify(receipt.effective_settings.budgets.value) : 'none'}`,
    `Diagnostics: ${receipt.diagnostics.length === 0 ? 'none' : receipt.diagnostics.map(({ code }) => code).join(', ')}`,
    '',
    'Credentials: local presence/reference resolution only; OS keychain lookup may occur.',
    'Not checked: provider authentication, live availability, final pricing, or final bill.',
  );
  return `${lines.join('\n')}\n`;
}

function rejectedReceipt(error: unknown) {
  const preflight = error instanceof RequestPreflightError;
  return {
    schema_version: 1 as const,
    artifact: 'librarium.plan' as const,
    status: 'blocked' as const,
    ready: false as const,
    issues: preflight
      ? error.issues
      : [
          {
            code: 'plan_preparation_failed',
            phase: 'compilation' as const,
            path: '',
            message:
              'Planning failed while loading or validating local configuration. Run `librarium config --json` to inspect it without making provider requests.',
          },
        ],
    diagnostics: preflight ? error.notices : [],
    credential_check: {
      semantics: 'local_presence_or_reference_resolution_only' as const,
      structural_validation_ran_first: true as const,
      keychain_lookup_allowed: true as const,
      authentication_tested: false as const,
    },
    guarantees: GUARANTEES,
  };
}

export async function executePlan(
  query: string,
  options: PlanOptions,
  deps: ExecutePlanDeps = {},
): Promise<
  ReturnType<typeof buildPlanReceipt> | ReturnType<typeof rejectedReceipt>
> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  if (options.verify && !options.answer) {
    const receipt = rejectedReceipt(
      new RequestPreflightError(
        [
          {
            code: 'verification_requires_answer',
            phase: 'transport',
            path: '/verify',
            message:
              '--verify requires --answer because verification operates on the synthesized answer.',
          },
        ],
        [],
      ),
    );
    (options.json ? stdout : stderr).write(
      options.json
        ? `${JSON.stringify(receipt, null, 2)}\n`
        : `Plan blocked\n  verification_requires_answer: --verify requires --answer because verification operates on the synthesized answer.\n`,
    );
    process.exitCode = 2;
    return receipt;
  }
  try {
    const {
      prepare = prepareRunRequest,
      stdout: _stdout,
      stderr: _stderr,
      ...prepareDeps
    } = deps;
    const preparation = prepare(
      query,
      options,
      {
        refinement: Boolean(options.refine),
        synthesis: Boolean(options.answer),
        verification: Boolean(options.verify),
      },
      prepareDeps,
    );
    const receipt = buildPlanReceipt(preparation, options);
    stdout.write(
      options.json
        ? `${JSON.stringify(receipt, null, 2)}\n`
        : humanPlan(receipt),
    );
    process.exitCode = 0;
    return receipt;
  } catch (error) {
    const receipt = rejectedReceipt(error);
    (options.json ? stdout : stderr).write(
      options.json
        ? `${JSON.stringify(receipt, null, 2)}\n`
        : `Plan blocked\n${receipt.issues.map((issue) => `  ${issue.code} ${issue.path || '/'}: ${issue.message}`).join('\n')}\n`,
    );
    process.exitCode = 2;
    return receipt;
  }
}

export function registerPlanCommand(program: Command): void {
  addRunRequestArguments(
    program
      .command('plan')
      .description(
        'Preview exact research, answer, and verification admission offline',
      ),
  )
    .option('--answer', 'Include grounded answer synthesis in the preview')
    .option(
      '--verify',
      'Include answer verification in the preview (requires --answer)',
    )
    .option('--json', 'Output a sanitized versioned planning receipt')
    .action(async (query: string, options: PlanOptions) => {
      await executePlan(query, options);
    });
}
