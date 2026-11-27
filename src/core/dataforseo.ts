import { z } from 'zod';
import type { Citation, ProviderResult, SearchResultItem } from '../types.js';

/**
 * DataForSEO task families, ported from the PHP `DataForSeoDriver` so both
 * languages call the same endpoints with the same controls and produce the
 * same Run. Standard profiles are durable `task_post` / `task_get` tasks; live
 * profiles make one synchronous call.
 */
export interface DataForSeoDescriptor {
  readonly family: string;
  readonly surface:
    | 'chatgpt'
    | 'gemini'
    | 'google_ai_mode'
    | 'claude'
    | 'perplexity';
  readonly mode: 'standard' | 'live';
  readonly api: 'ai_optimization' | 'serp';
  readonly se: string;
  readonly seAliases?: readonly string[];
  readonly seType: 'llm_responses' | 'llm_scraper' | 'ai_mode';
  readonly maxChars: number;
}

const scraper = (
  surface: 'chatgpt' | 'gemini',
  mode: 'standard' | 'live',
): DataForSeoDescriptor => ({
  family: `ai_optimization/${surface === 'chatgpt' ? 'chat_gpt' : 'gemini'}/llm_scraper`,
  surface,
  mode,
  api: 'ai_optimization',
  se: surface === 'chatgpt' ? 'chat_gpt' : 'gemini',
  ...(surface === 'chatgpt' && { seAliases: ['chatgpt'] }),
  seType: 'llm_scraper',
  maxChars: 2000,
});
const aiMode = (mode: 'standard' | 'live'): DataForSeoDescriptor => ({
  family: 'serp/google/ai_mode',
  surface: 'google_ai_mode',
  mode,
  api: 'serp',
  se: 'google',
  seType: 'ai_mode',
  maxChars: 700,
});
const llm = (
  surface: 'chatgpt' | 'claude' | 'perplexity' | 'gemini',
): DataForSeoDescriptor => {
  const se = surface === 'chatgpt' ? 'chat_gpt' : surface;
  return {
    family: `ai_optimization/${se}/llm_responses`,
    surface,
    mode: 'live',
    api: 'ai_optimization',
    se,
    seType: 'llm_responses',
    maxChars: 500,
  };
};

/** Adapter id -> task family. Adapter ids match the PHP profile ids. */
export const DATAFORSEO_DESCRIPTORS = {
  'dataforseo-chatgpt': scraper('chatgpt', 'standard'),
  'dataforseo-chatgpt-live': scraper('chatgpt', 'live'),
  'dataforseo-gemini': scraper('gemini', 'standard'),
  'dataforseo-gemini-live': scraper('gemini', 'live'),
  'dataforseo-google-ai-mode': aiMode('standard'),
  'dataforseo-google-ai-mode-live': aiMode('live'),
  'dataforseo-llm-chatgpt': llm('chatgpt'),
  'dataforseo-llm-claude': llm('claude'),
  'dataforseo-llm-perplexity': llm('perplexity'),
  'dataforseo-llm-gemini': llm('gemini'),
} as const satisfies Record<string, DataForSeoDescriptor>;
export type DataForSeoAdapterId = keyof typeof DATAFORSEO_DESCRIPTORS;

/** The default `model_name` per LLM Responses platform, as in PHP. */
export const DATAFORSEO_LLM_DEFAULT_MODELS = {
  'dataforseo-llm-chatgpt': 'gpt-4.1-mini',
  'dataforseo-llm-claude': 'claude-opus-5',
  'dataforseo-llm-perplexity': 'sonar-pro',
  'dataforseo-llm-gemini': 'gemini-2.5-flash',
} as const;

const location = {
  // Required for every request, but checked when the task is built so an
  // unconfigured, unselected adapter does not warn at startup.
  locationCode: z.number().int().min(1).optional(),
  languageCode: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,31}$/i)
    .optional(),
};
const country = z.string().regex(/^[A-Z]{2}$/);
const city = z.string().trim().min(1).max(255);

export const DataForSeoChatGptScraperOptionsSchema = z
  .object({ ...location, forceWebSearch: z.boolean().default(true) })
  .strict();
export const DataForSeoGeminiScraperOptionsSchema = z.object(location).strict();
export const DataForSeoAiModeOptionsSchema = z
  .object({
    ...location,
    device: z.enum(['desktop', 'mobile']).optional(),
    os: z.enum(['windows', 'macos', 'android', 'ios']).optional(),
  })
  .strict()
  .superRefine((options, ctx) => {
    const { device, os } = options;
    if (device === undefined && os === undefined) return;
    const valid =
      (device === 'desktop' && (os === 'windows' || os === 'macos')) ||
      (device === 'mobile' && (os === 'android' || os === 'ios'));
    if (!valid)
      ctx.addIssue({
        code: 'custom',
        path: ['os'],
        message: 'device and os must be a compatible pair',
      });
  });
const tokens = (min: number) =>
  z.number().int().min(min).max(4096).default(2048);
export const DataForSeoLlmOptionsSchemas = {
  'dataforseo-llm-chatgpt': z
    .object({
      maxOutputTokens: tokens(16),
      forceWebSearch: z.boolean().optional(),
      webSearchCountryIsoCode: country.optional(),
      webSearchCity: city.optional(),
    })
    .strict(),
  'dataforseo-llm-claude': z
    .object({
      maxOutputTokens: tokens(1),
      forceWebSearch: z.boolean().optional(),
      webSearchCountryIsoCode: country.optional(),
      webSearchCity: city.optional(),
    })
    .strict(),
  'dataforseo-llm-perplexity': z
    .object({
      maxOutputTokens: tokens(1),
      webSearchCountryIsoCode: country.optional(),
    })
    .strict(),
  'dataforseo-llm-gemini': z.object({ maxOutputTokens: tokens(1) }).strict(),
} as const;

export function dataForSeoOptionsSchema(id: DataForSeoAdapterId): z.ZodTypeAny {
  if (id in DataForSeoLlmOptionsSchemas)
    return DataForSeoLlmOptionsSchemas[
      id as keyof typeof DataForSeoLlmOptionsSchemas
    ];
  const surface = DATAFORSEO_DESCRIPTORS[id].surface;
  return surface === 'chatgpt'
    ? DataForSeoChatGptScraperOptionsSchema
    : surface === 'gemini'
      ? DataForSeoGeminiScraperOptionsSchema
      : DataForSeoAiModeOptionsSchema;
}

/** PHP `rawurlencode`: RFC 3986 encoding of everything but unreserved. */
export function rawUrlEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The one task body DataForSEO receives, in its own snake_case names. */
export function dataForSeoTask(
  id: DataForSeoAdapterId,
  prompt: string,
  options: Record<string, unknown>,
  model?: string,
): Record<string, string | number | boolean> {
  const descriptor = DATAFORSEO_DESCRIPTORS[id];
  if (prompt === '' || [...prompt].length > descriptor.maxChars)
    throw new DataForSeoError(
      'invalid_request',
      `The DataForSEO query must contain 1 to ${descriptor.maxChars} characters.`,
    );
  if (descriptor.seType === 'llm_responses') {
    const modelName =
      model?.trim() ||
      DATAFORSEO_LLM_DEFAULT_MODELS[
        id as keyof typeof DATAFORSEO_LLM_DEFAULT_MODELS
      ];
    return {
      user_prompt: prompt,
      model_name: modelName,
      web_search: true,
      max_output_tokens: options.maxOutputTokens as number,
      ...(options.forceWebSearch !== undefined && {
        force_web_search: options.forceWebSearch as boolean,
      }),
      ...(options.webSearchCountryIsoCode !== undefined && {
        web_search_country_iso_code: options.webSearchCountryIsoCode as string,
      }),
      ...(options.webSearchCity !== undefined && {
        web_search_city: options.webSearchCity as string,
      }),
    };
  }
  return {
    keyword: rawUrlEncode(prompt),
    ...controls(options),
  };
}

function controls(options: Record<string, unknown>) {
  if (options.locationCode === undefined || options.languageCode === undefined)
    throw new DataForSeoError(
      'invalid_request',
      'DataForSEO requires the locationCode and languageCode options.',
    );
  return {
    location_code: options.locationCode as number,
    language_code: options.languageCode as string,
    ...(options.forceWebSearch !== undefined && {
      force_web_search: options.forceWebSearch as boolean,
    }),
    ...(options.device !== undefined && { device: options.device as string }),
    ...(options.os !== undefined && { os: options.os as string }),
  };
}

export type DataForSeoErrorKind =
  | 'authentication'
  | 'billing'
  | 'invalid_request'
  | 'rate_limit'
  | 'provider'
  | 'expired';

/** Safe, bounded DataForSEO failure. Messages never carry provider bodies. */
export class DataForSeoError extends Error {
  constructor(
    readonly kind: DataForSeoErrorKind,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'DataForSeoError';
  }
}

const invalid = (message: string) => new DataForSeoError('provider', message);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PENDING = new Set([40601, 40602]);

export type DataForSeoReceipt = Record<string, unknown> & {
  id: string;
  status_code: unknown;
  _api_version?: unknown;
};

/** Task status codes that mean the task was not created or did not finish. */
export function dataForSeoTaskFailure(status: unknown): DataForSeoError {
  if (status === 40400 || status === 40401)
    return new DataForSeoError(
      'expired',
      'DataForSEO no longer has the submitted task result.',
    );
  if (status === 40200 || status === 40210)
    return new DataForSeoError(
      'billing',
      'DataForSEO reported insufficient account funds.',
    );
  if (status === 40100 || status === 40104)
    return new DataForSeoError(
      'authentication',
      'DataForSEO rejected the configured credentials.',
    );
  return new DataForSeoError(
    typeof status === 'number' && status >= 40000 && status < 50000
      ? 'invalid_request'
      : 'provider',
    'DataForSEO rejected or could not complete the task.',
  );
}

export function isDataForSeoPending(receipt: DataForSeoReceipt): boolean {
  if (!PENDING.has(receipt.status_code as number)) return false;
  const count = receipt.result_count;
  if (
    (count !== undefined && count !== null && count !== 0) ||
    (receipt.result ?? null) !== null
  )
    throw invalid('DataForSEO returned a contradictory pending task receipt.');
  return true;
}

/**
 * Validate one response envelope exactly as PHP does: one task, consistent
 * counts, the expected endpoint path and request identity, and no echo of the
 * credential anywhere in the body.
 */
export function dataForSeoReceipt(input: {
  readonly id: DataForSeoAdapterId;
  readonly status: number;
  readonly body: unknown;
  readonly operation: string;
  readonly credential: string;
  readonly expectedStatus?: number;
  readonly expectedId?: string;
  /** The submitted prompt; absent when retrieving after a restart. */
  readonly prompt?: string;
  readonly options: Record<string, unknown>;
  readonly model?: string;
}): DataForSeoReceipt {
  const descriptor = DATAFORSEO_DESCRIPTORS[input.id];
  if (input.status === 401)
    throw new DataForSeoError(
      'authentication',
      'DataForSEO rejected the configured credentials.',
      401,
    );
  if (input.status === 402)
    throw new DataForSeoError(
      'billing',
      'DataForSEO reported insufficient account funds.',
      402,
    );
  if (input.status === 429)
    throw new DataForSeoError(
      'rate_limit',
      'DataForSEO rate-limited the request.',
      429,
    );
  if (input.status < 200 || input.status >= 300)
    throw new DataForSeoError(
      'provider',
      `DataForSEO returned HTTP ${input.status}.`,
      input.status,
    );
  const json = record(input.body);
  const tasks = json?.tasks;
  if (
    !json ||
    json.status_code !== 20000 ||
    !Array.isArray(tasks) ||
    tasks.length !== 1 ||
    !record(tasks[0])
  )
    throw invalid('DataForSEO returned an invalid response envelope.');
  const [login, password] = splitCredential(input.credential);
  const secrets = [
    input.credential,
    login,
    password,
    btoa(
      Array.from(new TextEncoder().encode(input.credential), (byte) =>
        String.fromCharCode(byte),
      ).join(''),
    ),
  ].filter((secret): secret is string => !!secret);
  if (reflects(json, secrets))
    throw invalid('DataForSEO returned unsafe response content.');
  const receipt = {
    ...(tasks[0] as Record<string, unknown>),
  } as DataForSeoReceipt;
  const pending = PENDING.has(receipt.status_code as number);
  const count = json.tasks_count ?? null;
  const errors = json.tasks_error ?? null;
  if (
    (pending &&
      (![null, 1].includes(count as never) ||
        ![null, 0, 1].includes(errors as never))) ||
    (!pending && (count !== 1 || errors !== 0))
  )
    throw invalid('DataForSEO returned contradictory task counts.');
  if (
    typeof receipt.id !== 'string' ||
    !UUID.test(receipt.id) ||
    (input.expectedId !== undefined && receipt.id !== input.expectedId)
  )
    throw invalid('DataForSEO returned a mismatched task identifier.');
  if (
    input.expectedStatus !== undefined &&
    receipt.status_code !== input.expectedStatus
  )
    throw dataForSeoTaskFailure(receipt.status_code);
  if (!pending || receipt.path != null)
    assertPath(
      receipt.path,
      descriptor.family,
      input.operation,
      input.expectedId,
    );
  if (!pending || receipt.data != null) assertIdentity(receipt.data, input);
  receipt._api_version = json.version;
  return receipt;
}

function assertPath(
  path: unknown,
  family: string,
  operation: string,
  id?: string,
) {
  const expected = ['v3', ...family.split('/'), ...operation.split('/')];
  const accepted = [expected];
  if (family === 'ai_optimization/chat_gpt/llm_scraper') {
    const alias = [...expected];
    alias[2] = 'chatgpt';
    accepted.push(alias);
  }
  if (id !== undefined && expected.at(-1) === id)
    for (const candidate of [...accepted])
      accepted.push(candidate.slice(0, -1));
  if (
    !Array.isArray(path) ||
    !accepted.some(
      (candidate) => JSON.stringify(candidate) === JSON.stringify(path),
    )
  )
    throw invalid(
      'DataForSEO returned a receipt from an unexpected endpoint path.',
    );
}

function assertIdentity(
  value: unknown,
  input: Parameters<typeof dataForSeoReceipt>[0],
) {
  const descriptor = DATAFORSEO_DESCRIPTORS[input.id];
  const data = record(value);
  if (descriptor.seType === 'llm_responses') {
    if (
      !data ||
      data.api !== 'ai_optimization' ||
      data.function !== 'llm_responses' ||
      data.se !== descriptor.se ||
      input.prompt === undefined ||
      data.user_prompt !== input.prompt
    )
      throw invalid(
        'DataForSEO returned a receipt for a different LLM Responses task.',
      );
    const task = dataForSeoTask(
      input.id,
      input.prompt,
      input.options,
      input.model,
    );
    for (const [key, expected] of Object.entries(task))
      if (key !== 'user_prompt' && key in data && data[key] !== expected)
        throw invalid('DataForSEO returned mismatched LLM Responses controls.');
    return;
  }
  const functions =
    descriptor.api === 'ai_optimization' &&
    descriptor.surface === 'chatgpt' &&
    input.operation === 'task_post'
      ? ['task_post', 'llm_scraper']
      : descriptor.api === 'ai_optimization' &&
          input.operation.startsWith('live')
        ? ['llm_scraper', 'live'] // Live receipts echo `live` since API 0.1.20261022.
        : descriptor.api === 'ai_optimization'
          ? ['llm_scraper']
          : input.operation === 'task_post'
            ? ['task_post']
            : input.operation.startsWith('task_get/')
              ? ['task_get']
              : ['live'];
  const keyword = data?.keyword;
  const keywordValid =
    typeof keyword === 'string' &&
    keyword.trim() !== '' &&
    (input.prompt !== undefined
      ? keyword === input.prompt || keyword === rawUrlEncode(input.prompt)
      : [...keyword].length <= descriptor.maxChars ||
        (decoded(keyword) !== undefined &&
          rawUrlEncode(decoded(keyword) as string) === keyword &&
          [...(decoded(keyword) as string)].length <= descriptor.maxChars));
  if (
    !data ||
    data.api !== descriptor.api ||
    !functions.includes(data.function as string) ||
    ![descriptor.se, ...(descriptor.seAliases ?? [])].includes(
      data.se as string,
    ) ||
    ((descriptor.api === 'serp' || 'se_type' in data) &&
      data.se_type !== descriptor.seType) ||
    !keywordValid ||
    data.location_code !== input.options.locationCode ||
    data.language_code !== input.options.languageCode
  )
    throw invalid(
      'DataForSEO returned a receipt for a different task family or request.',
    );
  for (const [control, key] of [
    ['force_web_search', 'forceWebSearch'],
    ['device', 'device'],
    ['os', 'os'],
  ] as const)
    if (
      input.options[key] !== undefined &&
      control in data &&
      data[control] !== input.options[key]
    )
      throw invalid(
        'DataForSEO returned a receipt with mismatched request controls.',
      );
}

/** The single completed result, checked against the request controls. */
export function dataForSeoCompletedResult(
  id: DataForSeoAdapterId,
  receipt: DataForSeoReceipt,
  options: Record<string, unknown>,
  prompt?: string,
): Record<string, unknown> {
  const results = receipt.result;
  if (
    receipt.result_count !== 1 ||
    !Array.isArray(results) ||
    results.length !== 1 ||
    !record(results[0])
  )
    throw invalid('DataForSEO returned an invalid completed task result.');
  const result = results[0] as Record<string, unknown>;
  if (DATAFORSEO_DESCRIPTORS[id].seType === 'llm_responses') return result;
  const expected =
    prompt ?? (record(receipt.data)?.keyword as string | undefined);
  const accepted = typeof expected === 'string' ? [expected] : [];
  if (prompt !== undefined) accepted.push(rawUrlEncode(prompt));
  else if (typeof expected === 'string') {
    const plain = decoded(expected);
    if (plain !== undefined && rawUrlEncode(plain) === expected)
      accepted.push(plain);
  }
  if (
    typeof expected !== 'string' ||
    expected.trim() === '' ||
    !accepted.includes(result.keyword as string) ||
    result.location_code !== options.locationCode ||
    result.language_code !== options.languageCode
  )
    throw invalid(
      'DataForSEO returned a result for different request controls.',
    );
  return result;
}

/** An exact decimal from a JSON number or string, as PHP `decimal()`. */
export function dataForSeoCost(value: unknown): string | undefined {
  const pattern = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;
  if (typeof value === 'string') return pattern.test(value) ? value : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const encoded = Number.isInteger(value) ? `${value}.0` : String(value);
  return pattern.test(encoded) ? encoded : undefined;
}

/** Map a completed result as PHP `DataForSeoResultMapper` does. */
export function mapDataForSeoResult(input: {
  readonly id: DataForSeoAdapterId;
  readonly result: Record<string, unknown>;
  readonly receipt: DataForSeoReceipt;
  readonly cost?: string;
  readonly durationMs: number;
  readonly options: Record<string, unknown>;
  readonly model?: string;
}): ProviderResult {
  const descriptor = DATAFORSEO_DESCRIPTORS[input.id];
  const llm = descriptor.seType === 'llm_responses';
  observedAt(input.result.datetime);
  const normalized = llm
    ? normalizeResponses(input.result, input.id)
    : descriptor.surface === 'google_ai_mode'
      ? normalizeAiMode(input.result, input.id)
      : normalizeScraper(
          input.result,
          descriptor.surface as 'chatgpt' | 'gemini',
          input.id,
        );
  if (normalized.content === '')
    throw invalid('DataForSEO returned no supported answer content.');
  const model = text(input.result[llm ? 'model_name' : 'model']);
  const fanOut = strings(input.result.fan_out_queries);
  const searchResults =
    llm || descriptor.surface === 'chatgpt'
      ? searchResultItems(input.result, llm)
      : undefined;
  return {
    provider: input.id,
    tier: 'ai-grounded',
    content: normalized.content,
    citations: normalized.citations,
    ...(searchResults && { searchResults }),
    durationMs: input.durationMs,
    ...(model && { model }),
    ...(input.cost !== undefined && {
      usage: { costUsdDecimal: input.cost, costUsd: Number(input.cost) },
    }),
    providerMeta: {
      'dataforseo:endpoint_family': descriptor.family,
      'dataforseo:mode': descriptor.mode,
      ...(typeof input.receipt.id === 'string' && {
        'dataforseo:task_id': input.receipt.id,
      }),
      ...(text(input.receipt._api_version) && {
        'dataforseo:api_version': text(input.receipt._api_version)?.slice(
          0,
          64,
        ),
      }),
      ...(typeof input.receipt.status_code === 'number' && {
        'dataforseo:task_status_code': input.receipt.status_code,
      }),
      ...(input.cost !== undefined && {
        'dataforseo:reported_cost': input.cost,
      }),
      ...(fanOut.length > 0 && { 'dataforseo:fan_out_queries': fanOut }),
      ...(normalized.omitted.length > 0 && {
        'dataforseo:omitted_item_types': normalized.omitted,
      }),
    },
  };
}

interface Normalized {
  content: string;
  citations: Citation[];
  omitted: string[];
}

function normalizeResponses(
  result: Record<string, unknown>,
  provider: string,
): Normalized {
  const parts: string[] = [];
  const annotations: Record<string, unknown>[] = [];
  for (const item of records(result.items)) {
    if (item.type !== 'message') continue;
    for (const section of records(item.sections)) {
      if (section.type !== 'text') continue;
      parts.push(text(section.text) ?? '');
      annotations.push(...records(section.annotations));
    }
  }
  return {
    content: parts.join('\n\n'),
    citations: citations(annotations, undefined, provider),
    omitted: [],
  };
}

function normalizeScraper(
  result: Record<string, unknown>,
  surface: 'chatgpt' | 'gemini',
  provider: string,
): Normalized {
  const prefix = surface === 'chatgpt' ? 'chat_gpt' : 'gemini';
  const supported = [`${prefix}_text`, `${prefix}_table`];
  const items = records(result.items);
  let content = text(result.markdown);
  let omitted: string[] = [];
  if (content === undefined) {
    omitted = omittedTypes(items, supported);
    content = items
      .filter((item) => supported.includes(item.type as string))
      .map(
        (item) =>
          text(item.markdown) ?? text(item.original_text) ?? text(item.text),
      )
      .filter((value): value is string => !!value)
      .join('\n\n');
  }
  const sources = records(result.sources);
  for (const item of items)
    if (supported.includes(item.type as string))
      sources.push(...records(item.sources));
  return {
    content,
    citations: citations(sources, `${prefix}_source`, provider),
    omitted,
  };
}

function normalizeAiMode(
  result: Record<string, unknown>,
  provider: string,
): Normalized {
  const overview = records(result.items).find(
    (item) => item.type === 'ai_overview',
  );
  if (!overview) return { content: '', citations: [], omitted: [] };
  const elements = records(overview.items);
  const aggregate = text(overview.markdown);
  const content =
    aggregate ??
    elements
      .filter((item) => item.type === 'ai_overview_element')
      .map((item) => text(item.markdown))
      .filter((value): value is string => !!value)
      .join('\n\n');
  const references = records(overview.references);
  for (const element of elements)
    if (element.type === 'ai_overview_element')
      references.push(...records(element.references));
  return {
    content,
    citations: citations(references, 'ai_overview_reference', provider),
    omitted:
      aggregate === undefined
        ? omittedTypes(elements, ['ai_overview_element'])
        : [],
  };
}

function citations(
  candidates: Record<string, unknown>[],
  expectedType: string | undefined,
  provider: string,
): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const candidate of candidates) {
    if (expectedType !== undefined && candidate.type !== expectedType) continue;
    const url = evidenceUrl(candidate.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = text(candidate.title);
    const snippet = text(candidate.snippet ?? candidate.text);
    const publisher = text(candidate.source_name ?? candidate.source);
    const publishedAt = optionalDate(candidate.publication_date);
    out.push({
      url,
      provider,
      ...(title && { title }),
      ...(snippet && { snippet }),
      ...(publisher && { publisher }),
      ...(publishedAt && { publishedAt }),
      ...(Number.isInteger(candidate.start_index) &&
        Number.isInteger(candidate.end_index) && {
          locator: `characters:${candidate.start_index}-${candidate.end_index}`,
        }),
    });
  }
  return out;
}

function searchResultItems(
  result: Record<string, unknown>,
  llm: boolean,
): SearchResultItem[] | undefined {
  if (!Array.isArray(result.search_results)) return undefined;
  const out: SearchResultItem[] = [];
  for (const item of records(result.search_results)) {
    if (!llm && item.type !== 'chatgpt_search_result') continue;
    const url = evidenceUrl(item.url);
    if (!url) continue;
    const title = text(item.title);
    const snippet = text(item[llm ? 'snippet' : 'description']);
    const publishedAt = optionalDate(item.date);
    out.push({
      url,
      ...(title && { title }),
      ...(snippet && { snippet }),
      ...(publishedAt && { publishedAt }),
    });
  }
  return out;
}

function observedAt(value: unknown): void {
  const match =
    typeof value === 'string' &&
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))? \+00:00$/.exec(
      value,
    );
  if (!match)
    throw invalid('DataForSEO returned an invalid observation timestamp.');
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d ||
    date.getUTCHours() !== h ||
    date.getUTCMinutes() !== mi ||
    date.getUTCSeconds() !== s
  )
    throw invalid('DataForSEO returned an invalid observation timestamp.');
}

/** DataForSEO dates are `YYYY-MM-DD HH:MM:SS +00:00`; emit RFC 3339 UTC. */
function optionalDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const normalized = value.replace(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?) ?([+-]\d{2}:\d{2})$/,
    '$1T$2$3',
  );
  const time = Date.parse(normalized);
  if (Number.isNaN(time)) return undefined;
  return new Date(time).toISOString().replace('.000Z', 'Z');
}

function evidenceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || value.trim() !== value)
    return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      url.hostname !== '' &&
      !url.username &&
      !url.password
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function omittedTypes(
  items: Record<string, unknown>[],
  supported: string[],
): string[] {
  return [
    ...new Set(
      items
        .map((item) => text(item.type))
        .filter((type): type is string => !!type && !supported.includes(type)),
    ),
  ].slice(0, 20);
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => text(item)?.slice(0, 500))
    .filter((item): item is string => !!item)
    .slice(0, 20);
}

function decoded(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function reflects(value: unknown, secrets: string[]): boolean {
  if (typeof value === 'string')
    return secrets.some((secret) => value.includes(secret));
  if (Array.isArray(value))
    return value.some((item) => reflects(item, secrets));
  if (value && typeof value === 'object')
    return Object.values(value).some((item) => reflects(item, secrets));
  return false;
}

/** `login:password`; DataForSEO logins are email addresses and hold no colon. */
export function splitCredential(credential: string): [string, string] | [] {
  const index = credential.indexOf(':');
  if (index <= 0 || index === credential.length - 1) return [];
  return [credential.slice(0, index), credential.slice(index + 1)];
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!record(item))
    : [];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
