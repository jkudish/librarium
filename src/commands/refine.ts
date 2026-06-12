import type { Command } from 'commander';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import type { Config, ProviderTier } from '../types.js';

/**
 * One-shot LLM query transform for `run --refine` and `librarium refine`.
 * CLI layer only: librarium/core never performs LLM calls. The client is a
 * direct fetch against whichever provider has an API key available
 * (OpenAI, then Gemini, then Perplexity), overridable via config.refine.
 */

export interface RefinedQueries {
  tierQueries: Record<ProviderTier, string>;
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

interface RefineClient {
  provider: 'openai' | 'gemini' | 'perplexity';
  model: string;
  apiKey: string;
}

/** Pick the refine client by config override, then by available API key. */
export function resolveRefineClient(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): RefineClient | null {
  const defaults: Record<
    'openai' | 'gemini' | 'perplexity',
    { envVar: string; model: string }
  > = {
    openai: { envVar: 'OPENAI_API_KEY', model: 'gpt-5-mini' },
    gemini: { envVar: 'GEMINI_API_KEY', model: 'gemini-2.5-flash' },
    perplexity: { envVar: 'PERPLEXITY_API_KEY', model: 'sonar' },
  };

  const preferred = config.refine?.provider;
  const order: Array<'openai' | 'gemini' | 'perplexity'> = preferred
    ? [preferred]
    : ['openai', 'gemini', 'perplexity'];

  for (const provider of order) {
    const { envVar, model } = defaults[provider];
    const apiKey = env[envVar];
    if (apiKey) {
      return { provider, model: config.refine?.model ?? model, apiKey };
    }
  }
  return null;
}

async function callOpenAi(
  client: RefineClient,
  prompt: string,
): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${client.apiKey}`,
    },
    body: JSON.stringify({
      model: client.model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI refine call failed: HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? '';
}

async function callGemini(
  client: RefineClient,
  prompt: string,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${client.model}:generateContent?key=${client.apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });
  if (!response.ok) {
    throw new Error(`Gemini refine call failed: HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function callPerplexity(
  client: RefineClient,
  prompt: string,
): Promise<string> {
  const response = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${client.apiKey}`,
    },
    body: JSON.stringify({
      model: client.model,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Perplexity refine call failed: HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? '';
}

/**
 * Refine a query into tier-tuned variants. Throws when no client is
 * configured or the call/parse fails; callers must treat refine as
 * best-effort and fall back to the original query.
 */
export async function refineQuery(
  query: string,
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RefinedQueries> {
  const client = resolveRefineClient(config, env);
  if (!client) {
    throw new Error(
      'no refine provider available (set OPENAI_API_KEY, GEMINI_API_KEY, or PERPLEXITY_API_KEY)',
    );
  }
  const prompt = `${REFINE_PROMPT}${query}`;
  const text =
    client.provider === 'openai'
      ? await callOpenAi(client, prompt)
      : client.provider === 'gemini'
        ? await callGemini(client, prompt)
        : await callPerplexity(client, prompt);
  return parseRefineResponse(text);
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
        const refined = await refineQuery(query, config);
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
