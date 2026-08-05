import { join, resolve } from 'node:path';
import {
  getAllProviders,
  initializeProviders,
} from '../adapters/node-registry.js';
import { type RefinedQueries, refineQuery } from '../commands/refine.js';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import type { CredentialContext } from '../core/credentials.js';
import { dispatch } from '../core/dispatcher.js';
import { safeWriteFile } from '../core/fs-utils.js';
import { deduplicateSources } from '../core/normalizer.js';
import {
  buildPrompt,
  type CreateRunDirDeps,
  createRunDir,
  generateSlug,
} from '../core/prompt-builder.js';
import {
  ProviderSelectionError,
  resolveProviderSelection as resolveProviderSelectionCore,
} from '../core/provider-selection.js';
import {
  applyRunLifecycle,
  createRunManifest,
  markRunFailed,
  mutateRunManifest,
  toRunTaskState,
  upsertProviderReport,
} from '../core/run-manifest.js';
import { generateSummary } from '../core/synthesis.js';
import { createNodeCredentialContext } from '../node-credentials.js';
import type {
  Citation,
  Config,
  DeduplicatedSource,
  Defaults,
  ProviderDispatchResult,
  ProviderReport,
  RunManifest,
} from '../types.js';

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
  dispatch?: typeof dispatch;
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

export interface SilentRunResult {
  manifest: RunManifest;
  reports: ProviderReport[];
  results: ProviderDispatchResult[];
  sources: DeduplicatedSource[];
  totalCitations: number;
  totalDurationMs: number;
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

/** Write per-provider markdown + meta files for a completed dispatch. */
function writeProviderOutputs(
  outputDir: string,
  reports: ProviderReport[],
  results: ProviderDispatchResult[],
): void {
  for (const result of results) {
    const report = reports.find(
      (candidate) =>
        candidate.id === result.provider &&
        candidate.fallbackFor === result.fallbackFor,
    );
    if (!report?.outputFile || !report.metaFile) continue;

    safeWriteFile(join(outputDir, report.outputFile), result.text);
    safeWriteFile(
      join(outputDir, report.metaFile),
      JSON.stringify(
        {
          provider: result.provider,
          tier: result.tier,
          model: result.model,
          durationMs: result.durationMs,
          citationCount: result.citations.length,
          tokenUsage: result.tokenUsage,
          usage: result.usage,
          metering: result.metering,
          citations: result.citations,
        },
        null,
        2,
      ),
    );
  }
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
  const credentials = deps.credentials ?? createNodeCredentialContext();

  const cliFlags: Partial<Defaults> = {};
  if (args.mode) cliFlags.mode = args.mode;
  const config = deps.loadMergedConfig
    ? deps.loadMergedConfig()
    : defaultLoadMergedConfig(cliFlags);

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

  let promptDoc = buildPrompt(args.query);
  if (refined) {
    promptDoc += `\n\n## Refined Query Variants\n\n- deep-research: ${refined.tierQueries['deep-research']}\n- ai-grounded: ${refined.tierQueries['ai-grounded']}\n- raw-search: ${refined.tierQueries['raw-search']}\n`;
  }
  safeWriteFile(join(outputDir, 'prompt.md'), promptDoc);

  const timestamp = Math.floor(Date.now() / 1000);
  createRunManifest(outputDir, {
    status: 'running',
    timestamp,
    slug,
    query: args.query,
    mode: config.defaults.mode,
    outputDir,
    providers: [],
    sources: { total: 0, unique: 0, file: 'sources.json' },
    exitCode: null,
    refinedQueries: refined?.tierQueries,
  });

  try {
    const dispatchFn = deps.dispatch ?? dispatch;
    const dispatchStartedAt = Date.now();
    const { reports, results, asyncTasks } = await dispatchFn({
      config,
      providerIds,
      query: args.query,
      tierQueries: refined?.tierQueries,
      mode: config.defaults.mode,
      credentials,
      onProgress: (event) => {
        if (event.report) {
          upsertProviderReport(outputDir, event.report, event.task);
        }
      },
    });
    const totalDurationMs = Date.now() - dispatchStartedAt;

    writeProviderOutputs(outputDir, reports, results);

    const allCitations: Citation[] = results.flatMap((result) =>
      result.status === 'success' ? result.citations : [],
    );
    const sources = deduplicateSources(allCitations);

    safeWriteFile(
      join(outputDir, 'sources.json'),
      JSON.stringify(sources, null, 2),
    );

    const taskByProvider = new Map(
      asyncTasks.map((task) => [task.provider, toRunTaskState(task)]),
    );
    const manifest = mutateRunManifest(outputDir, (current) => {
      const persistedTasks = new Map(
        current.providers
          .filter((provider) => provider.task)
          .map((provider) => [provider.id, provider.task]),
      );
      current.providers = reports.map((report) => ({
        ...report,
        ...((report.task ??
        taskByProvider.get(report.id) ??
        persistedTasks.get(report.id))
          ? {
              task:
                report.task ??
                taskByProvider.get(report.id) ??
                persistedTasks.get(report.id),
            }
          : {}),
      }));
      current.sources = {
        total: allCitations.length,
        unique: sources.length,
        file: 'sources.json',
      };
      applyRunLifecycle(current);
    });

    const summary = generateSummary({
      query: args.query,
      reports,
      sources,
      asyncTasks,
      timestamp,
    });
    safeWriteFile(join(outputDir, 'summary.md'), summary);

    return {
      manifest,
      reports,
      results,
      sources,
      totalCitations: allCitations.length,
      totalDurationMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      markRunFailed(outputDir, message);
    } catch {
      // Preserve the original failure; manifest diagnostics are best effort.
    }
    throw error;
  }
}
