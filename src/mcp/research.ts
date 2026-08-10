import { resolve } from 'node:path';
import {
  getAllProviders,
  initializeProviders,
} from '../adapters/node-registry.js';
import { type RefinedQueries, refineQuery } from '../commands/refine.js';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import type { CredentialContext } from '../core/credentials.js';
import {
  type CreateRunDirDeps,
  createRunDir,
  generateSlug,
} from '../core/prompt-builder.js';
import {
  ProviderSelectionError,
  resolveProviderSelection as resolveProviderSelectionCore,
} from '../core/provider-selection.js';
import {
  type ExecuteResearchRunDependencies,
  executeResearchRun,
} from '../core/research-run.js';
import { createNodeCredentialContext } from '../node-credentials.js';
import { emitProductionShadowDiagnostic } from '../node-shadow-diagnostics.js';
import type { Config, Defaults } from '../types.js';

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
  /** Core dispatch. Injectable so tests can stub network. */
  dispatch?: ExecuteResearchRunDependencies['dispatch'];
  /** Initialize providers (registry side effect). Injectable for tests. */
  initialize?: typeof initializeProviders;
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

export type SilentRunResult = Awaited<ReturnType<typeof executeResearchRun>>;

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
 * tokens are resolved against the registry (canonical ids, legacy aliases, and
 * display names); ANY unresolved token is a hard error listing the unknowns.
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

  const cliFlags: Partial<Defaults> = {};
  if (args.mode) cliFlags.mode = args.mode;
  const config = deps.loadMergedConfig
    ? deps.loadMergedConfig()
    : defaultLoadMergedConfig(cliFlags);

  emitProductionShadowDiagnostic(
    {
      config,
      env: process.env,
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
    onWarn,
  );

  const credentials = deps.credentials ?? createNodeCredentialContext();

  const initialize = deps.initialize ?? initializeProviders;
  const initResult = await initialize({ ...config, credentials });
  for (const warning of initResult.warnings) {
    onWarn(`[librarium] warning: ${warning}`);
  }

  const providerIds = resolveProviderSelectionCore(
    config,
    args,
    getAllProviders(),
    {
      credentials,
      requireUsable: true,
      strictExplicitCredentials: true,
      onWarn,
    },
  );

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

  return executeResearchRun(
    {
      query: args.query,
      config,
      providerIds,
      outputDir,
      slug,
      tierQueries: refined?.tierQueries,
      credentials,
      onEvent: (event) => {
        if (event.type === 'post-dispatch-warning') {
          onWarn(`[librarium] warning: ${event.message}`);
        }
      },
    },
    { dispatch: deps.dispatch },
  );
}
