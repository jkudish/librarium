import type { Command } from 'commander';
import {
  parseMode,
  parseParallel,
  parseProviders,
  parseResearchQuery,
  parseTimeoutSeconds,
  parseUsdBudget,
} from '../cli-parsers.js';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import type { CredentialContext, EnvRecord } from '../core/credentials.js';
import {
  type ProductionRequestPreflightResult,
  preflightProductionRequest,
  RequestPreflightError,
} from '../node-request-preflight.js';
import {
  buildPaidStageDeclarations,
  type PaidStageIntent,
} from '../paid-stage-planning.js';
import {
  type PaidStageDeclaration,
  type PreparedPaidStage,
  preparePaidStages,
} from '../run-paid-wallet.js';
import type { Config, Defaults, ProjectConfig } from '../types.js';

export { RequestPreflightError };

export interface RunRequestOptions {
  providers?: string[];
  group?: string;
  mode?: 'sync' | 'async' | 'mixed';
  output?: string;
  parallel?: number;
  timeout?: number;
  maxCost?: number;
  maxEstimatedCost?: number;
  refine?: boolean;
  fallback?: boolean;
}

export interface RunRequestSettingSources {
  readonly selection: 'cli_providers' | 'cli_group' | 'builtin_quick';
  readonly mode: 'cli' | 'configuration';
  readonly max_concurrency: 'cli' | 'configuration';
  readonly inline_attempt_deadline: 'cli' | 'configuration';
  readonly request_deadline: 'derived' | 'configuration';
  readonly max_actual_cost: 'cli' | 'configuration' | 'unset';
  readonly max_estimated_cost: 'cli' | 'configuration' | 'unset';
  readonly fallback: 'cli' | 'configuration';
  readonly refinement: 'cli' | 'not_requested';
  readonly synthesis: 'cli' | 'not_requested';
  readonly verification: 'cli' | 'not_requested';
}

export interface PreparedRunRequest {
  readonly config: Config;
  readonly preflight: ProductionRequestPreflightResult;
  readonly stageDeclarations: readonly PaidStageDeclaration[];
  readonly stages: readonly PreparedPaidStage[];
  readonly settingSources: RunRequestSettingSources;
}

export interface PrepareRunRequestDeps {
  readonly loadGlobalConfig?: () => Config;
  readonly loadProjectConfig?: (cwd: string) => ProjectConfig | null;
  readonly cwd?: string;
  readonly createCredentials?: () => CredentialContext;
  readonly env?: EnvRecord;
}

/** Register the request-shaping arguments shared by `run` and `plan`. */
export function addRunRequestArguments(command: Command): Command {
  return command
    .argument('<query>', 'The research query', parseResearchQuery)
    .option(
      '-p, --providers <ids>',
      'Comma-separated provider IDs',
      parseProviders,
    )
    .option('-g, --group <name>', 'Use a predefined provider group')
    .option(
      '-m, --mode <mode>',
      'Execution mode: sync, async, or mixed',
      parseMode,
    )
    .option('--parallel <n>', 'Max parallel requests', parseParallel)
    .option(
      '--timeout <n>',
      'Timeout per provider in seconds',
      parseTimeoutSeconds,
    )
    .option(
      '--max-cost <usd>',
      'Hard budget for estimated admission and provider-reported runtime cost (USD)',
      parseUsdBudget,
    )
    .option(
      '--max-estimated-cost <usd>',
      'Hard budget for network-free estimated admission and reservations (USD)',
      parseUsdBudget,
    )
    .option(
      '--no-fallback',
      'Disable configured provider and helper fallbacks for an exact matrix',
    )
    .option(
      '--refine',
      'Include one query-refinement LLM stage before research',
    );
}

function cliDefaults(options: RunRequestOptions): Partial<Defaults> {
  return {
    ...(options.output && { outputDir: options.output }),
    ...(options.parallel && { maxParallel: options.parallel }),
    ...(options.timeout && { timeout: options.timeout }),
    ...(options.mode && { mode: options.mode }),
    ...(options.maxCost !== undefined && { maxCostUsd: options.maxCost }),
    ...(options.maxEstimatedCost !== undefined && {
      maxEstimatedCostUsd: options.maxEstimatedCost,
    }),
  };
}

function settingSources(
  options: RunRequestOptions,
  intent: PaidStageIntent,
  config: Config,
): RunRequestSettingSources {
  return {
    selection: options.providers
      ? 'cli_providers'
      : options.group !== undefined
        ? 'cli_group'
        : 'builtin_quick',
    mode: options.mode ? 'cli' : 'configuration',
    max_concurrency: options.parallel ? 'cli' : 'configuration',
    inline_attempt_deadline: options.timeout ? 'cli' : 'configuration',
    request_deadline:
      config.defaults.requestDeadlineMs === undefined
        ? 'derived'
        : 'configuration',
    max_actual_cost:
      options.maxCost !== undefined
        ? 'cli'
        : config.defaults.maxCostUsd !== undefined
          ? 'configuration'
          : 'unset',
    max_estimated_cost:
      options.maxEstimatedCost !== undefined
        ? 'cli'
        : config.defaults.maxEstimatedCostUsd !== undefined
          ? 'configuration'
          : 'unset',
    fallback: options.fallback === false ? 'cli' : 'configuration',
    refinement: intent.refinement ? 'cli' : 'not_requested',
    synthesis: intent.synthesis ? 'cli' : 'not_requested',
    verification: intent.verification ? 'cli' : 'not_requested',
  };
}

/**
 * Prepare the exact production request and paid-stage policy. This performs
 * local config and credential-reference resolution only; it never initializes
 * adapters, imports custom modules, spawns custom scripts, or uses the network.
 */
export function prepareRunRequest(
  query: string,
  options: RunRequestOptions,
  intent: PaidStageIntent,
  deps: PrepareRunRequestDeps = {},
): PreparedRunRequest {
  const config = mergeConfigs(
    (deps.loadGlobalConfig ?? loadConfig)(),
    (deps.loadProjectConfig ?? loadProjectConfig)(deps.cwd ?? process.cwd()),
    cliDefaults(options),
  );
  const preflight = preflightProductionRequest(
    {
      config,
      transport: {
        kind: 'cli',
        input: {
          query,
          providers: options.providers,
          group: options.group,
          mode: options.mode,
          parallel: options.parallel,
          timeoutSeconds: options.timeout,
          maxCostUsd: options.maxCost,
          maxEstimatedCostUsd: options.maxEstimatedCost,
          fallback: options.fallback,
          refine: options.refine,
        },
      },
    },
    deps.createCredentials
      ? { createCredentials: deps.createCredentials }
      : undefined,
  );
  const stageDeclarations = buildPaidStageDeclarations({
    prepared: preflight.prepared,
    config,
    credentials: preflight.credentials,
    intent,
    ...(deps.env && { env: deps.env }),
  });
  return {
    config,
    preflight,
    stageDeclarations,
    stages: preparePaidStages(
      stageDeclarations,
      preflight.prepared.policy.budgets,
    ),
    settingSources: settingSources(options, intent, config),
  };
}
