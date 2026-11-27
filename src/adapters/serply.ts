import {
  HttpRequestAbortedError,
  HttpRequestTimeoutError,
} from '../core/http-client.js';
import type {
  Citation,
  ProviderFailureDiagnostic,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import { BaseProvider, type BaseProviderOptions } from './base.js';
import { type SerplyOptions, SerplyOptionsSchema } from './serply-options.js';

export type SerplyProviderOptions = BaseProviderOptions &
  Partial<SerplyOptions>;

const ENDPOINT = 'https://api.serply.io/v1/search';

/**
 * Serply Google organic search (https://serply.io/docs). One GET per query,
 * pinned to a country with `gl`. Serply charges a credit only for a successful
 * uncached request, so a 502 (a transient upstream failure, never charged) is
 * retried once. Pages overlap, so results are deduplicated by link and trimmed
 * to `num`. An `ai_overview` block is kept in the evidence only.
 */
export class SerplyProvider extends BaseProvider {
  readonly id = 'serply-search';
  readonly tier: ProviderTier = 'raw-search';
  private readonly configuredOptions: Record<string, unknown>;

  constructor(options: SerplyProviderOptions = {}) {
    const {
      apiKey,
      credentials,
      httpClient,
      httpStreamClient,
      ...configuredOptions
    } = options;
    super({ apiKey, credentials, httpClient, httpStreamClient });
    this.configuredOptions = configuredOptions;
  }

  get envVar(): string {
    return 'SERPLY_API_KEY';
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const parsed = SerplyOptionsSchema.safeParse(this.configuredOptions);
    if (!parsed.success)
      return this.failure(
        start,
        parsed.error.issues
          .map(
            (issue) => `${issue.path.join('.') || 'options'}: ${issue.message}`,
          )
          .join('; '),
        { kind: 'invalid_request' },
      );
    const configured = parsed.data;
    if (query.trim() === '')
      return this.failure(start, 'The Serply query must not be empty.', {
        kind: 'invalid_request',
      });
    try {
      const apiKey = this.getApiKey();
      const url = `${ENDPOINT}?${new URLSearchParams({
        q: query,
        num: String(configured.num),
        gl: configured.gl,
        ...(configured.hl && { hl: configured.hl }),
      })}`;
      const send = () =>
        this.request<unknown>(url, {
          method: 'GET',
          headers: {
            'X-Api-Key': apiKey,
            ...(configured.device && { 'X-User-Agent': configured.device }),
          },
          timeout: options.timeout * 1_000,
          signal: options.signal,
          retry: { mode: 'never' },
          redirect: 'manual',
        });
      let response = await send();
      if (response.status === 502 && !options.signal?.aborted)
        response = await send();
      if (reflects(response.data, apiKey))
        return this.failure(
          start,
          'Serply response omitted because it reflected the configured credential.',
          { kind: 'provider' },
        );
      if (response.status !== 200)
        return this.failure(
          start,
          `Serply rejected the request (HTTP ${response.status}).`,
          diagnosticFromStatus(response.status),
        );
      const data = record(response.data);
      if (!data || !Array.isArray(data.results))
        return this.failure(start, 'Serply returned a malformed response.', {
          kind: 'provider',
        });
      const citations: Citation[] = [];
      for (const item of data.results) {
        const result = record(item);
        const link = safeUrl(result?.link);
        if (!result || !link || citations.some((c) => c.url === link)) continue;
        const title = text(result.title) ?? link;
        const snippet = text(result.description);
        citations.push({
          url: link,
          title,
          provider: this.id,
          sourceKind: 'web_page',
          ...(snippet && { snippet }),
        });
        if (citations.length === configured.num) break;
      }
      const usage: ProviderUsage = { billableUnits: 1, unit: 'request' };
      const overview = aiOverview(data.ai_overview);
      return {
        provider: this.id,
        tier: this.tier,
        content: citations
          .map(
            (citation, index) =>
              `${index + 1}. [${escapeMarkdown(citation.title ?? citation.url)}](${citation.url})${
                citation.snippet
                  ? `\n   ${escapeMarkdown(citation.snippet)}`
                  : ''
              }`,
          )
          .join('\n'),
        citations,
        durationMs: Math.round(performance.now() - start),
        usage,
        providerMeta: {
          'serply:gl': configured.gl,
          ...(overview && { 'serply:ai_overview': overview }),
        },
      };
    } catch (error) {
      const missing =
        error instanceof Error && /API key not found/i.test(error.message);
      return this.failure(
        start,
        missing
          ? 'Serply API key not found. Set SERPLY_API_KEY.'
          : error instanceof HttpRequestTimeoutError ||
              error instanceof HttpRequestAbortedError
            ? this.formatCatchError(error)
            : 'Serply could not complete the request.',
        missing
          ? { kind: 'authentication' }
          : error instanceof HttpRequestTimeoutError
            ? { kind: 'timeout' }
            : error instanceof HttpRequestAbortedError
              ? undefined
              : { kind: 'network' },
      );
    }
  }

  private failure(
    start: number,
    error: string,
    failureDiagnostic?: ProviderFailureDiagnostic,
  ): ProviderResult {
    return {
      provider: this.id,
      tier: this.tier,
      content: '',
      citations: [],
      durationMs: Math.round(performance.now() - start),
      error,
      ...(failureDiagnostic && { failureDiagnostic }),
    };
  }
}

function diagnosticFromStatus(status: number): ProviderFailureDiagnostic {
  const kind: ProviderFailureDiagnostic['kind'] =
    status === 401 || status === 403
      ? 'authentication'
      : status === 402
        ? 'billing'
        : status === 429
          ? 'rate_limit'
          : status === 400 || status === 404 || status === 422
            ? 'invalid_request'
            : 'provider';
  return { kind, httpStatus: status };
}

/** The overview's text and cited pages, bounded; evidence only. */
function aiOverview(
  value: unknown,
): { text: string; sources: string[] } | undefined {
  const metadata = record(record(value)?.metadata);
  const answer = text(metadata?.text);
  if (!metadata || metadata.present === false || !answer) return undefined;
  const sources = (Array.isArray(metadata.sources) ? metadata.sources : [])
    .map((source) => safeUrl(record(source)?.url))
    .filter((url): url is string => !!url)
    .slice(0, 20);
  return { text: answer.slice(0, 8_000), sources };
}

function reflects(value: unknown, secret: string): boolean {
  if (typeof value === 'string') return value.includes(secret);
  if (Array.isArray(value)) return value.some((item) => reflects(item, secret));
  if (value && typeof value === 'object')
    return Object.values(value).some((item) => reflects(item, secret));
  return false;
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\[\]])/g, '\\$1').replace(/\s+/g, ' ');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
