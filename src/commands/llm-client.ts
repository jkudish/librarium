import {
  parseAgentResponse,
  redactPerplexityError,
} from '../adapters/perplexity-agent-base.js';
import { PROVIDER_ENV_VARS } from '../constants.js';
import {
  type CredentialContext,
  type EnvRecord,
  redactCredentialText,
  resolveCredential,
} from '../core/credentials.js';
import type { Config, ProviderUsage } from '../types.js';

/**
 * Shared CLI-layer LLM client used by `refine` and `answer`.
 *
 * librarium/core never performs LLM calls. This module is a thin direct-fetch
 * client against whichever provider has an API key available (OpenAI, then
 * Gemini, then Perplexity), overridable via a config key. Both the query
 * transform (`refine`) and the grounded synthesis (`answer`) share the same
 * key-based resolution, cascade-on-failure, and error formatting; only the
 * config key, default timeout, and error label differ.
 */

export type LlmProvider = 'openai' | 'gemini' | 'perplexity';

export interface LlmClient {
  provider: LlmProvider;
  model: string;
  apiKey: string;
}

/** Provider preference (provider + model) read from a config key. */
export interface LlmClientPreference {
  provider?: LlmProvider;
  model?: string;
}

export interface LlmClientResolutionOptions {
  env?: EnvRecord;
  config?: Config;
  credentials?: CredentialContext;
}

const CLIENT_DEFAULTS: Record<LlmProvider, { envVar: string; model: string }> =
  {
    openai: { envVar: 'OPENAI_API_KEY', model: 'gpt-5-mini' },
    gemini: { envVar: 'GEMINI_API_KEY', model: 'gemini-2.5-flash' },
    perplexity: { envVar: 'PERPLEXITY_API_KEY', model: 'low' },
  };

/**
 * Resolve the ordered list of usable LLM clients for a given preference. An
 * explicit `preference.provider` pins the list to that single provider (no
 * cascade); otherwise every provider with an API key is included in openai,
 * gemini, perplexity order. A `preference.model` override only applies to the
 * first client; cascade targets use their own defaults.
 */
export function resolveLlmClients(
  preference: LlmClientPreference | undefined,
  envOrOptions: EnvRecord | LlmClientResolutionOptions = process.env,
): LlmClient[] {
  const options = normalizeResolutionOptions(envOrOptions);
  const preferred = preference?.provider;
  const order: LlmProvider[] = preferred
    ? [preferred]
    : ['openai', 'gemini', 'perplexity'];

  const clients: LlmClient[] = [];
  for (const provider of order) {
    const { model } = CLIENT_DEFAULTS[provider];
    const apiKey = resolveLlmApiKey(provider, options);
    if (!apiKey) continue;
    clients.push({
      provider,
      model: clients.length === 0 ? (preference?.model ?? model) : model,
      apiKey,
    });
  }
  return clients;
}

function normalizeResolutionOptions(
  envOrOptions: EnvRecord | LlmClientResolutionOptions,
): Required<Pick<LlmClientResolutionOptions, 'env'>> &
  Omit<LlmClientResolutionOptions, 'env'> {
  if (isResolutionOptions(envOrOptions)) {
    return {
      ...envOrOptions,
      env: envOrOptions.env ?? process.env,
    };
  }
  return { env: envOrOptions };
}

function isResolutionOptions(
  value: EnvRecord | LlmClientResolutionOptions,
): value is LlmClientResolutionOptions {
  const candidate = value as LlmClientResolutionOptions;
  return (
    candidate.config !== undefined ||
    candidate.credentials !== undefined ||
    (candidate.env !== undefined && typeof candidate.env === 'object')
  );
}

function resolveLlmApiKey(
  provider: LlmProvider,
  options: Required<Pick<LlmClientResolutionOptions, 'env'>> &
    Omit<LlmClientResolutionOptions, 'env'>,
): string | undefined {
  const envVar = CLIENT_DEFAULTS[provider].envVar;
  const credentials = { ...options.credentials, env: options.env };
  const envKey = resolveCredential(`$${envVar}`, credentials);
  if (envKey) return envKey;

  if (!options.config) return undefined;

  for (const [providerId, providerEnvVar] of Object.entries(
    PROVIDER_ENV_VARS,
  )) {
    if (providerEnvVar !== envVar) continue;
    const apiKeyRef = options.config.providers[providerId]?.apiKey;
    if (!apiKeyRef) continue;
    const resolved = resolveCredential(apiKeyRef, credentials);
    if (resolved) return resolved;
  }

  return undefined;
}

/**
 * Build an LLM error message including the API's own error detail (code/type
 * plus message, truncated) so failures like quota exhaustion are actionable.
 * `action` is the verb that appears in the message (e.g. "refine", "synthesis").
 */
export function formatLlmHttpError(
  label: string,
  action: string,
  status: number,
  body: string,
  knownCredentials: readonly (string | undefined)[] = [],
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
    detail = body.trim() ? '[unparseable provider error]' : '';
  }
  detail = detail.replace(/\s+/g, ' ').trim();
  detail = redactPerplexityError(detail);
  detail = redactCredentialText(detail, knownCredentials);
  if (detail.length > 120) detail = `${detail.slice(0, 119)}…`;
  return `${label} ${action} call failed: HTTP ${status}${detail ? ` ${detail}` : ''}`;
}

async function safeBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

interface CallContext {
  /** Action verb used in error messages (e.g. "refine", "synthesis"). */
  action: string;
  /** Timeout in milliseconds for the request. */
  timeoutMs: number;
  /**
   * For OpenAI/Gemini: request a JSON object response. `refine` parses JSON;
   * `answer` wants free-form markdown so leaves this false.
   */
  json: boolean;
  /** Shared run cancellation in addition to the per-call timeout. */
  signal?: AbortSignal;
}

interface LlmHttpResponse {
  text: string;
  usage?: ProviderUsage;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizedUsage(
  raw: unknown,
  keys: {
    input: string;
    output: string;
    total: string;
    nestedCost?: boolean;
  },
): ProviderUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const nestedCost =
    keys.nestedCost && record.cost && typeof record.cost === 'object'
      ? finiteNonNegative((record.cost as Record<string, unknown>).total_cost)
      : undefined;
  const directCost =
    finiteNonNegative(record.costUsd) ??
    finiteNonNegative(record.cost_usd) ??
    finiteNonNegative(record.total_cost) ??
    (typeof record.cost === 'number'
      ? finiteNonNegative(record.cost)
      : undefined);
  const usage: ProviderUsage = { raw };
  const inputTokens = finiteNonNegative(record[keys.input]);
  const outputTokens = finiteNonNegative(record[keys.output]);
  const totalTokens = finiteNonNegative(record[keys.total]);
  const costUsd = nestedCost ?? directCost;
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  if (costUsd !== undefined) usage.costUsd = costUsd;
  return usage;
}

async function callOpenAi(
  client: LlmClient,
  prompt: string,
  ctx: CallContext,
): Promise<LlmHttpResponse> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${client.apiKey}`,
    },
    body: JSON.stringify({
      model: client.model,
      messages: [{ role: 'user', content: prompt }],
      ...(ctx.json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: combinedSignal(ctx),
  });
  if (!response.ok) {
    throw new Error(
      formatLlmHttpError(
        'OpenAI',
        ctx.action,
        response.status,
        await safeBody(response),
        [client.apiKey],
      ),
    );
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: unknown;
  };
  return {
    text: data.choices?.[0]?.message?.content ?? '',
    usage: normalizedUsage(data.usage, {
      input: 'prompt_tokens',
      output: 'completion_tokens',
      total: 'total_tokens',
    }),
  };
}

async function callGemini(
  client: LlmClient,
  prompt: string,
  ctx: CallContext,
): Promise<LlmHttpResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${client.model}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': client.apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      ...(ctx.json
        ? { generationConfig: { responseMimeType: 'application/json' } }
        : {}),
    }),
    signal: combinedSignal(ctx),
  });
  if (!response.ok) {
    throw new Error(
      formatLlmHttpError(
        'Gemini',
        ctx.action,
        response.status,
        await safeBody(response),
        [client.apiKey],
      ),
    );
  }
  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: unknown;
  };
  return {
    text: data.candidates?.[0]?.content?.parts?.[0]?.text ?? '',
    usage: normalizedUsage(data.usageMetadata, {
      input: 'promptTokenCount',
      output: 'candidatesTokenCount',
      total: 'totalTokenCount',
    }),
  };
}

async function callPerplexity(
  client: LlmClient,
  prompt: string,
  ctx: CallContext,
): Promise<LlmHttpResponse> {
  const target = perplexityAgentTarget(client.model);
  const response = await fetch('https://api.perplexity.ai/v1/agent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${client.apiKey}`,
    },
    body: JSON.stringify({ input: prompt, ...target }),
    signal: combinedSignal(ctx),
  });
  if (!response.ok) {
    throw new Error(
      formatLlmHttpError('Perplexity', ctx.action, response.status, ''),
    );
  }
  const data = parseAgentResponse(await response.json());
  if (data.status !== 'completed') {
    throw new Error(
      redactPerplexityError(
        data.error?.message ??
          `Perplexity Agent response was not completed (status: ${data.status}).`,
      ),
    );
  }
  return {
    text: data.messages.join(''),
    usage: data.usage
      ? {
          ...(data.usage.inputTokens === undefined
            ? {}
            : { inputTokens: data.usage.inputTokens }),
          ...(data.usage.outputTokens === undefined
            ? {}
            : { outputTokens: data.usage.outputTokens }),
          ...(data.usage.totalTokens === undefined
            ? {}
            : { totalTokens: data.usage.totalTokens }),
          ...(data.usage.costUsd === undefined
            ? {}
            : { costUsd: data.usage.costUsd }),
          raw: data.usage.raw,
        }
      : undefined,
  };
}

const PERPLEXITY_AGENT_PRESETS: Readonly<Record<string, string>> = {
  'fast-search': 'fast',
  'pro-search': 'low',
  sonar: 'fast',
  'sonar-pro': 'low',
  'sonar-reasoning-pro': 'medium',
  'deep-research': 'medium',
  'advanced-deep-research': 'high',
  'sonar-deep-research': 'high',
  ultra: 'xhigh',
};

function perplexityAgentTarget(
  model: string,
): { readonly preset: string } | { readonly model: string } {
  const preset = PERPLEXITY_AGENT_PRESETS[model];
  if (preset !== undefined) return { preset };
  if (['fast', 'low', 'medium', 'high', 'xhigh'].includes(model)) {
    return { preset: model };
  }
  return { model };
}

function callClient(
  client: LlmClient,
  prompt: string,
  ctx: CallContext,
): Promise<LlmHttpResponse> {
  return client.provider === 'openai'
    ? callOpenAi(client, prompt, ctx)
    : client.provider === 'gemini'
      ? callGemini(client, prompt, ctx)
      : callPerplexity(client, prompt, ctx);
}

function combinedSignal(ctx: CallContext): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, ctx.timeoutMs));
  return ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
}

export interface CallWithCascadeOptions<T> {
  clients: LlmClient[];
  prompt: string;
  action: string;
  timeoutMs: number;
  json: boolean;
  /** Shared run cancellation signal. */
  signal?: AbortSignal;
  onWarning?: (message: string) => void;
  /** Runs immediately before each network attempt; a throw aborts the cascade. */
  beforeAttempt?: (client: LlmClient, index: number) => void | Promise<void>;
  /** Receives every dispatched attempt, including parse failures with usage. */
  onAttempt?: (attempt: LlmCascadeAttempt) => void;
  /**
   * Map the raw text response to a result. A throw here counts as a failure
   * for that client and cascades to the next (so a bad/unparseable response
   * is treated the same as an HTTP error). Defaults to returning the raw text.
   */
  parse?: (text: string) => T;
}

export interface LlmCascadeAttempt {
  client: LlmClient;
  status: 'success' | 'error';
  durationMs: number;
  usage?: ProviderUsage;
  error?: string;
}

/**
 * Call the first usable client; on failure cascade to the next (unless the
 * caller pinned a single client). Returns the parsed result of the first
 * client that succeeds. Throws the last error when every attempt fails.
 */
export async function callWithCascade<T = string>(
  options: CallWithCascadeOptions<T>,
): Promise<{ client: LlmClient; result: T; usage?: ProviderUsage }> {
  const {
    clients,
    prompt,
    action,
    timeoutMs,
    json,
    onWarning,
    beforeAttempt,
    onAttempt,
    parse,
  } = options;
  const ctx: CallContext = {
    action,
    timeoutMs,
    json,
    ...(options.signal && { signal: options.signal }),
  };
  const mapText = parse ?? ((text: string) => text as unknown as T);
  let lastError: unknown;
  for (let index = 0; index < clients.length; index++) {
    const client = clients[index] as LlmClient;
    await beforeAttempt?.(client, index);
    const started = Date.now();
    let response: LlmHttpResponse | undefined;
    try {
      response = await callClient(client, prompt, ctx);
      const result = mapText(response.text);
      onAttempt?.({
        client,
        status: 'success',
        durationMs: Date.now() - started,
        ...(response.usage ? { usage: response.usage } : {}),
      });
      return { client, result, usage: response.usage };
    } catch (e) {
      const rawMessage = e instanceof Error ? e.message : String(e);
      const message = redactCredentialText(rawMessage, [client.apiKey]);
      lastError =
        e instanceof Error && message === rawMessage ? e : new Error(message);
      onAttempt?.({
        client,
        status: 'error',
        durationMs: Date.now() - started,
        ...(response?.usage ? { usage: response.usage } : {}),
        error: message,
      });
      const next = clients[index + 1];
      if (next) {
        onWarning?.(`${message}; trying ${next.provider}`);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Read a `{provider, model}` preference from a config key, with an optional
 * fallback key (used so `answer` falls back to `refine` config). Returns
 * undefined when neither key is present.
 */
export function preferenceFromConfig(
  config: Config,
  key: 'refine' | 'answer',
  fallbackKey?: 'refine',
): LlmClientPreference | undefined {
  const primary = config[key];
  if (primary?.provider || primary?.model) return primary;
  if (fallbackKey) {
    const fallback = config[fallbackKey];
    if (fallback?.provider || fallback?.model) return fallback;
  }
  return undefined;
}
