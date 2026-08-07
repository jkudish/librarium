import type { Command } from 'commander';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import type { CredentialContext, EnvRecord } from '../core/credentials.js';
import { createNodeCredentialContext } from '../node-credentials.js';
import type { Config, ProviderTier } from '../types.js';
import {
  callWithCascade,
  formatLlmHttpError,
  type LlmClient,
  resolveLlmClients,
} from './llm-client.js';

/**
 * One-shot LLM query transform for `run --refine` and `librarium refine`.
 * CLI layer only: librarium/core never performs LLM calls. The client is a
 * direct fetch against whichever provider has an API key available
 * (OpenAI, then Gemini, then Perplexity), overridable via config.refine.
 */

export interface RefinedQueries {
  // Partial: refine only produces variants for grounded tiers. The `llm` tier
  // has no refined variant -- its providers fall back to the base query in the
  // dispatcher (llm-tier providers use the prompt as-is).
  tierQueries: Partial<Record<ProviderTier, string>>;
  suggestedGroup?: string;
}

const VALID_GROUPS = new Set([
  'deep',
  'quick',
  'raw',
  'fast',
  'comprehensive',
  'all',
]);

// `visibility` is intentionally not suggested: it is a specialized,
// explicitly selected comparison of consumer answer surfaces, while refine's
// existing policy chooses only by query depth/search shape.

const REFINE_PROMPT = `Rewrite the research query below into three variants tuned for different search systems.
Respond with strict JSON only, no prose, no code fences, exactly this shape:
{"deepResearch": "...", "aiGrounded": "...", "rawSearch": "...", "suggestedGroup": "..."}

Rules:
- deepResearch: a thorough research brief (2 to 4 sentences) for an autonomous deep-research agent: scope, angles to cover, what a great answer includes.
- aiGrounded: a single focused question for an AI search assistant.
- rawSearch: a compact keyword-style query for a traditional search engine (no question words, no punctuation).
- suggestedGroup: one of deep, quick, raw, fast, comprehensive, all. Pick what fits the query's depth.

Research query: `;

/**
 * Parse and validate the LLM response. Tolerates code fences and stray
 * prose around the JSON object. Throws when no usable variants are found.
 */
export function parseRefineResponse(text: string): RefinedQueries {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('no JSON object in refine response');
  }
  const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('refine response is not an object');
  }
  const record = parsed as Record<string, unknown>;
  const deep = record.deepResearch;
  const grounded = record.aiGrounded;
  const raw = record.rawSearch;
  if (
    typeof deep !== 'string' ||
    typeof grounded !== 'string' ||
    typeof raw !== 'string' ||
    !deep.trim() ||
    !grounded.trim() ||
    !raw.trim()
  ) {
    throw new Error('refine response is missing query variants');
  }
  const suggestedGroup =
    typeof record.suggestedGroup === 'string' &&
    VALID_GROUPS.has(record.suggestedGroup)
      ? record.suggestedGroup
      : undefined;
  return {
    tierQueries: {
      'deep-research': deep.trim(),
      'ai-grounded': grounded.trim(),
      'raw-search': raw.trim(),
    },
    suggestedGroup,
  };
}

/** A resolved refine client (alias of the shared LLM client type). */
export type RefineClient = LlmClient;

/**
 * Resolve the ordered list of usable refine clients. An explicit
 * config.refine.provider pins the list to that single provider (no
 * cascade); otherwise every provider with an API key is included in
 * openai, gemini, perplexity order. A config.refine.model override only
 * applies to the first client; cascade targets use their own defaults.
 */
export function resolveRefineClients(
  config: Config,
  env: EnvRecord = process.env,
  credentials?: CredentialContext,
): RefineClient[] {
  return resolveLlmClients(config.refine, { env, config, credentials });
}

/** First usable refine client, or null. */
export function resolveRefineClient(
  config: Config,
  env: EnvRecord = process.env,
  credentials?: CredentialContext,
): RefineClient | null {
  return resolveRefineClients(config, env, credentials)[0] ?? null;
}

/**
 * Build a refine error message including the API's own error detail
 * (code/type plus message, truncated) so failures like quota exhaustion
 * are actionable. Exported for tests.
 */
export function formatHttpError(
  label: string,
  status: number,
  body: string,
): string {
  return formatLlmHttpError(label, 'refine', status, body);
}

/**
 * Refine must never block a run: a hung connection counts as a normal refine
 * failure (cascade to the next client, then fall back to the original query).
 */
const REFINE_TIMEOUT_MS = 30_000;

/**
 * Refine a query into tier-tuned variants. When the first provider fails
 * (quota, auth, bad response) the next available provider is tried, unless
 * config.refine.provider pins one explicitly. Throws when no client is
 * configured or every attempt fails; callers must treat refine as
 * best-effort and fall back to the original query.
 */
export async function refineQuery(
  query: string,
  config: Config,
  env: EnvRecord = process.env,
  onWarning?: (message: string) => void,
  credentials?: CredentialContext,
): Promise<RefinedQueries> {
  const clients = resolveRefineClients(config, env, credentials);
  if (clients.length === 0) {
    throw new Error(
      config.refine?.provider
        ? `refine provider "${config.refine.provider}" has no API key configured`
        : 'no refine provider available (set OPENAI_API_KEY, GEMINI_API_KEY, or PERPLEXITY_API_KEY)',
    );
  }
  const { result } = await callWithCascade<RefinedQueries>({
    clients,
    prompt: `${REFINE_PROMPT}${query}`,
    action: 'refine',
    timeoutMs: REFINE_TIMEOUT_MS,
    json: true,
    onWarning,
    parse: parseRefineResponse,
  });
  return result;
}

export function registerRefineCommand(program: Command): void {
  program
    .command('refine <query>')
    .description(
      'Rewrite a query into tier-tuned variants (no dispatch); suggests a group',
    )
    .option('--json', 'Output JSON')
    .action(async (query: string, opts: { json?: boolean }) => {
      try {
        const config = mergeConfigs(
          loadConfig(),
          loadProjectConfig(process.cwd()),
        );
        const credentials = createNodeCredentialContext();
        const refined = await refineQuery(
          query,
          config,
          process.env,
          (w) => console.error(`refine: ${w}`),
          credentials,
        );
        if (opts.json) {
          console.log(JSON.stringify(refined, null, 2));
          return;
        }
        console.log('');
        console.log(`  deep-research: ${refined.tierQueries['deep-research']}`);
        console.log(`  ai-grounded:   ${refined.tierQueries['ai-grounded']}`);
        console.log(`  raw-search:    ${refined.tierQueries['raw-search']}`);
        if (refined.suggestedGroup) {
          console.log('');
          console.log(`  suggested group: ${refined.suggestedGroup}`);
        }
      } catch (e) {
        console.error(
          `refine failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        process.exitCode = 2;
      }
    });
}
