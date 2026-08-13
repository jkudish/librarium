import { resolve } from 'node:path';
import {
  getAllProviders,
  getExactProvider,
  initializeProviders,
} from '../adapters/node-registry.js';
import { type RefinedQueries, refineQuery } from '../commands/refine.js';
import { providerIdentityKey } from '../contracts/domain/index.js';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import type { CredentialContext } from '../core/credentials.js';
import { generateSlug } from '../core/prompt-builder.js';
import {
  assertNoRetiredProviderSelectionTokens,
  ProviderSelectionError,
  resolveProviderSelection as resolveProviderSelectionCore,
} from '../core/provider-selection.js';
import { writeCanonicalPresentationArtifacts } from '../node-canonical-artifacts.js';
import {
  type CanonicalPreparedExecutionResult,
  createNodeCoordinatorDependencies,
  createRegisteredProviderAttemptBridge,
  runCanonicalPreparedExecution,
} from '../node-canonical-run.js';
import {
  assertAdmittedAdaptersRegistered,
  emitRequestPreflightNotices,
  type ProductionRequestPreflightResult,
  preflightProductionRequest,
  RequestPreflightError,
} from '../node-request-preflight.js';
import { type CreateRunDirDeps, createRunDir } from '../node-run-directory.js';
import type { Config, Defaults, Provider } from '../types.js';

/**
 * Silent, file-writing research pipeline used by the MCP server. This mirrors
 * the side effects of `librarium run` (run.json manifest, per-provider
 * .md/.meta.json, sources.json, summary.md, prompt.md) but
 * contains no spinners, tables, or stdout writes. Any diagnostics go to the
 * injectable `onWarn` sink (stderr by default) so the MCP stdio protocol on
 * stdout stays pure.
 */

export interface SilentRunArgs {
  query: string;
  providers?: string[];
  group?: string;
  mode?: 'sync' | 'async' | 'mixed';
  refine?: boolean;
}

export interface SilentRunDeps {
  /** Load + merge config (global + project + CLI flags). Injectable for tests. */
  loadMergedConfig?: () => Config;
  /** Canonical application service. Injectable so tests never call providers. */
  runCanonical?: typeof runCanonicalPreparedExecution;
  /** Exact registry lookup. Aliases are not accepted after admission. */
  resolveExactProvider?: (adapterId: string) => Provider | undefined;
  /** Initialize providers (registry side effect). Injectable for tests. */
  initialize?: typeof initializeProviders;
  /** Exact adapter ids registered by an injected initializer. */
  registeredAdapterIds?: () => Iterable<string>;
  /** Credentials (env). Defaults to process.env. */
  credentials?: CredentialContext;
  /** Diagnostic sink. Defaults to stderr. Never stdout. */
  onWarn?: (message: string) => void;
  /**
   * Injectable clock/suffix for collision-resistant run-dir creation. Tests can
   * pin `now`/`randomSuffix` to assert that two same-second runs get distinct
   * directories.
   */
  runDirDeps?: CreateRunDirDeps;
}

export interface SilentRunResult extends CanonicalPreparedExecutionResult {
  readonly outputDir: string;
  readonly reports: ReturnType<
    typeof writeCanonicalPresentationArtifacts
  >['reports'];
  readonly sources: ReturnType<
    typeof writeCanonicalPresentationArtifacts
  >['sources'];
  readonly totalCitations: number;
  readonly totalDurationMs: number;
}

export { ProviderSelectionError as ResearchInputError };

function defaultLoadMergedConfig(cliFlags: Partial<Defaults>): Config {
  const globalConfig = loadConfig();
  const projectConfig = loadProjectConfig(process.cwd());
  return mergeConfigs(globalConfig, projectConfig, cliFlags);
}

/**
 * Resolve the provider id list from explicit providers, a group name, or the
 * set of enabled providers. Throws ResearchInputError for caller mistakes
 * (unknown group, empty selection, unknown/ambiguous provider tokens) so the
 * MCP layer can surface a tool error.
 *
 * Distinguishes undefined (use defaults) from provided-but-empty: an
 * explicitly-passed empty `providers` array or an empty/whitespace `group`
 * is a caller mistake, not a fallthrough to the default enabled set. Provider
 * tokens are resolved against the registry (canonical ids and display names);
 * ANY unresolved token is a hard error listing the unknowns.
 */
export function resolveProviderSelection(
  config: Config,
  args: Pick<SilentRunArgs, 'providers' | 'group'>,
  onWarn: (message: string) => void = () => {},
): string[] {
  return resolveProviderSelectionCore(config, args, getAllProviders(), {
    onWarn,
  });
}

/**
 * Execute a full research run with the same file side effects as the CLI's
 * `run` command, but emitting nothing to stdout. Returns the manifest plus
 * structured data the MCP `research` tool shapes into its response.
 */
export async function runResearchSilent(
  args: SilentRunArgs,
  deps: SilentRunDeps = {},
): Promise<SilentRunResult> {
  const onWarn =
    deps.onWarn ?? ((message: string) => process.stderr.write(`${message}\n`));

  assertNoRetiredProviderSelectionTokens(args.providers);

  const cliFlags: Partial<Defaults> = {};
  if (args.mode) cliFlags.mode = args.mode;
  const config = deps.loadMergedConfig
    ? deps.loadMergedConfig()
    : defaultLoadMergedConfig(cliFlags);

  const preflightDeps = deps.credentials
    ? { createCredentials: () => deps.credentials as CredentialContext }
    : undefined;
  let preflight: ProductionRequestPreflightResult;
  try {
    preflight = preflightProductionRequest(
      {
        config,
        transport: {
          kind: 'silent_mcp',
          input: {
            query: args.query,
            providers: args.providers,
            group: args.group,
            mode: args.mode,
            refine: args.refine,
          },
        },
      },
      preflightDeps,
    );
  } catch (error) {
    if (error instanceof RequestPreflightError) {
      throw new ProviderSelectionError(error.message);
    }
    throw error;
  }
  emitRequestPreflightNotices(preflight.notices, onWarn);
  const credentials = preflight.credentials;

  const initialize = deps.initialize ?? initializeProviders;
  const initResult = await initialize(
    { ...config, credentials },
    { customProviderIds: preflight.admittedAdapterIds },
  );
  for (const warning of initResult.warnings) {
    onWarn(`[librarium] warning: ${warning}`);
  }

  try {
    const resolveExactProvider = deps.resolveExactProvider ?? getExactProvider;
    assertAdmittedAdaptersRegistered(
      preflight.prepared,
      deps.registeredAdapterIds?.() ??
        preflight.admittedAdapterIds.filter(
          (id) => resolveExactProvider(id)?.id === id,
        ),
    );
  } catch (error) {
    if (error instanceof RequestPreflightError) {
      throw new ProviderSelectionError(error.message);
    }
    throw error;
  }

  // Optional one-shot LLM refine. Never allowed to break the run.
  let refined: RefinedQueries | null = null;
  if (args.refine) {
    try {
      refined = await refineQuery(
        args.query,
        config,
        process.env,
        (message) => onWarn(`[librarium] refine: ${message}`),
        credentials,
      );
    } catch (e) {
      onWarn(
        `[librarium] warning: refine failed (${e instanceof Error ? e.message : String(e)}); dispatching the original query`,
      );
    }
  }

  const slug = generateSlug(args.query);
  const baseDir = resolve(config.defaults.outputDir);
  // Collision-resistant: exclusive mkdir with ms timestamp + random suffix so
  // two same-second runs of the same query never share a directory. The actual
  // created directory is what gets recorded in the manifest below.
  const outputDir = createRunDir(baseDir, slug, deps.runDirDeps);
  const resolveExactProvider = deps.resolveExactProvider ?? getExactProvider;
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
  const runCanonical = deps.runCanonical ?? runCanonicalPreparedExecution;
  const canonical = await runCanonical(preflight.prepared, {
    runs_root: baseDir,
    run_directory: outputDir,
    coordinator: createNodeCoordinatorDependencies(),
    attempt_bridge: createRegisteredProviderAttemptBridge(
      preflight.prepared,
      resolveExactProvider,
    ),
    refined_queries_by_slot: refinedQueriesBySlot,
  });
  const presentation = writeCanonicalPresentationArtifacts(
    canonical.manifest,
    outputDir,
    slug,
  );
  return {
    ...canonical,
    outputDir,
    reports: presentation.reports,
    sources: presentation.sources,
    totalCitations: presentation.totalCitations,
    totalDurationMs: presentation.totalDurationMs,
  };
}
