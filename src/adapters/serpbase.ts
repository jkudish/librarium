import { Rfc3339UtcSchema } from '../contracts/common.js';
import {
  HttpRequestAbortedError,
  HttpRequestTimeoutError,
} from '../core/http-client.js';
import { normalizeUrl } from '../core/normalizer.js';
import type {
  Citation,
  ProviderFailureDiagnostic,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import { BaseProvider, type BaseProviderOptions } from './base.js';
import {
  type SerpBaseNewsOptions,
  SerpBaseNewsOptionsSchema,
  type SerpBaseSearchOptions,
  SerpBaseSearchOptionsSchema,
} from './serpbase-options.js';

type SerpBaseKind = 'search' | 'news';
type SerpBaseAdapterId = 'serpbase-search' | 'serpbase-news';

interface SerpBaseProviderOptions extends BaseProviderOptions {
  creditUsd?: unknown;
  hl?: unknown;
  gl?: unknown;
  page?: unknown;
  device?: unknown;
  includeRichResults?: unknown;
}

interface NormalizedResult {
  rank: number;
  title: string;
  url: string;
  snippet?: string;
  publisher?: string;
  time?: string;
  publishedAt?: string;
}

interface ParsedSuccess {
  data: Record<string, unknown>;
  results: NormalizedResult[];
  usage: ProviderUsage;
}

const BASE_URL = 'https://api.serpbase.dev/google';
const RICH_SECTIONS = [
  ['featured_snippet', 'Featured Snippet'],
  ['top_stories', 'Top Stories'],
  ['knowledge_graph', 'Knowledge Graph'],
] as const;
const MAX_RICH_DEPTH = 4;
const MAX_RICH_ENTRIES = 20;
const MAX_RICH_TEXT_BYTES = 2_000;
const MAX_RICH_RENDER_BYTES = 8_000;
const SENSITIVE_RICH_KEY =
  /(?:secret|key|token|credential|password|passwd|request[-_]?id|auth|bearer|session|signature|cookie|image|thumbnail|icon|photo|(?:^|[-_])sig(?:$|[-_]))/i;
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * SerpBase Google Search/News provider.
 *
 * The public rich-result docs name several modules but do not publish nested
 * schemas for featured snippets, top stories, or the knowledge graph. Those
 * modules therefore use bounded literal projection rather than guessed fields;
 * only the officially exemplified PAA shape contributes rich-result citations.
 */
export class SerpBaseProvider extends BaseProvider {
  readonly id: SerpBaseAdapterId;
  readonly tier: ProviderTier = 'raw-search';
  private readonly kind: SerpBaseKind;
  private readonly configuredOptions: Record<string, unknown>;

  constructor(kind: SerpBaseKind, options: SerpBaseProviderOptions = {}) {
    const {
      apiKey,
      credentials,
      httpClient,
      httpStreamClient,
      ...configuredOptions
    } = options;
    super({ apiKey, credentials, httpClient, httpStreamClient });
    this.kind = kind;
    this.id = kind === 'search' ? 'serpbase-search' : 'serpbase-news';
    this.configuredOptions = configuredOptions;
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    let apiKey: string | undefined;
    const configured = this.optionsSchema().safeParse(this.configuredOptions);
    if (!configured.success) {
      return this.failure(
        Math.round(performance.now() - start),
        configured.error.issues
          .map(
            (issue) => `${issue.path.join('.') || 'options'}: ${issue.message}`,
          )
          .join('; '),
        { kind: 'invalid_request' },
      );
    }

    try {
      apiKey = this.getApiKey();
      const response = await this.request<unknown>(`${BASE_URL}/${this.kind}`, {
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
        body: this.requestBody(query, configured.data),
        timeout: options.timeout * 1_000,
        signal: options.signal,
        // SerpBase documents no idempotency guarantee. A retry could charge
        // another credit after an ambiguous response, so every run is one try.
        retry: { mode: 'never' },
        redirect: 'manual',
      });
      const durationMs = Math.round(performance.now() - start);

      // Apply one terminal reflection guard to the raw payload before any
      // retained field is escaped, normalized, truncated, or copied to meta.
      if (reflectsCredential(response.data, apiKey)) {
        return this.failure(
          durationMs,
          'SerpBase response omitted because it reflected the configured credential.',
          { kind: 'provider' },
          usageFromPayload(response.data),
        );
      }

      if (response.status !== 200) {
        return this.failure(
          durationMs,
          `SerpBase rejected the request (HTTP ${response.status}).`,
          diagnosticFromHttpStatus(response.status),
          usageFromPayload(response.data),
        );
      }

      const data = record(response.data);
      if (!data) {
        return this.malformed(durationMs, 'response body must be an object');
      }
      if (data.status !== 0) {
        if (typeof data.status !== 'number') {
          return this.malformed(
            durationMs,
            'status must be the number 0',
            usageFromPayload(data),
          );
        }
        return this.failure(
          durationMs,
          `SerpBase reported business status ${data.status}.`,
          diagnosticFromBusinessStatus(data.status),
          usageFromPayload(data),
        );
      }

      const parsed = this.parseSuccess(data);
      if (parsed instanceof Error) {
        return this.malformed(
          durationMs,
          parsed.message,
          usageFromPayload(data),
        );
      }

      const section = this.render(parsed.data, parsed.results, configured.data);
      return {
        provider: this.id,
        tier: this.tier,
        content: section.content,
        citations: section.citations,
        durationMs,
        usage: parsed.usage,
        providerMeta: {
          ...(text(data.request_id) && {
            'serpbase:request_id': text(data.request_id),
          }),
          'serpbase:search_type': this.kind,
          'serpbase:page': data.page,
        },
      };
    } catch (error) {
      const diagnostic = isMissingCredentialError(error)
        ? ({ kind: 'authentication' } as const)
        : error instanceof HttpRequestTimeoutError
          ? ({ kind: 'timeout' } as const)
          : error instanceof HttpRequestAbortedError
            ? undefined
            : ({ kind: 'network' } as const);
      return this.failure(
        Math.round(performance.now() - start),
        isMissingCredentialError(error) ||
          error instanceof HttpRequestTimeoutError ||
          error instanceof HttpRequestAbortedError
          ? this.formatCatchError(error)
          : 'SerpBase could not complete the request.',
        diagnostic,
      );
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    // Both endpoints are billable. Credential resolution is the only safe
    // health check until the caller explicitly authorizes a paid query.
    try {
      this.getApiKey();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: this.formatCatchError(error) };
    }
  }

  private optionsSchema() {
    return this.kind === 'search'
      ? SerpBaseSearchOptionsSchema
      : SerpBaseNewsOptionsSchema;
  }

  private requestBody(
    query: string,
    options: SerpBaseSearchOptions | SerpBaseNewsOptions,
  ): Record<string, unknown> {
    return {
      q: query,
      ...(options.hl && { hl: options.hl }),
      ...(options.gl && { gl: options.gl }),
      ...(options.page !== undefined && { page: options.page }),
      ...(this.kind === 'search' && 'device' in options && options.device
        ? { device: options.device }
        : {}),
    };
  }

  private parseSuccess(data: Record<string, unknown>): ParsedSuccess | Error {
    if (
      typeof data.request_id !== 'string' ||
      !data.request_id.trim() ||
      utf8Length(data.request_id) > 255 ||
      sanitizeControlCharacters(data.request_id) !== data.request_id
    ) {
      return new Error('request_id must be a bounded non-empty string');
    }
    if (
      typeof data.elapsed_ms !== 'number' ||
      !Number.isFinite(data.elapsed_ms) ||
      data.elapsed_ms < 0
    ) {
      return new Error('elapsed_ms must be a finite non-negative number');
    }
    if (
      typeof data.credits_charged !== 'number' ||
      !Number.isFinite(data.credits_charged) ||
      data.credits_charged < 0
    ) {
      return new Error('credits_charged must be a non-negative number');
    }
    if (data.search_type !== this.kind) {
      return new Error(`search_type must be "${this.kind}"`);
    }
    if (typeof data.query !== 'string') {
      return new Error('query must be a string');
    }
    if (!Number.isSafeInteger(data.page) || (data.page as number) < 1) {
      return new Error('page must be a positive integer');
    }

    const resultKey = this.kind === 'search' ? 'organic' : 'news';
    const rawResults = data[resultKey];
    if (rawResults !== undefined && !Array.isArray(rawResults)) {
      return new Error(`${resultKey} must be an array when present`);
    }
    if (rawResults && rawResults.length > 100) {
      return new Error(`${resultKey} exceeds 100 results per page`);
    }
    const results: NormalizedResult[] = [];
    for (const [index, value] of (rawResults ?? []).entries()) {
      const parsed = this.parseResult(value);
      if (parsed instanceof Error) {
        return new Error(`${resultKey}[${index}]: ${parsed.message}`);
      }
      results.push(parsed);
    }
    return {
      data,
      results,
      usage: { billableUnits: data.credits_charged, unit: 'credit' },
    };
  }

  private parseResult(value: unknown): NormalizedResult | Error {
    const item = record(value);
    if (!item) return new Error('must be an object');
    if (
      typeof item.rank !== 'number' ||
      !Number.isSafeInteger(item.rank) ||
      item.rank < 1
    ) {
      return new Error('rank must be a positive integer');
    }
    const title = text(item.title);
    if (!title) return new Error('title must be a non-empty string');
    const url = safeHttpUrl(item.link);
    if (!url) return new Error('link must be a safe HTTP(S) URL');

    return {
      rank: item.rank,
      title,
      url,
      snippet: optionalText(item, 'snippet'),
      ...(this.kind === 'news' && {
        publisher: optionalText(item, 'source'),
        time: optionalText(item, 'time') ?? optionalText(item, 'published_at'),
        publishedAt: timestamp(optionalText(item, 'published_at')),
      }),
    };
  }

  private render(
    data: Record<string, unknown>,
    results: NormalizedResult[],
    options: SerpBaseSearchOptions | SerpBaseNewsOptions,
  ): { content: string; citations: Citation[] } {
    const parts: string[] = [];
    const citations = results.map((result) => this.citation(result));

    if (results.length === 0) {
      parts.push('No results found.');
    } else {
      for (const result of results) {
        const metadata = [result.publisher, result.time]
          .filter(Boolean)
          .map((value) => escapeMarkdownText(value as string))
          .join(' · ');
        parts.push(
          `### ${result.rank}. [${escapeMarkdownText(result.title)}](${markdownLinkDestination(result.url)})${metadata ? `\n${metadata}` : ''}`,
        );
        if (result.snippet) parts.push(escapeMarkdownText(result.snippet));
        parts.push('');
      }
    }

    if (
      this.kind === 'search' &&
      'includeRichResults' in options &&
      options.includeRichResults
    ) {
      for (const [key, heading] of RICH_SECTIONS) {
        const value = data[key];
        const expectedShape =
          key === 'top_stories'
            ? Array.isArray(value)
            : record(value) !== undefined;
        const rendered = expectedShape
          ? renderLiteralRichValue(value, (candidate) =>
              this.redactErrorText(candidate),
            )
          : undefined;
        if (rendered) parts.push(`## ${heading}\n\n${rendered}`, '');
      }

      const paa = renderPeopleAlsoAsk(data.people_also_ask, this.id);
      if (paa.content) {
        parts.push(paa.content, '');
        citations.push(...paa.citations);
      }

      const suggestions = relatedSearchSuggestions(data.related_searches);
      if (suggestions.length > 0) {
        parts.push(
          '## Related Searches',
          '',
          ...suggestions.map((value) => `- ${escapeMarkdownText(value)}`),
          '',
        );
      }
    }

    return {
      content: parts.join('\n').trim(),
      citations: deduplicateCitations(citations),
    };
  }

  private citation(result: NormalizedResult): Citation {
    return {
      url: result.url,
      title: result.title,
      snippet: result.snippet,
      provider: this.id,
      sourceKind: this.kind === 'news' ? 'news_article' : 'web_page',
      ...(result.publisher && { publisher: result.publisher }),
      ...(result.publishedAt && { publishedAt: result.publishedAt }),
    };
  }

  private malformed(
    durationMs: number,
    detail: string,
    usage?: ProviderUsage,
  ): ProviderResult {
    return this.failure(
      durationMs,
      `Malformed SerpBase ${this.kind} response: ${detail}`,
      { kind: 'provider' },
      usage,
    );
  }

  private failure(
    durationMs: number,
    error: string,
    failureDiagnostic?: ProviderFailureDiagnostic,
    usage?: ProviderUsage,
  ): ProviderResult {
    return {
      provider: this.id,
      tier: this.tier,
      content: '',
      citations: [],
      durationMs,
      ...(usage && { usage }),
      error,
      ...(failureDiagnostic && { failureDiagnostic }),
    };
  }
}

function renderPeopleAlsoAsk(
  value: unknown,
  provider: string,
): { content: string; citations: Citation[] } {
  if (value === undefined) return { content: '', citations: [] };
  if (!Array.isArray(value)) return { content: '', citations: [] };

  const lines: string[] = [];
  const citations: Citation[] = [];
  for (const item of value.slice(0, MAX_RICH_ENTRIES)) {
    const entry = record(item);
    const question = text(entry?.question);
    if (!entry || !question) continue;
    const snippet = optionalText(entry, 'snippet');
    const url = safeHttpUrl(entry.link);
    lines.push(`### ${escapeMarkdownText(question)}`);
    if (snippet) lines.push(escapeMarkdownText(snippet));
    if (url) {
      const label = optionalText(entry, 'displayed_link') ?? url;
      lines.push(
        `[Source: ${escapeMarkdownText(label)}](${markdownLinkDestination(url)})`,
      );
      citations.push({
        url,
        title: question,
        snippet,
        provider,
        sourceKind: 'web_page',
      });
    }
    lines.push('');
  }
  return {
    content:
      lines.length > 0
        ? `## People Also Ask\n\n${lines.join('\n').trim()}`
        : '',
    citations,
  };
}

function relatedSearchSuggestions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const item of value.slice(0, MAX_RICH_ENTRIES)) {
    const suggestion = text(item)?.trim();
    if (!suggestion || seen.has(suggestion)) continue;
    seen.add(suggestion);
    suggestions.push(suggestion);
  }
  return suggestions;
}

/** Literal, bounded projection for rich modules whose nested schema is unknown. */
function renderLiteralRichValue(
  value: unknown,
  redact: (value: string) => string,
): string | undefined {
  if (value === undefined) return undefined;
  const projection = { credentialReflected: false };
  const safe = safeJsonValue(value, 0, redact, projection);
  if (safe === undefined || projection.credentialReflected) return undefined;
  const serialized = JSON.stringify(safe, null, 2).replaceAll('`', '\\u0060');
  const fenced = `\`\`\`json\n${serialized}\n\`\`\``;
  if (utf8Length(fenced) <= MAX_RICH_RENDER_BYTES) return fenced;
  const frame = '```json\n\n[truncated]\n```';
  const bounded = truncateUtf8(
    serialized,
    MAX_RICH_RENDER_BYTES - utf8Length(frame),
  );
  return `\`\`\`json\n${bounded}\n[truncated]\n\`\`\``;
}

function safeJsonValue(
  value: unknown,
  depth: number,
  redact: (value: string) => string,
  projection: { credentialReflected: boolean },
): unknown {
  if (depth > MAX_RICH_DEPTH) return '[truncated]';
  if (typeof value === 'string') {
    const redacted = redact(value);
    if (redacted !== value) projection.credentialReflected = true;
    const normalized = sanitizeControlCharacters(redacted).trim();
    const safeUrl = safeRichUrl(normalized);
    if (safeUrl === false) return '[omitted unsafe URL]';
    return truncateUtf8(normalized, MAX_RICH_TEXT_BYTES);
  }
  if (typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_RICH_ENTRIES)
      .map((item) => safeJsonValue(item, depth + 1, redact, projection))
      .filter((item) => item !== undefined);
  }
  const object = record(value);
  if (!object) return undefined;
  const entries = Object.entries(object)
    .slice(0, MAX_RICH_ENTRIES)
    .flatMap(([key, item]) => {
      const redactedKey = redact(key);
      if (redactedKey !== key) projection.credentialReflected = true;
      if (PROTOTYPE_KEYS.has(key) || SENSITIVE_RICH_KEY.test(key)) return [];
      const safeValue = safeJsonValue(item, depth + 1, redact, projection);
      const safeKey = truncateUtf8(sanitizeControlCharacters(redactedKey), 100);
      return safeValue === undefined || !safeKey
        ? []
        : ([[safeKey, safeValue]] as const);
    });
  return Object.fromEntries(entries);
}

function usageFromPayload(value: unknown): ProviderUsage | undefined {
  const credits = record(value)?.credits_charged;
  return typeof credits === 'number' && Number.isFinite(credits) && credits >= 0
    ? { billableUnits: credits, unit: 'credit' }
    : undefined;
}

function reflectsCredential(value: unknown, credential: string): boolean {
  const seen = new Set<object>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (typeof candidate === 'string') {
      if (candidate.includes(credential)) return true;
      continue;
    }
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      pending.push(...candidate);
      continue;
    }
    for (const [key, item] of Object.entries(candidate)) {
      if (key.includes(credential)) return true;
      pending.push(item);
    }
  }
  return false;
}

function isMissingCredentialError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith('API key not found for serpbase-')
  );
}

function diagnosticFromBusinessStatus(
  status: number,
): ProviderFailureDiagnostic {
  if (status === 1000) return { kind: 'invalid_request' };
  if (status === 1001) return { kind: 'authentication' };
  if (status === 1020) return { kind: 'billing' };
  if (status === 1029) return { kind: 'rate_limit' };
  if (status === 1504) return { kind: 'timeout' };
  return { kind: 'provider' };
}

function diagnosticFromHttpStatus(status: number): ProviderFailureDiagnostic {
  const httpStatus = status >= 100 && status <= 599 ? status : undefined;
  const kind =
    status === 408 || status === 504
      ? 'timeout'
      : status === 401 || status === 403
        ? 'authentication'
        : status === 402
          ? 'billing'
          : status === 429
            ? 'rate_limit'
            : status >= 400 && status < 500
              ? 'invalid_request'
              : 'provider';
  return { kind, ...(httpStatus !== undefined && { httpStatus }) };
}

function safeHttpUrl(value: unknown): string | undefined {
  const candidate = typeof value === 'string' ? value : undefined;
  if (
    !candidate ||
    candidate.trim() !== candidate ||
    utf8Length(candidate) > 8192 ||
    sanitizeControlCharacters(candidate) !== candidate
  )
    return undefined;
  try {
    const url = new URL(candidate);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      hasCredentialParameters(url.pathname, false) ||
      hasCredentialParameters(url.search, true) ||
      hasCredentialParameters(url.hash, true)
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function deduplicateCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = normalizeUrl(citation.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function timestamp(value: string | undefined): string | undefined {
  const parsed = Rfc3339UtcSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Detect URL-shaped strings without interpreting ordinary prose as a URL. */
function safeRichUrl(value: string): boolean | undefined {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined;
  return safeHttpUrl(value) !== undefined;
}

function hasCredentialParameters(
  component: string,
  allowBareKey: boolean,
): boolean {
  let decoded = component;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decoded.replaceAll('+', ' '));
      if (next === decoded) break;
      decoded = next;
    } catch {
      return true;
    }
  }
  if (/%[0-9a-f]{2}/i.test(decoded)) return true;
  const keys = [...decoded.matchAll(/(?:^|[?&#;/=])([^?&#;/=]+)(?==)/g)].map(
    (match) => match[1],
  );
  if (allowBareKey) {
    keys.push(
      ...decoded
        .replace(/^[?#]/, '')
        .split(/[&;]/)
        .map((parameter) => parameter.split('=')[0]),
    );
  }
  return keys.some((part) => {
    const segments = part.split(/[^a-z0-9]+/i);
    return [...segments, segments.join('')].some((key) =>
      /^(?:key|sig|bearer|cookie)$|(?:signature|credential|token|secret|password|passwd|authorization|authentication|auth|session(?:id)?|api(?:access)?key|accesskeyid)$/i.test(
        key,
      ),
    );
  });
}

function optionalText(
  object: Record<string, unknown>,
  key: string,
): string | undefined {
  return object[key] === undefined ? undefined : text(object[key]);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? truncateUtf8(sanitizeControlCharacters(value), MAX_RICH_TEXT_BYTES)
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sanitizeControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? ' ' : character;
  }).join('');
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maximumBytes) return value;
  return new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.slice(0, maximumBytes))
    .replace(/\uFFFD$/, '');
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/([\\`*_[\]{}<>#+!|~])/g, '\\$1')
    .replace(/^([+-])(?=\s)/, '\\$1')
    .replace(/^(\d+)\.(?=\s)/, '$1\\.')
    .replace(/\b(https?|ftp):\/\//gi, '$1:\u200b//')
    .replace(/\bwww\./gi, 'www\u200b.')
    .replace(/@/g, '@\u200b');
}

function markdownLinkDestination(url: string): string {
  return url.replace(/([\\()<>])/g, '\\$1');
}
