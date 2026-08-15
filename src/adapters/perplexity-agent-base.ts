import { UnsafeToRetrySubmissionError } from '../core/errors.js';
import type {
  HttpClient,
  HttpRequestOptions,
  HttpResponse,
} from '../core/http-client.js';
import {
  HttpRequestAbortedError,
  HttpRequestTimeoutError,
  HttpResponseTooLargeError,
} from '../core/http-client.js';
import type {
  AsyncPollResult,
  AsyncTaskHandle,
  Citation,
  ProviderFailureDiagnostic,
  ProviderOptions,
  ProviderResult,
  ProviderUsage,
} from '../types.js';
import type { BaseProviderOptions } from './base.js';
import { BackgroundBaseProvider, BaseProvider } from './base.js';

const AGENT_API_URL = 'https://api.perplexity.ai/v1/agent';
const AGENT_PRESETS = new Set(['fast', 'low', 'medium', 'high', 'xhigh']);
const AGENT_STATUSES = new Set([
  'queued',
  'in_progress',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'incomplete',
]);
const SOURCE_TYPES = new Set([
  'web',
  'news',
  'x',
  'file',
  'place',
  'video',
  'forum',
]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const SAFE_MODEL_IDENTIFIER =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,189}$/;
const DOCUMENTED_NON_CONTENT_OUTPUT_TYPES = new Set([
  'fetch_url_results',
  'finance_results',
  'people_search_results',
  'function_call',
  'sandbox_results',
  'mcp_list_tools',
  'mcp_call',
  'tool_search',
]);

export type AgentStatus =
  | 'queued'
  | 'in_progress'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'incomplete';

export interface AgentInputPart {
  readonly type: 'input_text';
  readonly text: string;
}

export type AgentInput = string | readonly AgentInputPart[];

export interface AgentSearchResult {
  readonly id: string | number;
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly source?: string;
}

export interface ParsedAgentResponse {
  readonly id: string;
  readonly status: AgentStatus;
  readonly model?: string;
  readonly messages: readonly string[];
  readonly searchResults: readonly AgentSearchResult[];
  readonly usage?: ParsedAgentUsage;
  readonly error?: { readonly code?: string; readonly message?: string };
}

export interface ParsedAgentUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly reasoningTokens?: number;
  readonly costUsd?: number;
  /** Sanitized, allowlisted provider usage only. */
  readonly raw: Readonly<Record<string, unknown>>;
}

interface AgentTransport {
  readonly request: HttpClient;
  readonly getApiKey: () => string;
}

interface AgentResponseError extends Error {
  readonly kind: 'agent_response' | 'agent_http';
  readonly httpStatus?: number;
}

function responseError(
  message: string,
  kind: AgentResponseError['kind'] = 'agent_response',
): AgentResponseError {
  return Object.assign(new Error(message), {
    name: 'PerplexityAgentResponseError',
    kind,
  }) as AgentResponseError;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value)) {
    throw responseError(`Perplexity Agent ${field} was malformed.`);
  }
  return value;
}

function safeModelIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_MODEL_IDENTIFIER.test(value)) {
    throw responseError(`Perplexity Agent ${field} was malformed.`);
  }
  return value;
}

function safeText(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 1_000_000 ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    })
  ) {
    throw responseError(`Perplexity Agent ${field} was malformed.`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isSafeInteger(value)
  ) {
    throw responseError(`Perplexity Agent ${field} was malformed.`);
  }
  return value;
}

function nonNegativeCost(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw responseError(`Perplexity Agent ${field} was malformed.`);
  }
  return value;
}

function assertInput(input: AgentInput): void {
  if (typeof input === 'string') {
    if (input.length === 0 || input.length > 1_000_000) {
      throw new TypeError('Perplexity Agent input must be a non-empty string.');
    }
    return;
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError(
      'Perplexity Agent input must be a string or typed input array.',
    );
  }
  for (const part of input) {
    if (
      !record(part) ||
      part.type !== 'input_text' ||
      typeof part.text !== 'string' ||
      part.text.length === 0
    ) {
      throw new TypeError('Perplexity Agent input parts were malformed.');
    }
  }
}

export function buildAgentRequest(
  input: AgentInput,
  preset: string,
  model: string | undefined,
  background: boolean,
): Record<string, unknown> {
  assertInput(input);
  if (!AGENT_PRESETS.has(preset)) {
    throw new TypeError(`Unsupported Perplexity Agent preset: ${preset}`);
  }
  if (model !== undefined && !SAFE_MODEL_IDENTIFIER.test(model)) {
    throw new TypeError('Perplexity Agent model override was malformed.');
  }
  const body: Record<string, unknown> = { input, preset };
  if (model !== undefined) body.model = model;
  if (background) body.background = true;
  return body;
}

function parseUsage(value: unknown): ParsedAgentUsage {
  const source = record(value);
  if (!source) throw responseError('Perplexity Agent usage was malformed.');

  const raw: Record<string, unknown> = {};
  const readToken = (key: string): number | undefined => {
    if (source[key] === undefined) return undefined;
    const parsed = nonNegativeNumber(source[key], `usage.${key}`);
    raw[key] = parsed;
    return parsed;
  };
  const inputTokens = readToken('input_tokens');
  const outputTokens = readToken('output_tokens');
  const totalTokens = readToken('total_tokens');

  const readDetails = (key: string): Record<string, number> | undefined => {
    if (source[key] === undefined) return undefined;
    const details = record(source[key]);
    if (!details)
      throw responseError(`Perplexity Agent usage.${key} was malformed.`);
    const parsed: Record<string, number> = {};
    for (const [detailKey, detailValue] of Object.entries(details)) {
      parsed[detailKey] = nonNegativeNumber(
        detailValue,
        `usage.${key}.${detailKey}`,
      );
    }
    raw[key] = parsed;
    return parsed;
  };
  const inputDetails = readDetails('input_tokens_details');
  const outputDetails = readDetails('output_tokens_details');
  const toolDetails = readDetails('tool_calls');
  if (toolDetails) raw.tool_calls = toolDetails;

  let cacheReadInputTokens: number | undefined;
  let cacheWriteInputTokens: number | undefined;
  let reasoningTokens: number | undefined;
  for (const details of [inputDetails, outputDetails]) {
    if (!details) continue;
    if (details.cache_read_input_tokens !== undefined) {
      cacheReadInputTokens = details.cache_read_input_tokens;
    }
    if (details.cache_write_input_tokens !== undefined) {
      cacheWriteInputTokens = details.cache_write_input_tokens;
    }
    if (
      details.cached_tokens !== undefined &&
      cacheReadInputTokens === undefined
    ) {
      cacheReadInputTokens = details.cached_tokens;
    }
    if (details.reasoning_tokens !== undefined) {
      reasoningTokens = details.reasoning_tokens;
    }
  }

  let costUsd: number | undefined;
  if (source.cost !== undefined) {
    const cost = record(source.cost);
    if (!cost)
      throw responseError('Perplexity Agent usage.cost was malformed.');
    if (cost.total_cost !== undefined) {
      costUsd = nonNegativeCost(cost.total_cost, 'usage.cost.total_cost');
      raw.cost = { total_cost: costUsd };
    }
  }

  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    raw,
  };
}

function safeSearchResultId(value: unknown): string | number {
  if (typeof value === 'number') {
    return nonNegativeNumber(value, 'search result id');
  }
  return safeIdentifier(value, 'search result id');
}

function searchResultKey(value: string | number): string {
  return String(value);
}

function parseSearchResult(value: unknown): AgentSearchResult {
  const source = record(value);
  if (!source)
    throw responseError('Perplexity Agent search result was malformed.');
  const id = safeSearchResultId(source.id);
  const url = safeText(source.url, 'search result URL');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw responseError('Perplexity Agent search result URL was malformed.');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw responseError('Perplexity Agent search result URL was not HTTP(S).');
  }
  const title =
    source.title === undefined
      ? undefined
      : safeText(source.title, 'search result title');
  const snippet =
    source.snippet === undefined
      ? undefined
      : safeText(source.snippet, 'search result snippet');
  const sourceType =
    source.source === undefined
      ? undefined
      : safeIdentifier(source.source, 'search result source');
  return {
    id,
    url,
    ...(title === undefined ? {} : { title }),
    ...(snippet === undefined ? {} : { snippet }),
    ...(sourceType === undefined ? {} : { source: sourceType }),
  };
}

function parseOutput(value: unknown): {
  messages: string[];
  searchResults: AgentSearchResult[];
} {
  if (!Array.isArray(value)) {
    throw responseError('Perplexity Agent output was malformed.');
  }
  const messages: string[] = [];
  const searchResults: AgentSearchResult[] = [];
  const resultIds = new Set<string>();
  for (const itemValue of value) {
    const item = record(itemValue);
    if (!item || typeof item.type !== 'string') {
      throw responseError('Perplexity Agent output item was malformed.');
    }
    if (item.type === 'message') {
      if (!Array.isArray(item.content) || item.content.length === 0) {
        throw responseError('Perplexity Agent message content was malformed.');
      }
      const parts: string[] = [];
      for (const partValue of item.content) {
        const part = record(partValue);
        if (part?.type !== 'output_text' || typeof part.text !== 'string') {
          throw responseError('Perplexity Agent message part was malformed.');
        }
        parts.push(safeText(part.text, 'message text'));
      }
      messages.push(parts.join(''));
      continue;
    }
    if (item.type === 'search_results') {
      if (!Array.isArray(item.results)) {
        throw responseError('Perplexity Agent search results were malformed.');
      }
      for (const resultValue of item.results) {
        const result = parseSearchResult(resultValue);
        const resultKey = searchResultKey(result.id);
        if (resultIds.has(resultKey)) {
          throw responseError(
            'Perplexity Agent search result ids were duplicated.',
          );
        }
        resultIds.add(resultKey);
        searchResults.push(result);
      }
      continue;
    }
    if (!DOCUMENTED_NON_CONTENT_OUTPUT_TYPES.has(item.type)) {
      throw responseError('Perplexity Agent output type was unsupported.');
    }
  }
  return { messages, searchResults };
}

function citedResultIds(
  messages: readonly string[],
  results: readonly AgentSearchResult[],
): ReadonlySet<string> {
  const byId = new Map(
    results.map((result) => [searchResultKey(result.id), result]),
  );
  const cited = new Set<string>();
  const markerPattern = /\[([a-z][a-z0-9_-]*:)?(\d+)\]/gi;
  for (const message of messages) {
    for (const match of message.matchAll(markerPattern)) {
      const sourceType = match[1]?.slice(0, -1).toLowerCase();
      const result = byId.get(match[2] ?? '');
      if (!result) {
        throw responseError(
          'Perplexity Agent citation marker referenced an unknown result id.',
        );
      }
      if (sourceType !== undefined) {
        if (!SOURCE_TYPES.has(sourceType)) {
          throw responseError(
            'Perplexity Agent citation marker source type was malformed.',
          );
        }
        if (
          result.source !== undefined &&
          result.source.toLowerCase() !== sourceType
        ) {
          throw responseError(
            'Perplexity Agent citation marker source type did not match its result.',
          );
        }
      }
      cited.add(searchResultKey(result.id));
    }
  }
  return cited;
}

export function parseAgentResponse(
  value: unknown,
  expectedId?: string,
): ParsedAgentResponse {
  const root = record(value);
  if (!root)
    throw responseError('Perplexity Agent response was not an object.');
  const id = safeIdentifier(root.id, 'response id');
  if (expectedId !== undefined && id !== expectedId) {
    throw responseError(
      'Perplexity Agent response id did not match the task id.',
    );
  }
  const status = root.status;
  if (typeof status !== 'string' || !AGENT_STATUSES.has(status)) {
    throw responseError('Perplexity Agent response status was unknown.');
  }
  const model =
    root.model === undefined
      ? undefined
      : safeModelIdentifier(root.model, 'model');
  if (status === 'completed' && model === undefined) {
    throw responseError('Perplexity Agent completed response omitted model.');
  }
  const output =
    root.output === undefined ? undefined : parseOutput(root.output);
  if (status === 'completed' && output === undefined) {
    throw responseError('Perplexity Agent completed response omitted output.');
  }
  const messages = output?.messages ?? [];
  const searchResults = output?.searchResults ?? [];
  if (status === 'completed' && messages.length === 0) {
    throw responseError(
      'Perplexity Agent completed response omitted message text.',
    );
  }
  const cited = citedResultIds(messages, searchResults);

  let error: ParsedAgentResponse['error'];
  if (root.error !== undefined) {
    const errorRecord = record(root.error);
    if (!errorRecord)
      throw responseError('Perplexity Agent error was malformed.');
    const code =
      errorRecord.code === undefined
        ? undefined
        : safeIdentifier(errorRecord.code, 'error code');
    error = {
      ...(code === undefined ? {} : { code }),
      ...(errorRecord.message === undefined
        ? {}
        : { message: 'Perplexity Agent request failed.' }),
    };
  }
  const usage = root.usage === undefined ? undefined : parseUsage(root.usage);
  return {
    id,
    status: status as AgentStatus,
    ...(model === undefined ? {} : { model }),
    messages,
    searchResults: searchResults.filter((result) =>
      cited.has(searchResultKey(result.id)),
    ),
    ...(usage === undefined ? {} : { usage }),
    ...(error === undefined ? {} : { error }),
  };
}

function diagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactPerplexityError(message).slice(0, 240);
}

function failureKindForStatus(
  status: number,
): ProviderFailureDiagnostic['kind'] {
  if (status === 401) return 'authentication';
  if (status === 402) return 'billing';
  if (status === 403) return 'plan_required';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if ([400, 404, 409, 422].includes(status)) return 'invalid_request';
  return 'provider';
}

function failureDiagnostic(error: unknown): ProviderFailureDiagnostic {
  if (error instanceof HttpRequestTimeoutError) {
    return { kind: 'timeout' };
  }
  if (error instanceof HttpResponseTooLargeError) {
    return { kind: 'provider' };
  }
  if (
    error instanceof Error &&
    'kind' in error &&
    error.kind === 'agent_http' &&
    'httpStatus' in error &&
    typeof error.httpStatus === 'number'
  ) {
    return {
      kind: failureKindForStatus(error.httpStatus),
      httpStatus: error.httpStatus,
    };
  }
  if (
    error instanceof Error &&
    /fetch failed|failed to fetch|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(
      error.message,
    )
  ) {
    return { kind: 'network' };
  }
  if (error instanceof TypeError) return { kind: 'invalid_request' };
  return { kind: 'provider' };
}

const FAILURE_CODE_KINDS: Readonly<
  Record<string, ProviderFailureDiagnostic['kind']>
> = Object.freeze({
  authentication_error: 'authentication',
  invalid_api_key: 'authentication',
  unauthorized: 'authentication',
  permission_denied: 'plan_required',
  forbidden: 'plan_required',
  plan_required: 'plan_required',
  billing_error: 'billing',
  insufficient_credits: 'billing',
  payment_required: 'billing',
  rate_limit_error: 'rate_limit',
  rate_limit_exceeded: 'rate_limit',
  invalid_request_error: 'invalid_request',
  validation_error: 'invalid_request',
  bad_request: 'invalid_request',
});

function responseFailureDiagnostic(
  response: ParsedAgentResponse,
): ProviderFailureDiagnostic {
  const code = response.error?.code?.toLowerCase();
  return { kind: (code && FAILURE_CODE_KINDS[code]) || 'provider' };
}

export function redactPerplexityError(text: string, secret?: string): string {
  let redacted = text;
  if (secret) redacted = redacted.replaceAll(secret, '[REDACTED]');
  redacted = redacted.replace(/Bearer\s+[^\s,}]+/gi, 'Bearer [REDACTED]');
  redacted = redacted.replace(
    /((?:api[_-]?key|access[_-]?token|authorization|token|secret)\s*[:=]\s*["']?)[^\s,"'}]+/gi,
    '$1[REDACTED]',
  );
  redacted = redacted.replace(
    /(?:https?|file):\/\/[^\s,)}\]]+/gi,
    '[REDACTED_URL]',
  );
  redacted = redacted.replace(
    /(^|\s)(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+|[A-Za-z]:\\[^\s,)}\]]+)/g,
    '$1[REDACTED_PATH]',
  );
  return redacted.replace(/\s+/g, ' ').trim();
}

function httpError(status: number): AgentResponseError {
  return Object.assign(
    responseError(
      `Perplexity Agent API returned HTTP ${status}.`,
      'agent_http',
    ),
    { httpStatus: status },
  );
}

async function postAgentPayload(
  transport: AgentTransport,
  input: AgentInput,
  preset: string,
  model: string | undefined,
  background: boolean,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const body = buildAgentRequest(input, preset, model, background);
  const apiKey = transport.getApiKey();
  const response = await transport.request<unknown>(AGENT_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
    timeout: timeoutMs,
    signal,
    retry: { mode: 'never' },
  });
  if (response.status < 200 || response.status >= 300) {
    throw httpError(response.status);
  }
  return response.data;
}

async function postAgent(
  transport: AgentTransport,
  input: AgentInput,
  preset: string,
  model: string | undefined,
  background: boolean,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<ParsedAgentResponse> {
  const value = await postAgentPayload(
    transport,
    input,
    preset,
    model,
    background,
    signal,
    timeoutMs,
  );
  try {
    return parseAgentResponse(value);
  } catch (error) {
    throw responseError(
      `Perplexity Agent response was malformed: ${diagnostic(error)}`,
    );
  }
}

async function submitAgent(
  transport: AgentTransport,
  input: AgentInput,
  preset: string,
  model: string | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{
  readonly id: string;
  readonly status?: AgentStatus;
  readonly failureDiagnostic?: ProviderFailureDiagnostic;
}> {
  const value = await postAgentPayload(
    transport,
    input,
    preset,
    model,
    true,
    signal,
    timeoutMs,
  );
  const root = record(value);
  if (!root)
    throw responseError('Perplexity Agent response was not an object.');
  const id = safeIdentifier(root.id, 'response id');
  const status =
    typeof root.status === 'string' && AGENT_STATUSES.has(root.status)
      ? (root.status as AgentStatus)
      : undefined;
  const diagnostic =
    status === 'failed' || status === 'incomplete'
      ? (() => {
          try {
            return responseFailureDiagnostic(parseAgentResponse(value));
          } catch {
            return { kind: 'provider' as const };
          }
        })()
      : undefined;
  return {
    id,
    ...(status === undefined ? {} : { status }),
    ...(diagnostic === undefined ? {} : { failureDiagnostic: diagnostic }),
  };
}

async function getAgent(
  transport: AgentTransport,
  taskId: string,
  timeoutMs: number,
): Promise<ParsedAgentResponse> {
  safeIdentifier(taskId, 'task id');
  const apiKey = transport.getApiKey();
  const response = await transport.request<unknown>(
    `${AGENT_API_URL}/${encodeURIComponent(taskId)}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: timeoutMs,
    },
  );
  if (response.status !== 200) throw httpError(response.status);
  try {
    return parseAgentResponse(response.data, taskId);
  } catch (error) {
    throw responseError(
      `Perplexity Agent response was malformed: ${diagnostic(error)}`,
    );
  }
}

async function cancelAgent(
  transport: AgentTransport,
  taskId: string,
): Promise<ParsedAgentResponse> {
  safeIdentifier(taskId, 'task id');
  const apiKey = transport.getApiKey();
  const response = await transport.request<unknown>(
    `${AGENT_API_URL}/${encodeURIComponent(taskId)}/cancel`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      retry: { mode: 'never' },
    },
  );
  if (response.status < 200 || response.status >= 300) {
    throw httpError(response.status);
  }
  try {
    return parseAgentResponse(response.data, taskId);
  } catch (error) {
    throw responseError(
      `Perplexity Agent cancel response was malformed: ${diagnostic(error)}`,
    );
  }
}

function toUsage(
  usage: ParsedAgentUsage | undefined,
): ProviderUsage | undefined {
  if (!usage) return undefined;
  return {
    ...(usage.inputTokens === undefined
      ? {}
      : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined
      ? {}
      : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined
      ? {}
      : { totalTokens: usage.totalTokens }),
    ...(usage.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: usage.cacheReadInputTokens }),
    ...(usage.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: usage.cacheWriteInputTokens }),
    ...(usage.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: usage.reasoningTokens }),
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
    raw: usage.raw,
  };
}

function resultFromResponse(
  provider: string,
  tier: ProviderResult['tier'],
  response: ParsedAgentResponse,
  durationMs: number,
): ProviderResult {
  if (response.status !== 'completed') {
    const statusMessage =
      response.status === 'incomplete'
        ? 'Perplexity Agent task was incomplete.'
        : `Perplexity Agent task was not completed (status: ${response.status}).`;
    return {
      provider,
      tier,
      content: '',
      citations: [],
      durationMs,
      error: redactPerplexityError(statusMessage),
      failureDiagnostic: responseFailureDiagnostic(response),
    };
  }
  return {
    provider,
    tier,
    content: response.messages.join(''),
    citations: response.searchResults.map(
      (result): Citation => ({
        url: result.url,
        provider,
        providerReference: String(result.id),
        ...(result.title === undefined ? {} : { title: result.title }),
        ...(result.snippet === undefined ? {} : { snippet: result.snippet }),
      }),
    ),
    durationMs,
    ...(response.model === undefined ? {} : { model: response.model }),
    tokenUsage: {
      ...(response.usage?.inputTokens === undefined
        ? {}
        : { input: response.usage.inputTokens }),
      ...(response.usage?.outputTokens === undefined
        ? {}
        : { output: response.usage.outputTokens }),
    },
    usage: toUsage(response.usage),
  };
}

function pollResult(response: ParsedAgentResponse): AsyncPollResult {
  switch (response.status) {
    case 'queued':
      return { status: 'pending', rawStatus: response.status };
    case 'in_progress':
      return { status: 'running', rawStatus: response.status };
    case 'cancelling':
      return { status: 'running', rawStatus: response.status };
    case 'completed':
      return { status: 'completed', rawStatus: response.status, progress: 100 };
    case 'cancelled':
      return {
        status: 'cancelled',
        rawStatus: response.status,
        message: 'Perplexity Agent task was cancelled.',
      };
    case 'incomplete':
      return {
        status: 'failed',
        rawStatus: response.status,
        message: 'Perplexity Agent task was incomplete.',
        failureDiagnostic: responseFailureDiagnostic(response),
      };
    case 'failed':
      return {
        status: 'failed',
        rawStatus: response.status,
        message: 'Perplexity Agent task failed.',
        failureDiagnostic: responseFailureDiagnostic(response),
      };
  }
}

function transportFor(
  request: <T = unknown>(
    url: string,
    options?: HttpRequestOptions,
  ) => Promise<HttpResponse<T>>,
  getApiKey: () => string,
): AgentTransport {
  return { request, getApiKey };
}

function validateCall(
  preset: string,
  query: string,
  options: ProviderOptions,
): void {
  buildAgentRequest(query, preset, undefined, false);
  if (
    typeof options.timeout !== 'number' ||
    !Number.isFinite(options.timeout) ||
    options.timeout <= 0
  ) {
    throw new TypeError(
      'Perplexity Agent timeout must be a positive finite number.',
    );
  }
}

function validateModelOverride(model: string | undefined): string | undefined {
  const normalized = model?.trim() || undefined;
  if (normalized !== undefined && !SAFE_MODEL_IDENTIFIER.test(normalized)) {
    throw new TypeError('Perplexity Agent model override was malformed.');
  }
  return normalized;
}

/** Shared durable Agent API adapter for the canonical research profiles. */
export abstract class PerplexityAgentBaseProvider extends BackgroundBaseProvider {
  abstract readonly preset: string;
  private readonly underlyingModel?: string;

  constructor(options: BaseProviderOptions & { model?: string } = {}) {
    super(options);
    this.underlyingModel = validateModelOverride(options.model);
  }

  private transport(): AgentTransport {
    return transportFor(
      (url, options) => this.request(url, options),
      () => this.getApiKey(),
    );
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const started = performance.now();
    try {
      validateCall(this.preset, query, options);
      const response = await postAgent(
        this.transport(),
        query,
        this.preset,
        this.underlyingModel,
        false,
        options.signal,
        options.timeout * 1000,
      );
      return resultFromResponse(
        this.id,
        this.tier,
        response,
        Math.round(performance.now() - started),
      );
    } catch (error) {
      if (error instanceof HttpRequestAbortedError) throw error;
      return {
        provider: this.id,
        tier: this.tier,
        content: '',
        citations: [],
        durationMs: Math.round(performance.now() - started),
        error: 'Perplexity Agent request failed.',
        failureDiagnostic: failureDiagnostic(error),
      };
    }
  }

  async submit(
    query: string,
    options: ProviderOptions,
  ): Promise<AsyncTaskHandle> {
    try {
      validateCall(this.preset, query, options);
      const response = await submitAgent(
        this.transport(),
        query,
        this.preset,
        this.underlyingModel,
        options.signal,
        options.timeout * 1000,
      );
      const status = response.status
        ? pollResult({
            id: response.id,
            status: response.status,
            messages: [],
            searchResults: [],
          }).status
        : 'pending';
      return {
        provider: this.id,
        taskId: response.id,
        query,
        submittedAt: Date.now(),
        status,
        providerStatus: response.status ?? 'accepted_unknown',
        ...(response.failureDiagnostic === undefined
          ? {}
          : { failureDiagnostic: response.failureDiagnostic }),
      };
    } catch (error) {
      void error;
      throw new UnsafeToRetrySubmissionError(
        'Perplexity Agent submission outcome is unknown.',
      );
    }
  }

  async poll(handle: AsyncTaskHandle): Promise<AsyncPollResult> {
    try {
      return pollResult(
        await getAgent(this.transport(), handle.taskId, 15_000),
      );
    } catch {
      throw responseError('Perplexity Agent status check failed.');
    }
  }

  async retrieve(handle: AsyncTaskHandle): Promise<ProviderResult> {
    const started = performance.now();
    try {
      const response = await getAgent(this.transport(), handle.taskId, 30_000);
      return resultFromResponse(
        this.id,
        this.tier,
        response,
        Math.round(performance.now() - started),
      );
    } catch (error) {
      if (error instanceof HttpRequestAbortedError) throw error;
      return {
        provider: this.id,
        tier: this.tier,
        content: '',
        citations: [],
        durationMs: Math.round(performance.now() - started),
        error: 'Perplexity Agent retrieval failed.',
        failureDiagnostic: failureDiagnostic(error),
      };
    }
  }

  async cancel(handle: AsyncTaskHandle): Promise<AsyncPollResult> {
    try {
      return pollResult(await cancelAgent(this.transport(), handle.taskId));
    } catch {
      throw responseError('Perplexity Agent cancellation failed.');
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      validateCall(this.preset, 'ping', { timeout: 15 });
      const response = await postAgent(
        this.transport(),
        'ping',
        this.preset,
        this.underlyingModel,
        false,
        undefined,
        15_000,
      );
      if (response.status !== 'completed') {
        return {
          ok: false,
          error: 'Perplexity Agent health check was not completed.',
        };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: 'Perplexity Agent health check failed.' };
    }
  }
}

/** Shared inline Agent API adapter for the canonical grounded profile. */
export abstract class PerplexityAgentInlineProvider extends BaseProvider {
  abstract readonly preset: string;
  private readonly underlyingModel?: string;

  constructor(options: BaseProviderOptions & { model?: string } = {}) {
    super(options);
    this.underlyingModel = validateModelOverride(options.model);
  }

  private transport(): AgentTransport {
    return transportFor(
      (url, options) => this.request(url, options),
      () => this.getApiKey(),
    );
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const started = performance.now();
    try {
      validateCall(this.preset, query, options);
      const response = await postAgent(
        this.transport(),
        query,
        this.preset,
        this.underlyingModel,
        false,
        options.signal,
        options.timeout * 1000,
      );
      return resultFromResponse(
        this.id,
        this.tier,
        response,
        Math.round(performance.now() - started),
      );
    } catch (error) {
      if (error instanceof HttpRequestAbortedError) throw error;
      return {
        provider: this.id,
        tier: this.tier,
        content: '',
        citations: [],
        durationMs: Math.round(performance.now() - started),
        error: 'Perplexity Agent request failed.',
        failureDiagnostic: failureDiagnostic(error),
      };
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      validateCall(this.preset, 'ping', { timeout: 15 });
      const response = await postAgent(
        this.transport(),
        'ping',
        this.preset,
        this.underlyingModel,
        false,
        undefined,
        15_000,
      );
      return response.status === 'completed'
        ? { ok: true }
        : {
            ok: false,
            error: 'Perplexity Agent health check was not completed.',
          };
    } catch {
      return { ok: false, error: 'Perplexity Agent health check failed.' };
    }
  }
}
