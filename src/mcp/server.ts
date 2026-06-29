import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  getProviderMeta,
  initializeProviders,
} from '../adapters/node-registry.js';
import { VERSION } from '../constants.js';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import { createNodeCredentialContext } from '../node-credentials.js';
import type { Config } from '../types.js';
import { checkAsyncTasks } from './async.js';
import {
  ResearchInputError,
  runResearchSilent,
  type SilentRunDeps,
} from './research.js';
import {
  readRunResults,
  resolveRunDir,
  shapeResearchResult,
} from './shaping.js';

/**
 * MCP server factory. All side-effecting dependencies are injectable so the
 * tool handlers can be exercised in-memory without network or real config.
 */
export interface McpServerDeps {
  /** Diagnostics sink. Defaults to stderr. NEVER stdout (it is the protocol). */
  onWarn?: (message: string) => void;
  /** Override for the silent research pipeline (tests stub dispatch here). */
  runResearch?: typeof runResearchSilent;
  /** Override config loading for list tools + run-dir resolution. */
  loadMergedConfig?: () => Config;
  /** Override async poll/retrieve. */
  checkAsync?: typeof checkAsyncTasks;
  /** Provider init (registry). Injectable for tests. */
  initialize?: typeof initializeProviders;
}

function defaultLoadMergedConfig(): Config {
  return mergeConfigs(loadConfig(), loadProjectConfig(process.cwd()));
}

/** JSON tool result. Content text is the JSON payload; structuredContent mirrors it. */
function jsonResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

/** Error tool result carrying the same detailed message the CLI would surface. */
function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createMcpServer(deps: McpServerDeps = {}): McpServer {
  const onWarn =
    deps.onWarn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const runResearch = deps.runResearch ?? runResearchSilent;
  const loadMergedConfig = deps.loadMergedConfig ?? defaultLoadMergedConfig;
  const checkAsync = deps.checkAsync ?? checkAsyncTasks;
  const initialize = deps.initialize ?? initializeProviders;

  const server = new McpServer({
    name: 'librarium',
    version: VERSION,
  });

  // --- research -----------------------------------------------------------
  server.registerTool(
    'research',
    {
      title: 'Run a multi-provider research query',
      description:
        'Fan out a research query across multiple search and deep-research providers in parallel. Writes a full run directory (run.json manifest, per-provider markdown, deduped sources.json, summary.md) and returns a compact structured result: the output directory, per-provider status and tallies, and the top deduped sources. Full provider text is NOT inlined; fetch it with get_results. Deep-research providers in async or mixed mode may return pending task ids to poll with check_async.',
      inputSchema: {
        query: z.string().min(1).describe('The research query or question.'),
        group: z
          .string()
          .optional()
          .describe(
            'A configured provider group (e.g. deep, quick, raw, all). Ignored when providers is given.',
          ),
        providers: z
          .array(z.string())
          .optional()
          .describe('Explicit provider ids to run. Overrides group.'),
        mode: z
          .enum(['sync', 'async', 'mixed'])
          .optional()
          .describe(
            'Execution mode. mixed (default) submits deep-research async and runs the rest synchronously.',
          ),
        refine: z
          .boolean()
          .optional()
          .describe(
            'Rewrite the query into tier-tuned variants with one LLM call before dispatch. Never breaks the run.',
          ),
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const researchDeps: SilentRunDeps = { onWarn };
        const run = await runResearch(
          {
            query: args.query,
            group: args.group,
            providers: args.providers,
            mode: args.mode,
            refine: args.refine,
          },
          researchDeps,
        );
        return jsonResult(shapeResearchResult(run));
      } catch (e) {
        if (e instanceof ResearchInputError) {
          return errorResult(e.message);
        }
        return errorResult(`research failed: ${describeError(e)}`);
      }
    },
  );

  // --- get_results --------------------------------------------------------
  server.registerTool(
    'get_results',
    {
      title: 'Read provider markdown from a run',
      description:
        'Return the full provider markdown content from a research run directory. Defaults to the most recent run; pass runDir to target a specific one and provider to limit to a single provider id. Content is capped per provider (~40k chars) with an explicit truncation marker, and includes the run manifest summary.',
      inputSchema: {
        runDir: z
          .string()
          .optional()
          .describe(
            'Run directory to read. Defaults to the most recent run under the configured output base.',
          ),
        provider: z
          .string()
          .optional()
          .describe(
            'Limit to a single provider id. Defaults to all providers.',
          ),
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const config = loadMergedConfig();
        const baseDir = resolve(config.defaults.outputDir);
        const runDir = resolveRunDir(baseDir, args.runDir);
        if (!runDir) {
          return errorResult(
            args.runDir
              ? `No run.json found in ${args.runDir}`
              : `No runs found under ${baseDir}. Run a research query first.`,
          );
        }
        const results = readRunResults(runDir, args.provider);
        if (!results) {
          return errorResult(`Could not read run manifest in ${runDir}`);
        }
        return jsonResult(results);
      } catch (e) {
        return errorResult(`get_results failed: ${describeError(e)}`);
      }
    },
  );

  // --- check_async --------------------------------------------------------
  server.registerTool(
    'check_async',
    {
      title: 'Poll async deep-research tasks',
      description:
        'Run one poll pass over the pending async deep-research tasks in a run directory (no blocking wait). Defaults to the most recent run. With retrieve=true, completed tasks are fetched and folded back into run.json and sources.json. Returns the per-task states.',
      inputSchema: {
        runDir: z
          .string()
          .optional()
          .describe(
            'Run directory whose async tasks to poll. Defaults to the most recent run.',
          ),
        retrieve: z
          .boolean()
          .optional()
          .describe('Retrieve completed tasks through the normal path.'),
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const config = loadMergedConfig();
        const credentials = createNodeCredentialContext();
        await initialize({ ...config, credentials });
        const baseDir = resolve(config.defaults.outputDir);
        const runDir = resolveRunDir(baseDir, args.runDir);
        if (!runDir) {
          return errorResult(
            args.runDir
              ? `No run.json found in ${args.runDir}`
              : `No runs found under ${baseDir}.`,
          );
        }
        const result = await checkAsync(runDir, args.retrieve ?? false);
        return jsonResult(result);
      } catch (e) {
        return errorResult(`check_async failed: ${describeError(e)}`);
      }
    },
  );

  // --- list_providers -----------------------------------------------------
  server.registerTool(
    'list_providers',
    {
      title: 'List configured providers',
      description:
        'Return a snapshot of the provider registry and config: id, name, tier, source, whether enabled, and whether an API key is configured.',
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      try {
        const config = loadMergedConfig();
        const credentials = createNodeCredentialContext();
        const initResult = await initialize({ ...config, credentials });
        for (const warning of initResult.warnings) {
          onWarn(`[librarium] warning: ${warning}`);
        }
        const meta = getProviderMeta(config.providers, credentials);
        return jsonResult({
          providers: meta.map((p) => ({
            id: p.id,
            name: p.displayName,
            tier: p.tier,
            source: p.source,
            enabled: p.enabled,
            keyConfigured: p.hasApiKey,
            credentialSource: p.credentialSource,
            configured: p.configured !== false,
          })),
        });
      } catch (e) {
        return errorResult(`list_providers failed: ${describeError(e)}`);
      }
    },
  );

  // --- list_groups --------------------------------------------------------
  server.registerTool(
    'list_groups',
    {
      title: 'List provider groups',
      description:
        'Return the configured provider groups and their member provider ids.',
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      try {
        const config = loadMergedConfig();
        return jsonResult({
          groups: Object.entries(config.groups).map(([name, members]) => ({
            name,
            members,
          })),
        });
      } catch (e) {
        return errorResult(`list_groups failed: ${describeError(e)}`);
      }
    },
  );

  return server;
}
