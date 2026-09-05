import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { VERSION } from '../constants.js';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import type { CredentialContext } from '../core/credentials.js';
import { RunArtifactRepository } from '../node-run-artifacts.js';
import type { Config } from '../types.js';
import { checkAsyncTasks } from './async.js';
import { discoverProviders } from './provider-discovery.js';
import {
  ResearchInputError,
  runResearchSilent,
  type SilentRunDeps,
} from './research.js';
import { ResultPageOptionsSchema } from './result-pages.js';
import {
  type McpArtifactRepository,
  readRunIndex,
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
  /** Presence-only credentials used by static provider discovery. */
  discoveryCredentials?: CredentialContext;
  /** Run artifact store used by get_results and async run selection. */
  repository?: McpArtifactRepository;
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

/** Includes both SDK representations and JSON escaping in the final wire cap. */
function evidenceResult(payload: unknown): CallToolResult {
  const result = jsonResult(payload);
  return Buffer.byteLength(JSON.stringify(result), 'utf8') <= 64_000
    ? result
    : errorResult(
        'Saved result metadata exceeds the MCP response limit. Inspect the run locally.',
      );
}

/** Keep diagnostic failures bounded too, including provider-supplied messages. */
function errorResult(message: string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: message.length > 2_000 ? `${message.slice(0, 2_000)}…` : message,
      },
    ],
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
  const repository = deps.repository ?? new RunArtifactRepository();

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
        'Fan out a research query across multiple providers in parallel, defaulting to the quick workflow in sync mode. Saves full provider content locally and returns a bounded result index, never inline evidence. Read evidence with get_results using outputDir as runDir and an optional resultId. Async mode accepts durable profiles only; resume pending work with check_async.',
      inputSchema: {
        query: z.string().min(1).describe('The research query or question.'),
        group: z
          .string()
          .optional()
          .describe(
            'A configured provider group (e.g. deep, quick, raw, all). Defaults to quick when neither group nor providers is given. Ignored when providers is given.',
          ),
        providers: z
          .array(z.string())
          .optional()
          .describe('Explicit provider ids to run. Overrides group.'),
        mode: z
          .enum(['sync', 'async', 'mixed'])
          .optional()
          .describe(
            'Execution mode. sync (default) runs selected providers concurrently and waits for them. async accepts durable profiles only and returns pending work. mixed is retained for legacy compatibility and migrates to async with a notice.',
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
        return evidenceResult(shapeResearchResult(run));
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
        'Read a bounded page of saved provider evidence without provider calls, polling, or writes. Defaults to the most recent run and all results. Follow nextCursor with the same explicit runDir and filters until hasMore is false. resultId selects an exact index entry; provider filters its displayed id. Each chunk has exact UTF-16 offsets and untrusted-evidence delimiters. Full evidence stays saved. Changed results invalidate cursors; restart without cursor.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        runDir: z
          .string()
          .max(4096)
          .optional()
          .describe(
            'Run directory to read. Defaults to the most recent run under the configured output base.',
          ),
        provider: z
          .string()
          .max(1024)
          .optional()
          .describe(
            'Limit to a single provider id. Defaults to all providers.',
          ),
        resultId: ResultPageOptionsSchema.shape.resultId.describe(
          'Exact resultId from a research/check_async index or evidence page.',
        ),
        cursor: ResultPageOptionsSchema.shape.cursor.describe(
          'Opaque nextCursor from the previous page. Keep runDir and filters unchanged.',
        ),
        part: ResultPageOptionsSchema.shape.part.describe(
          'Read content (default) or citation metadata as paged JSON text. Reassemble citation chunks before parsing.',
        ),
        limitChars: ResultPageOptionsSchema.shape.limitChars.describe(
          'Total evidence characters per page, default 8000, maximum 12000. The total wire-byte cap may shorten a page further.',
        ),
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const config = loadMergedConfig();
        const baseDir = resolve(config.defaults.outputDir);
        const runDir = resolveRunDir(baseDir, args.runDir, repository);
        if (!runDir) {
          return errorResult(
            args.runDir
              ? `No run.json found in ${args.runDir}`
              : `No runs found under ${baseDir}. Run a research query first.`,
          );
        }
        const results = readRunResults(runDir, args.provider, repository, {
          resultId: args.resultId,
          cursor: args.cursor,
          part: args.part,
          limitChars: args.limitChars,
        });
        if (!results) {
          return errorResult(`Could not read run manifest in ${runDir}`);
        }
        return evidenceResult(results);
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
        'Run one bounded resume pass over pending async work in a run directory (no blocking wait). Defaults to the most recent run. schemaVersion 3 always retrieves and commits a result immediately when remote completion is observed; retrieve only gates retrieval for historical schemaVersion 2 runs. Returns counts and a bounded result index, never provider content or private task handles. Use get_results to read saved evidence.',
      inputSchema: {
        runDir: z
          .string()
          .max(4096)
          .optional()
          .describe(
            'Run directory whose async tasks to poll. Defaults to the most recent run.',
          ),
        retrieve: z
          .boolean()
          .optional()
          .describe(
            'Retrieve completed historical schemaVersion 2 tasks. schemaVersion 3 always retrieves observed remote completion.',
          ),
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const config = loadMergedConfig();
        const baseDir = resolve(config.defaults.outputDir);
        const runDir = resolveRunDir(baseDir, args.runDir, repository);
        if (!runDir) {
          return errorResult(
            args.runDir
              ? `No run.json found in ${args.runDir}`
              : `No runs found under ${baseDir}.`,
          );
        }
        const result = await checkAsync(runDir, args.retrieve ?? false, config);
        return evidenceResult({
          schemaVersion: 1,
          kind: 'librarium.mcp.async-index',
          runDir,
          polled: result.polled,
          retrieved: result.retrieved,
          ...(result.error && { error: result.error }),
          ...(result.regenerationError && {
            regenerationError: result.regenerationError,
          }),
          index: readRunIndex(runDir, repository),
        });
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
        'List providers from static configuration and declarations without initializing adapters. With detail="profiles", also returns versioned exact profile selectors, capabilities, workflows, availability reasons, credential presence status, and catalog revision.',
      inputSchema: {
        provider: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            'Filter by configured adapter id or canonical provider id.',
          ),
        detail: z
          .literal('profiles')
          .optional()
          .describe('Include the versioned authoritative profile catalog.'),
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const config = loadMergedConfig();
        return jsonResult(
          discoverProviders(config, args, deps.discoveryCredentials),
        );
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
