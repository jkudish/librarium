import { normalizeUrl } from '../core/normalizer.js';
import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import { BaseProvider, type BaseProviderOptions } from './base.js';

type FirecrawlSource = 'web' | 'news';
type FirecrawlCategory = 'github' | 'research' | 'pdf';

interface FirecrawlWebResult {
  url?: unknown;
  title?: unknown;
  description?: unknown;
}

interface FirecrawlNewsResult {
  url?: unknown;
  title?: unknown;
  snippet?: unknown;
  date?: unknown;
}

interface FirecrawlSearchResponse {
  success?: boolean;
  data?: {
    web?: unknown;
    news?: unknown;
  };
  creditsUsed?: unknown;
  error?: unknown;
}

export interface FirecrawlSearchProviderOptions extends BaseProviderOptions {
  sources?: unknown;
  limit?: unknown;
  tbs?: unknown;
  country?: unknown;
  location?: unknown;
  includeDomains?: unknown;
  excludeDomains?: unknown;
  categories?: unknown;
  ignoreInvalidURLs?: unknown;
}

interface ValidatedFirecrawlSearchOptions {
  sources: FirecrawlSource[];
  limit: number;
  tbs?: string;
  country?: string;
  location?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  categories?: FirecrawlCategory[];
  ignoreInvalidURLs?: boolean;
}

interface NormalizedResult {
  kind: FirecrawlSource;
  url: string;
  title?: string;
  snippet?: string;
  date?: string;
}

const DEFAULT_SOURCES: FirecrawlSource[] = ['web'];
const DEFAULT_LIMIT = 10;
const SEARCH_URL = 'https://api.firecrawl.dev/v2/search';

/**
 * Firecrawl Search provider.
 * Uses Firecrawl v2 Search API for raw web and news search results.
 * Tier: raw-search (sync)
 */
export class FirecrawlSearchProvider extends BaseProvider {
  readonly id = 'firecrawl-search';
  readonly tier: ProviderTier = 'raw-search';

  private readonly configuredOptions: FirecrawlSearchProviderOptions;

  constructor(options: FirecrawlSearchProviderOptions = {}) {
    super(options);
    this.configuredOptions = options;
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const configured = this.validateOptions();
    if (configured instanceof Error) {
      return this.errorResult(
        Math.round(performance.now() - start),
        configured.message,
      );
    }

    try {
      const apiKey = this.getApiKey();
      const response = await this.request<FirecrawlSearchResponse>(SEARCH_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: this.requestBody(query, configured),
        timeout: options.timeout * 1000,
        signal: options.signal,
      });

      const durationMs = Math.round(performance.now() - start);
      if (response.status !== 200) {
        return this.errorResult(
          durationMs,
          this.formatError(response.status, response.data),
        );
      }

      const data = response.data;
      const apiError = textValue(data?.error);
      if (data?.success === false || apiError) {
        return this.errorResult(
          durationMs,
          apiError || 'Firecrawl API returned an unsuccessful response',
        );
      }

      const results = this.normalizeResults(data?.data, configured.sources);
      return {
        provider: this.id,
        tier: this.tier,
        content: this.buildContent(results),
        citations: this.extractCitations(results),
        durationMs,
        usage: this.extractUsage(data?.creditsUsed),
      };
    } catch (err) {
      return this.errorResult(
        Math.round(performance.now() - start),
        this.formatCatchError(err),
      );
    }
  }

  /** A cheap, fixed health check that deliberately ignores configured options. */
  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const apiKey = this.getApiKey();
      const response = await this.request<FirecrawlSearchResponse>(SEARCH_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: { query: 'test', limit: 1, sources: ['web'] },
        timeout: 10000,
      });

      if (response.status !== 200)
        return { ok: false, error: `HTTP ${response.status}` };
      if (response.data?.success === false || textValue(response.data?.error)) {
        return {
          ok: false,
          error:
            textValue(response.data?.error) ||
            'Firecrawl API returned an unsuccessful response',
        };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: this.formatCatchError(err) };
    }
  }

  private validateOptions(): ValidatedFirecrawlSearchOptions | Error {
    const sources = this.arrayOfAllowedStrings(
      this.configuredOptions.sources,
      'sources',
      ['web', 'news'],
      DEFAULT_SOURCES,
    );
    if (sources instanceof Error) return sources;
    if (!sources)
      return new Error('Firecrawl option sources must be a nonempty array');

    const limit = this.configuredOptions.limit ?? DEFAULT_LIMIT;
    if (
      typeof limit !== 'number' ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      return new Error(
        'Firecrawl option limit must be a safe integer between 1 and 100',
      );
    }

    const validated: ValidatedFirecrawlSearchOptions = { sources, limit };
    const tbs = validateTbs(this.configuredOptions.tbs);
    if (tbs instanceof Error) return tbs;
    if (tbs !== undefined) validated.tbs = tbs;

    const country = validateCountry(this.configuredOptions.country);
    if (country instanceof Error) return country;
    if (country !== undefined) validated.country = country;

    const location = this.optionalNonemptyString(
      this.configuredOptions.location,
      'location',
    );
    if (location instanceof Error) return location;
    if (location !== undefined) validated.location = location;

    const includeDomains = this.domains(
      this.configuredOptions.includeDomains,
      'includeDomains',
    );
    if (includeDomains instanceof Error) return includeDomains;
    const excludeDomains = this.domains(
      this.configuredOptions.excludeDomains,
      'excludeDomains',
    );
    if (excludeDomains instanceof Error) return excludeDomains;
    if (includeDomains && excludeDomains) {
      return new Error(
        'Firecrawl options includeDomains and excludeDomains are mutually exclusive',
      );
    }
    if (includeDomains) validated.includeDomains = includeDomains;
    if (excludeDomains) validated.excludeDomains = excludeDomains;

    const categories = this.arrayOfAllowedStrings(
      this.configuredOptions.categories,
      'categories',
      ['github', 'research', 'pdf'],
    );
    if (categories instanceof Error) return categories;
    if (categories) validated.categories = categories;

    const { ignoreInvalidURLs } = this.configuredOptions;
    if (
      ignoreInvalidURLs !== undefined &&
      typeof ignoreInvalidURLs !== 'boolean'
    ) {
      return new Error('Firecrawl option ignoreInvalidURLs must be a boolean');
    }
    if (ignoreInvalidURLs !== undefined) {
      validated.ignoreInvalidURLs = ignoreInvalidURLs;
    }

    return validated;
  }

  private requestBody(query: string, options: ValidatedFirecrawlSearchOptions) {
    return {
      query,
      limit: options.limit,
      sources: options.sources,
      ...(options.tbs ? { tbs: options.tbs } : {}),
      ...(options.country ? { country: options.country } : {}),
      ...(options.location ? { location: options.location } : {}),
      ...(options.includeDomains
        ? { includeDomains: options.includeDomains }
        : {}),
      ...(options.excludeDomains
        ? { excludeDomains: options.excludeDomains }
        : {}),
      ...(options.categories
        ? { categories: options.categories.map((type) => ({ type })) }
        : {}),
      ...(options.ignoreInvalidURLs !== undefined
        ? { ignoreInvalidURLs: options.ignoreInvalidURLs }
        : {}),
    };
  }

  private normalizeResults(
    data: FirecrawlSearchResponse['data'],
    sources: FirecrawlSource[],
  ): NormalizedResult[] {
    const results: NormalizedResult[] = [];
    const seen = new Set<string>();
    for (const source of sources) {
      const entries = source === 'web' ? data?.web : data?.news;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const result = this.normalizeResult(source, entry);
        if (!result) continue;
        const key = dedupeKey(result.url);
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(result);
      }
    }
    return results;
  }

  private normalizeResult(
    kind: FirecrawlSource,
    entry: unknown,
  ): NormalizedResult | undefined {
    if (!entry || typeof entry !== 'object') return undefined;
    const item = entry as FirecrawlWebResult | FirecrawlNewsResult;
    const url = absoluteHttpsUrl(item.url);
    if (!url) return undefined;
    const title = textValue(item.title);
    if (kind === 'web') {
      return {
        kind,
        url,
        title,
        snippet: textValue((item as FirecrawlWebResult).description),
      };
    }
    return {
      kind,
      url,
      title,
      snippet: textValue((item as FirecrawlNewsResult).snippet),
      date: textValue((item as FirecrawlNewsResult).date),
    };
  }

  private buildContent(results: NormalizedResult[]): string {
    if (results.length === 0) return 'No results found.';
    const parts: string[] = [];
    for (const kind of ['web', 'news'] as const) {
      const section = results.filter((result) => result.kind === kind);
      if (section.length === 0) continue;
      parts.push(`## ${kind === 'web' ? 'Web' : 'News'}`, '');
      for (const result of section) {
        const title = escapeMarkdownText(result.title ?? 'Untitled');
        const date =
          result.kind === 'news' && result.date
            ? ` (${escapeMarkdownText(result.date)})`
            : '';
        parts.push(
          `- **[${title}](${markdownLinkDestination(result.url)})**${date}`,
        );
        if (result.snippet) {
          parts.push(`  ${escapeMarkdownText(result.snippet)}`);
        }
      }
      parts.push('');
    }
    return parts.join('\n').trim();
  }

  private extractCitations(results: NormalizedResult[]): Citation[] {
    return results.map((result) => ({
      url: result.url,
      title: result.title,
      snippet: result.snippet?.slice(0, 200),
      provider: this.id,
    }));
  }

  private extractUsage(creditsUsed: unknown): ProviderUsage | undefined {
    if (
      typeof creditsUsed !== 'number' ||
      !Number.isSafeInteger(creditsUsed) ||
      creditsUsed < 0
    ) {
      return undefined;
    }
    return { billableUnits: creditsUsed, unit: 'credit' };
  }

  private arrayOfAllowedStrings<T extends string>(
    value: unknown,
    name: string,
    allowed: readonly T[],
    fallback?: T[],
  ): T[] | Error | undefined {
    if (value === undefined) return fallback;
    if (!Array.isArray(value) || value.length === 0) {
      return new Error(`Firecrawl option ${name} must be a nonempty array`);
    }
    if (
      value.some(
        (item) => typeof item !== 'string' || !allowed.includes(item as T),
      ) ||
      new Set(value).size !== value.length
    ) {
      return new Error(
        `Firecrawl option ${name} must contain unique supported values`,
      );
    }
    return value as T[];
  }

  private optionalNonemptyString(
    value: unknown,
    name: string,
  ): string | Error | undefined {
    if (value === undefined) return undefined;
    const normalized = textValue(value);
    return (
      normalized ||
      new Error(`Firecrawl option ${name} must be a nonempty string`)
    );
  }

  private domains(value: unknown, name: string): string[] | Error | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length === 0) {
      return new Error(
        `Firecrawl option ${name} must be a nonempty array of hostnames`,
      );
    }
    const domains = value.map((item) => textValue(item)?.toLowerCase());
    if (domains.some((domain) => !domain || !isHostname(domain))) {
      return new Error(
        `Firecrawl option ${name} must contain only nonempty hostnames`,
      );
    }
    if (new Set(domains).size !== domains.length) {
      return new Error(
        `Firecrawl option ${name} must not contain duplicate hostnames`,
      );
    }
    return domains as string[];
  }

  private errorResult(durationMs: number, error: string): ProviderResult {
    return {
      provider: this.id,
      tier: this.tier,
      content: '',
      citations: [],
      durationMs,
      error,
    };
  }
}

function textValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized || undefined;
}

function absoluteHttpsUrl(value: unknown): string | undefined {
  const url = textValue(value);
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function validateCountry(value: unknown): string | Error | undefined {
  if (value === undefined) return undefined;
  const country = textValue(value);
  if (!country || !/^[a-z]{2}$/i.test(country)) {
    return new Error(
      'Firecrawl option country must be a two-letter country code',
    );
  }
  return country.toUpperCase();
}

function validateTbs(value: unknown): string | Error | undefined {
  if (value === undefined) return undefined;
  const tbs = textValue(value);
  if (!tbs) return new Error('Firecrawl option tbs must be a nonempty string');

  const parts = tbs.split(',');
  const supported = parts.every(
    (part) =>
      /^qdr:[hdwmy]$/.test(part) ||
      part === 'sbd:1' ||
      part === 'cdr:1' ||
      /^cd_(?:min|max):\d{2}\/\d{2}\/\d{4}$/.test(part),
  );
  if (!supported || new Set(parts).size !== parts.length) {
    return new Error('Firecrawl option tbs has an unsupported format');
  }

  const customRange = parts.includes('cdr:1');
  const min = parts.find((part) => part.startsWith('cd_min:'));
  const max = parts.find((part) => part.startsWith('cd_max:'));
  if (customRange !== Boolean(min && max)) {
    return new Error(
      'Firecrawl option tbs custom ranges require cdr:1, cd_min, and cd_max',
    );
  }
  const minDate = min ? usDateTimestamp(min.slice(7)) : undefined;
  const maxDate = max ? usDateTimestamp(max.slice(7)) : undefined;
  if ((min && minDate === undefined) || (max && maxDate === undefined)) {
    return new Error('Firecrawl option tbs contains an invalid date');
  }
  if (minDate !== undefined && maxDate !== undefined && minDate > maxDate) {
    return new Error(
      'Firecrawl option tbs custom range start must not follow its end',
    );
  }
  return tbs;
}

function usDateTimestamp(value: string): number | undefined {
  const [month, day, year] = value.split('/').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  return valid ? date.getTime() : undefined;
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

function isHostname(value: string): boolean {
  if (value.length > 253 || value.includes('..')) return false;
  return value
    .split('.')
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function dedupeKey(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  return normalizeUrl(parsed.href);
}
