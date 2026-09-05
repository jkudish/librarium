import { spawn } from 'node:child_process';
import { rmdirSync } from 'node:fs';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import type { Command } from 'commander';
import ora from 'ora';
import {
  getExactProvider,
  initializeProviders,
} from '../adapters/node-registry.js';
import {
  parseMode,
  parseParallel,
  parseProviders,
  parseResearchQuery,
  parseTimeoutSeconds,
  parseUsdBudget,
} from '../cli-parsers.js';
import { providerIdentityKey } from '../contracts/domain/index.js';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import { safeWriteFile } from '../core/fs-utils.js';
import { buildProviderMetering } from '../core/metering.js';
import { generateSlug } from '../core/prompt-builder.js';
import { retiredProviderSelectionIssues } from '../core/provider-selection.js';
import { writeCanonicalPresentationArtifacts } from '../node-canonical-artifacts.js';
import {
  cancelCanonicalRun,
  createNodeCoordinatorDependencies,
  createRegisteredProviderAttemptBridge,
  runCanonicalPreparedExecution,
} from '../node-canonical-run.js';
import {
  readPaidRunLedger,
  withPaidRunLedgerLock,
  writePaidRunLedger,
} from '../node-paid-attempt-ledger.js';
import {
  assertAdmittedAdaptersRegistered,
  emitRequestPreflightNotices,
  preflightProductionRequest,
} from '../node-request-preflight.js';
import { createRunDir } from '../node-run-directory.js';
import {
  costMicrousdFromUsd,
  fingerprint,
  type PaidStageDeclaration,
  RunPaidWallet,
} from '../run-paid-wallet.js';
import type {
  Config,
  DeduplicatedSource,
  Defaults,
  ProviderDispatchResult,
  ProviderReport,
  RunManifest,
} from '../types.js';
import { generateHtmlReport } from './html-report.js';
import { generateJsonlReport } from './jsonl-report.js';
import type { LiveRunTable } from './live-table.js';
import { preferenceFromConfig, resolveLlmClients } from './llm-client.js';
import { paidLlmProvider } from './paid-llm-attempt.js';
import {
  countDeepResearch,
  deepResearchWarning,
  shouldConfirmDeepResearch,
} from './preflight.js';
import { type RefinedQueries, refineQuery } from './refine.js';
import {
  computeLineWidths,
  dimText,
  fileUrl,
  formatFallbackNotice,
  formatProviderLine,
  formatRunSummary,
  hyperlink,
  isColorEnabled,
  type LineWidths,
  shortenHomePath,
} from './run-format.js';

export interface RunOptions {
  providers?: string[];
  group?: string;
  mode?: 'sync' | 'async' | 'mixed';
  output?: string;
  parallel?: number;
  timeout?: number;
  maxCost?: number;
  maxEstimatedCost?: number;
  json?: boolean;
  open?: boolean;
  html?: boolean;
  jsonl?: boolean;
  refine?: boolean;
  /** Opt-in answer-only claim verification. Ignored by plain `run`. */
  verify?: boolean;
  yes?: boolean;
  fallback?: boolean;
  /**
   * Set by the wizard, whose own confirm step already counts as consent, so
   * the deep-research pre-flight confirm does not double-prompt. Not a CLI flag.
   */
  skipPreflightConfirm?: boolean;
}

export interface RunOutcome {
  exitCode: number;
  outputDir?: string;
}

/**
 * Context handed to a post-dispatch hook (used by `librarium answer`). Exposes
 * the deduped results, the run directory, and an output sink so the hook can
 * run an extra transform (e.g. LLM synthesis), print to the same stream as the
 * run, and contribute additive fields to run.json.
 */
export interface PostDispatchContext {
  query: string;
  config: Config;
  results: ProviderDispatchResult[];
  reports: ProviderReport[];
  sources: DeduplicatedSource[];
  outputDir: string;
  color: boolean;
  printLine: (line: string) => void;
  /** Private run-wide paid-call authority shared with helper stages. */
  wallet?: RunPaidWallet;
}

export interface PostDispatchResult {
  /** Additive fields merged into the run manifest before it is written. */
  manifestExtra?: Partial<Pick<RunManifest, 'answer' | 'verification'>>;
  /**
   * Raw synthesized answer body for downstream hook stages (verification).
   * Never merged into the manifest or persisted.
   */
  answerText?: string;
}

export interface ExecuteRunHooks {
  /** Helper stages requested by this command, frozen before refinement starts. */
  paidStages?: {
    synthesis?: boolean;
    verification?: boolean;
  };
  /**
   * Runs after sources are deduped and provider outputs are written, before
   * the run summary and run.json are produced. Must never throw (it is the
   * hook's job to fail open); a throw is swallowed so the run is never lost.
   */
  postDispatch?: (
    context: PostDispatchContext,
  ) => Promise<PostDispatchResult | undefined>;
}

export interface ExecuteRunDeps {
  /** Test/embedding seam for provider initialization. */
  initialize?: typeof initializeProviders;
  /**
   * Exact adapter ids registered by the injected initializer. Production reads
   * the client-scoped Node registry after initialization.
   */
  registeredAdapterIds?: () => Iterable<string>;
  /** Test seam for exact frozen adapter lookup. */
  resolveExactProvider?: typeof getExactProvider;
  /** Test seam for the canonical application service. */
  runCanonical?: typeof runCanonicalPreparedExecution;
}

/**
 * Strict parser for the shared --max-cost flag. Rejects anything that is not a
 * finite, positive USD amount so a typo never silently disables the budget
 * circuit breaker. Shared by `run` and `answer` so both validate identically.
 */
export function parseMaxCost(value: string): number {
  return parseUsdBudget(value);
}

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run a research query across multiple providers')
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
    .option('-o, --output <dir>', 'Output base directory')
    .option('--parallel <n>', 'Max parallel requests', parseParallel)
    .option(
      '--timeout <n>',
      'Timeout per provider in seconds',
      parseTimeoutSeconds,
    )
    .option(
      '--max-cost <usd>',
      'Stop launching providers once API-reported cost crosses this budget (USD)',
      parseMaxCost,
    )
    .option(
      '--max-estimated-cost <usd>',
      'Reserve each provider’s pre-dispatch estimated cost; skip launches once the estimate crosses this ceiling (USD)',
      parseMaxCost,
    )
    .option('-y, --yes', 'Skip the deep-research pre-flight confirm')
    .option(
      '--no-fallback',
      'Disable configured provider fallbacks for an exact provider matrix',
    )
    .option('--json', 'Output run.json to stdout')
    .option(
      '--refine',
      'Rewrite the query into tier-tuned variants with one LLM call before dispatch',
    )
    .option(
      '--html',
      'Generate a self-contained report.html in the run directory',
    )
    .option(
      '--jsonl',
      'Generate a machine-readable results.jsonl in the run directory',
    )
    .option(
      '--open',
      'Open the output directory (or report.html with --html) when the run completes',
    )
    .action(async (query: string, opts: RunOptions) => {
      await executeRun(query, opts);
    });
}

/**
 * Execute a research run. Shared by the `run` command and the interactive
 * wizard so both produce identical output and side effects.
 */
export async function executeRun(
  query: string,
  opts: RunOptions,
  hooks?: ExecuteRunHooks,
  deps: ExecuteRunDeps = {},
): Promise<RunOutcome> {
  const prettyStream = opts.json ? process.stderr : process.stdout;
  const color = isColorEnabled(prettyStream);
  const spinner = ora('Initializing providers...').start();
  const printLine = (line: string): void => {
    spinner.stop();
    prettyStream.write(`${line}\n`);
  };
  let onInterrupt: (() => void) | undefined;
  const retired = retiredProviderSelectionIssues(opts.providers);
  if (retired.length > 0) {
    spinner.fail(retired.map((issue) => issue.message).join(' '));
    process.exitCode = 2;
    return { exitCode: 2 };
  }
  try {
    const cliFlags: Partial<Defaults> = {};
    if (opts.output) cliFlags.outputDir = opts.output;
    if (opts.parallel) cliFlags.maxParallel = opts.parallel;
    if (opts.timeout) cliFlags.timeout = opts.timeout;
    if (opts.mode) cliFlags.mode = opts.mode;
    if (opts.maxCost !== undefined) cliFlags.maxCostUsd = opts.maxCost;
    if (opts.maxEstimatedCost !== undefined) {
      cliFlags.maxEstimatedCostUsd = opts.maxEstimatedCost;
    }
    const config = mergeConfigs(
      loadConfig(),
      loadProjectConfig(process.cwd()),
      cliFlags,
    );
    const preflight = preflightProductionRequest({
      config,
      transport: {
        kind: 'cli',
        input: {
          query,
          providers: opts.providers,
          group: opts.group,
          mode: opts.mode,
          parallel: opts.parallel,
          timeoutSeconds: opts.timeout,
          maxCostUsd: opts.maxCost,
          maxEstimatedCostUsd: opts.maxEstimatedCost,
          fallback: opts.fallback,
          refine: opts.refine,
        },
      },
    });
    emitRequestPreflightNotices(preflight.notices, (message) =>
      process.stderr.write(`${message}\n`),
    );
    const initialize = deps.initialize ?? initializeProviders;
    const init = await initialize(
      { ...config, credentials: preflight.credentials },
      { customProviderIds: preflight.admittedAdapterIds },
    );
    for (const warning of init.warnings) {
      process.stderr.write(`[librarium] warning: ${warning}\n`);
    }
    const resolveExactProvider = deps.resolveExactProvider ?? getExactProvider;
    const registered = new Set(
      deps.registeredAdapterIds?.() ??
        preflight.admittedAdapterIds.filter(
          (id) => resolveExactProvider(id)?.id === id,
        ),
    );
    assertAdmittedAdaptersRegistered(preflight.prepared, registered);
    const providerIds = preflight.prepared.request.slots.map((slot) => {
      const plan =
        preflight.prepared.profile_plans_by_identity[
          providerIdentityKey(slot.primary.identity)
        ];
      if (!plan)
        throw new Error('Admitted slot is missing its frozen binding.');
      return plan.binding.adapter_id;
    });
    const tierLookup = new Map(
      providerIds.flatMap((id) => {
        const provider = resolveExactProvider(id);
        return provider ? [[id, provider.tier] as const] : [];
      }),
    );
    if (
      !opts.json &&
      shouldConfirmDeepResearch({
        deepResearchCount: countDeepResearch(providerIds, tierLookup),
        isTTY: Boolean(process.stdout.isTTY && process.stdin.isTTY),
        yes: Boolean(opts.yes),
        fromWizard: Boolean(opts.skipPreflightConfirm),
      })
    ) {
      spinner.stop();
      const deepResearchProfiles = preflight.prepared.request.slots.flatMap(
        (slot) => {
          const plan =
            preflight.prepared.profile_plans_by_identity[
              providerIdentityKey(slot.primary.identity)
            ];
          return plan &&
            tierLookup.get(plan.binding.adapter_id) === 'deep-research'
            ? [
                `${slot.primary.identity.provider_id}/${slot.primary.identity.profile_id}`,
              ]
            : [];
        },
      );
      p.log.warn(deepResearchWarning(deepResearchProfiles));
      const proceed = await p.confirm({
        message: 'Proceed with this deep-research run?',
        initialValue: false,
      });
      if (p.isCancel(proceed) || !proceed) {
        process.stdout.write('Cancelled.\n');
        process.exitCode = 130;
        return { exitCode: 130 };
      }
    }

    const slug = generateSlug(query);
    const baseDir = resolve(config.defaults.outputDir);
    const outputDir = createRunDir(baseDir, slug);
    const fallbackAuthorized =
      preflight.prepared.policy.fallback.kind !== 'disabled';
    const resolvedClients = (kind: 'refine' | 'answer') => {
      const clients = resolveLlmClients(
        kind === 'refine'
          ? config.refine
          : preferenceFromConfig(config, 'answer', 'refine'),
        {
          env: process.env,
          config,
          credentials: preflight.credentials,
        },
      );
      return fallbackAuthorized ? clients : clients.slice(0, 1);
    };
    const refineClients = opts.refine ? resolvedClients('refine') : [];
    const answerClients =
      hooks?.paidStages?.synthesis || hooks?.paidStages?.verification
        ? resolvedClients('answer')
        : [];
    const plannedProfiles = [
      ...preflight.prepared.request.slots.map((slot) => slot.primary),
      ...preflight.prepared.request.fallback_reserve.map(
        (candidate) => candidate.profile,
      ),
    ];
    const researchProviders = plannedProfiles.flatMap((profile) => {
      const plan =
        preflight.prepared.profile_plans_by_identity[
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
            },
          ]
        : [];
    });
    const verificationSearchProviders = Array.from(
      new Map(
        researchProviders.map((provider) => [
          `${provider.provider}\0${provider.profile ?? ''}`,
          provider,
        ]),
      ).values(),
    )
      .filter((provider) => {
        const tier = resolveExactProvider(provider.provider)?.tier;
        return tier === 'ai-grounded' || tier === 'raw-search';
      })
      .map((declared) => {
        const estimate = buildProviderMetering(
          declared.provider,
          config.providers[declared.provider],
        ).estimate;
        const cost = costMicrousdFromUsd(estimate?.estimatedCostUsd);
        return {
          provider: declared.provider,
          ...(declared.profile && { profile: declared.profile }),
          ...(cost !== undefined && { estimated_cost_microusd: cost }),
          ...(estimate?.pricingVersion && {
            estimate_source: `pricing:${estimate.pricingVersion}`,
          }),
        };
      });
    const stages: PaidStageDeclaration[] = [
      {
        stage: 'refinement',
        requested: Boolean(opts.refine),
        fallback_authorized: fallbackAuthorized,
        prompt_version: 'refine-v1',
        providers: refineClients.map((client) =>
          paidLlmProvider(client, config),
        ),
      },
      {
        stage: 'research',
        requested: true,
        fallback_authorized: fallbackAuthorized,
        prompt_version: 'canonical-request-v3',
        providers: researchProviders,
      },
      {
        stage: 'synthesis',
        requested: Boolean(hooks?.paidStages?.synthesis),
        fallback_authorized: fallbackAuthorized,
        prompt_version: 'grounded-synthesis-v1',
        providers: answerClients.map((client) =>
          paidLlmProvider(client, config),
        ),
        reserve_first_attempt: true,
      },
      {
        stage: 'verification',
        requested: Boolean(hooks?.paidStages?.verification),
        fallback_authorized: fallbackAuthorized,
        prompt_version: 'claim-verification-v1',
        providers: [
          ...answerClients.map((client) => paidLlmProvider(client, config)),
          ...verificationSearchProviders,
        ],
      },
    ];
    const createdAt = preflight.prepared.request.requested_at;
    const wallet = new RunPaidWallet({
      request_id: preflight.prepared.request.request_id,
      request_fingerprint: fingerprint(preflight.prepared.request),
      config_fingerprint: fingerprint({
        defaults: config.defaults,
        refine: config.refine,
        answer: config.answer,
        providers: config.providers,
      }),
      created_at: createdAt,
      deadline_at: new Date(
        Date.parse(createdAt) +
          preflight.prepared.policy.limits.request_deadline_ms,
      ).toISOString(),
      ...(preflight.prepared.policy.budgets && {
        limits: preflight.prepared.policy.budgets,
      }),
      stages,
      on_change: (ledger) => writePaidRunLedger(baseDir, outputDir, ledger),
      with_mutation_lock: (action) =>
        withPaidRunLedgerLock(baseDir, outputDir, action),
      load_latest: () => readPaidRunLedger(baseDir, outputDir),
    });
    let stateCreated = false;
    let interrupted = false;
    let cancellation: Promise<void> | undefined;
    const coordinator = createNodeCoordinatorDependencies();
    const cancellationBridge = createRegisteredProviderAttemptBridge(
      preflight.prepared,
      resolveExactProvider,
    );
    const scheduleCancellation = (): void => {
      if (!stateCreated || !outputDir || cancellation) return;
      cancellation = cancelCanonicalRun({
        runs_root: baseDir,
        run_directory: outputDir,
        coordinator,
        attempt_bridge: cancellationBridge,
      })
        .then(() => undefined)
        .catch(() => undefined);
    };
    onInterrupt = (): void => {
      if (interrupted) return;
      interrupted = true;
      wallet.cancel();
      scheduleCancellation();
    };
    process.once('SIGINT', onInterrupt);
    let refined: RefinedQueries | null = null;
    if (opts.refine) {
      spinner.start('Refining query...');
      try {
        refined = await refineQuery(
          query,
          config,
          process.env,
          (message) =>
            process.stderr.write(
              `${dimText(`[librarium] refine: ${message}`, isColorEnabled(process.stderr))}\n`,
            ),
          preflight.credentials,
          wallet,
        );
      } catch (error) {
        process.stderr.write(
          `[librarium] warning: refine failed (${error instanceof Error ? error.message : String(error)}); dispatching the original query\n`,
        );
      }
    }
    if (interrupted || wallet.remainingMs() === 0) {
      process.off('SIGINT', onInterrupt);
      spinner.stop();
      process.exitCode = interrupted ? 130 : 2;
      return { exitCode: process.exitCode, outputDir };
    }
    const refinedQueriesBySlot = Object.fromEntries(
      preflight.prepared.request.slots.flatMap((slot) => {
        const plan =
          preflight.prepared.profile_plans_by_identity[
            providerIdentityKey(slot.primary.identity)
          ];
        const tier = plan
          ? resolveExactProvider(plan.binding.adapter_id)?.tier
          : undefined;
        const variant = tier ? refined?.tierQueries[tier] : undefined;
        return variant ? [[slot.slot_id, variant]] : [];
      }),
    );
    spinner.stop();
    printLine('');
    printLine(`  fanning out to ${providerIds.length} providers`);
    for (const providerId of providerIds) {
      printLine(dimText(`    ${providerId}`, color));
    }
    printLine('');
    spinner.start('Running canonical research...');
    const runCanonical = deps.runCanonical ?? runCanonicalPreparedExecution;
    let canonical;
    try {
      canonical = await runCanonical(preflight.prepared, {
        runs_root: baseDir,
        run_directory: outputDir,
        coordinator,
        attempt_bridge: {
          ...createRegisteredProviderAttemptBridge(
            preflight.prepared,
            resolveExactProvider,
          ),
          signal: wallet.signal,
        },
        paid_wallet: wallet,
        refined_queries_by_slot: refinedQueriesBySlot,
        is_cancelled: () => interrupted,
        on_state_created: () => {
          stateCreated = true;
          if (interrupted) scheduleCancellation();
        },
      });
    } catch (error) {
      if (!interrupted) throw error;
      await cancellation;
      const cancelled = stateCreated
        ? await cancelCanonicalRun({
            runs_root: baseDir,
            run_directory: outputDir,
            coordinator,
            attempt_bridge: cancellationBridge,
          })
        : undefined;
      if (!cancelled) {
        try {
          // createRunDir created this exact directory for this request. rmdir
          // succeeds only when it is still empty; never delete recursively.
          rmdirSync(outputDir);
        } catch {
          // Preserve any unexpected artifact for diagnosis.
        }
        process.off('SIGINT', onInterrupt);
        process.exitCode = 130;
        return { exitCode: 130 };
      }
      canonical = {
        manifest: cancelled,
        response: cancelled.terminal_response,
        runtime: {
          state: cancelled.coordination_state,
          outputs_by_attempt: {},
        },
      };
    }
    await cancellation;
    if (interrupted && stateCreated) {
      const cancelled = await cancelCanonicalRun({
        runs_root: baseDir,
        run_directory: outputDir,
        coordinator,
        attempt_bridge: cancellationBridge,
      });
      canonical = {
        ...canonical,
        manifest: cancelled,
        response: cancelled.terminal_response,
      };
    }
    spinner.stop();
    const presentation = writeCanonicalPresentationArtifacts(
      canonical.manifest,
      outputDir,
      slug,
    );
    const widths = computeLineWidths(
      presentation.reports.map((report) => report.id),
      presentation.reports.map((report) => report.tier),
    );
    printLine('');
    for (const report of presentation.reports) {
      if (report.fallbackFor) {
        printLine(formatFallbackNotice(report.id, color));
      }
      printLine(formatProviderLine(report, widths, color));
    }
    let postResult: PostDispatchResult | undefined;
    if (hooks?.postDispatch) {
      try {
        postResult = await hooks.postDispatch({
          query,
          config,
          results: presentation.results,
          reports: presentation.reports,
          sources: presentation.sources,
          outputDir,
          color,
          printLine,
          wallet,
        });
      } catch (error) {
        process.stderr.write(
          `[librarium] warning: post-dispatch hook failed (${error instanceof Error ? error.message : String(error)})\n`,
        );
      }
    }
    await cancellation;
    const successful = presentation.reports.filter(
      (report) => report.status === 'success',
    );
    const recovered = new Set(
      successful.flatMap((report) =>
        report.fallbackFor ? [report.fallbackFor] : [],
      ),
    );
    const failed = presentation.reports
      .filter(
        (report) => report.status === 'error' || report.status === 'timeout',
      )
      .filter((report) => !recovered.has(report.id)).length;
    const pending = presentation.reports.filter(
      (report) => report.status === 'async-pending',
    ).length;
    for (const line of formatRunSummary({
      succeeded: successful.length,
      failed,
      pending,
      uniqueSources: presentation.sources.length,
      totalCitations: presentation.totalCitations,
      outputDir,
      color,
      totalDurationMs: presentation.totalDurationMs,
    })) {
      printLine(line);
    }

    const answer = postResult?.answerText
      ? {
          content: postResult.answerText,
          ...(postResult.manifestExtra?.answer?.provider && {
            provider: postResult.manifestExtra.answer.provider,
          }),
          ...(postResult.manifestExtra?.answer?.model && {
            model: postResult.manifestExtra.answer.model,
          }),
        }
      : undefined;
    let reportPath: string | null = null;
    if (opts.html) {
      reportPath = resolve(outputDir, 'report.html');
      safeWriteFile(
        reportPath,
        generateHtmlReport({
          manifest: {
            ...presentation.generatorManifest,
            ...(postResult?.manifestExtra ?? {}),
          },
          providerContents: presentation.providerContents,
          sources: presentation.sources,
          ...(answer && { answer }),
        }),
      );
      printLine(
        `  \u25b8 ${hyperlink(shortenHomePath(reportPath), fileUrl(reportPath), color)}`,
      );
    }
    if (opts.jsonl) {
      const jsonlPath = resolve(outputDir, 'results.jsonl');
      safeWriteFile(
        jsonlPath,
        generateJsonlReport({
          manifest: {
            ...presentation.generatorManifest,
            ...(postResult?.manifestExtra ?? {}),
          },
          providerContents: presentation.providerContents,
          sources: presentation.sources,
          ...(answer && { answer }),
        }),
      );
      printLine(
        `  \u25b8 ${hyperlink(shortenHomePath(jsonlPath), fileUrl(jsonlPath), color)}`,
      );
    }
    if (opts.json) {
      console.log(
        JSON.stringify(
          canonical.response
            ? {
                outputDir,
                state: 'terminal',
                response: canonical.response,
                ...(answer && { answer }),
                ...(postResult?.manifestExtra?.verification && {
                  verification: postResult.manifestExtra.verification,
                }),
              }
            : { outputDir, state: 'pending' },
          null,
          2,
        ),
      );
    }
    const exitCode = interrupted
      ? 130
      : canonical.response
        ? canonical.response.status === 'succeeded'
          ? 0
          : canonical.response.status === 'partial'
            ? 1
            : 2
        : 0;
    if (opts.open && exitCode !== 2) openPath(reportPath ?? outputDir);
    process.off('SIGINT', onInterrupt);
    process.exitCode = exitCode;
    return { exitCode, outputDir };
  } catch (error) {
    if (onInterrupt) process.off('SIGINT', onInterrupt);
    spinner.fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return { exitCode: 2 };
  }
}

export interface DispatchPresentation {
  spinner: { stop(): unknown };
  live: Pick<LiveRunTable, 'resolveRemaining' | 'stop'> | null;
  printLine: (line: string) => void;
  widths: LineWidths;
  color: boolean;
}

/** Finalize provider rows before artifacts and post-dispatch hooks can print. */
export function finalizeDispatchPresentation(
  reports: ProviderReport[],
  presentation: DispatchPresentation,
): void {
  presentation.spinner.stop();
  if (presentation.live) {
    presentation.live.resolveRemaining(reports);
    presentation.live.stop();
    return;
  }
  for (const report of reports) {
    if (report.status === 'skipped') {
      presentation.printLine(
        formatProviderLine(report, presentation.widths, presentation.color),
      );
    }
  }
}

/** Open a file or directory with the platform opener. Failures are silent. */
export function openPath(target: string): void {
  let command: string;
  let args: string[];
  if (process.platform === 'darwin') {
    command = 'open';
    args = [target];
  } else if (process.platform === 'win32') {
    // `start` is a cmd builtin; the empty string is the window title so
    // paths containing spaces are not mistaken for it.
    command = 'cmd';
    args = ['/c', 'start', '', target];
  } else {
    command = 'xdg-open';
    args = [target];
  }
  try {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Best-effort only.
  }
}
