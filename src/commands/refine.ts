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

const CLIENT_DEFAULTS: Record<
  'openai' | 'gemini' | 'perplexity',
  { envVar: string; model: string }
> = {
  openai: { envVar: 'OPENAI_API_KEY', model: 'gpt-5-mini' },
  gemini: { envVar: 'GEMINI_API_KEY', model: 'gemini-2.5-flash' },
  perplexity: { envVar: 'PERPLEXITY_API_KEY', model: 'sonar' },
};

/**
 * Resolve the ordered list of usable refine clients. An explicit
 * config.refine.provider pins the list to that single provider (no
 * cascade); otherwise every provider with an API key is included in
 * openai, gemini, perplexity order. A config.refine.model override only
 * applies to the first client; cascade targets use their own defaults.
 */
export function resolveRefineClients(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): RefineClient[] {
  const preferred = config.refine?.provider;
  const order: Array<'openai' | 'gemini' | 'perplexity'> = preferred
    ? [preferred]
    : ['openai', 'gemini', 'perplexity'];

  const clients: RefineClient[] = [];
  for (const provider of order) {
    const { envVar, model } = CLIENT_DEFAULTS[provider];
    const apiKey = env[envVar];
    if (!apiKey) continue;
    clients.push({
      provider,
      model: clients.length === 0 ? (config.refine?.model ?? model) : model,
      apiKey,
    });
  }
  return clients;
}

/** First usable refine client, or null. */
export function resolveRefineClient(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): RefineClient | null {
  return resolveRefineClients(config, env)[0] ?? null;
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
  let detail = '';
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        message?: string;
        code?: unknown;
        type?: string;
        status?: string;
      };
      message?: string;
    };
    const err = parsed.error;
    const code =
      (typeof err?.code === 'string' ? err.code : undefined) ??
      err?.type ??
      err?.status ??
      '';
    const message = String(err?.message ?? parsed.message ?? '');
    detail = [code, message ? `(${message})` : ''].filter(Boolean).join(' ');
  } catch {
    detail = body;
  }
  detail = detail.replace(/\s+/g, ' ').trim();
  if (detail.length > 120) detail = `${detail.slice(0, 119)}\u2026`;
  return `${label} refine call failed: HTTP ${status}${detail ? ` ${detail}` : ''}`;
}

async function safeBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
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
    throw new Error(
      formatHttpError('OpenAI', response.status, await safeBody(response)),
    );
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
    throw new Error(
      formatHttpError('Gemini', response.status, await safeBody(response)),
    );
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
    throw new Error(
      formatHttpError('Perplexity', response.status, await safeBody(response)),
    );
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? '';
}

function callClient(client: RefineClient, prompt: string): Promise<string> {
  return client.provider === 'openai'
    ? callOpenAi(client, prompt)
    : client.provider === 'gemini'
      ? callGemini(client, prompt)
      : callPerplexity(client, prompt);
}

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
  env: NodeJS.ProcessEnv = process.env,
  onWarning?: (message: string) => void,
): Promise<RefinedQueries> {
  const clients = resolveRefineClients(config, env);
  if (clients.length === 0) {
    throw new Error(
      config.refine?.provider
        ? `refine provider "${config.refine.provider}" has no API key configured`
        : 'no refine provider available (set OPENAI_API_KEY, GEMINI_API_KEY, or PERPLEXITY_API_KEY)',
    );
  }
  const prompt = `${REFINE_PROMPT}${query}`;
  let lastError: unknown;
  for (let index = 0; index < clients.length; index++) {
    const client = clients[index] as RefineClient;
    try {
      const text = await callClient(client, prompt);
      return parseRefineResponse(text);
    } catch (e) {
      lastError = e;
      const next = clients[index + 1];
      if (next) {
        const message = e instanceof Error ? e.message : String(e);
        onWarning?.(`${message}; trying ${next.provider}`);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
        const refined = await refineQuery(query, config, process.env, (w) =>
          console.error(`refine: ${w}`),
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
