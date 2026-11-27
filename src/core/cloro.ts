import { z } from 'zod';
import type {
  Citation,
  ProviderFailureDiagnostic,
  ProviderResult,
  ProviderUsage,
  SearchResultItem,
} from '../types.js';

/**
 * Cloro (https://cloro.dev/docs) observes consumer AI surfaces and Google
 * results in logged-out browser sessions. Every request needs an uppercase
 * ISO country, and usage is reported in Cloro credits, never USD.
 */
export const CLORO_ORIGIN = 'https://api.cloro.dev';
/** Cloro deletes finished async tasks 24 hours after they were created. */
export const CLORO_TASK_RETENTION_MS = 24 * 60 * 60 * 1000;

type CloroKind = 'answer' | 'overview' | 'search' | 'news';
export interface CloroSurface {
  readonly path: string;
  readonly taskType?: string;
  readonly input: 'prompt' | 'query';
  readonly kind: CloroKind;
  /** Whether `sources` are the pages read rather than the pages cited. */
  readonly sourcesAreRetrieval?: true;
}

export const CLORO_SURFACES = {
  chatgpt: {
    path: '/v1/monitor/chatgpt',
    taskType: 'CHATGPT',
    input: 'prompt',
    kind: 'answer',
    sourcesAreRetrieval: true,
  },
  gemini: {
    path: '/v1/monitor/gemini',
    taskType: 'GEMINI',
    input: 'prompt',
    kind: 'answer',
  },
  'google-ai-mode': {
    path: '/v1/monitor/aimode',
    taskType: 'AIMODE',
    input: 'prompt',
    kind: 'answer',
  },
  'google-ai-overview': {
    path: '/v1/monitor/google',
    taskType: 'GOOGLE',
    input: 'query',
    kind: 'overview',
  },
  'bing-ai-mode': {
    path: '/v1/monitor/bing/aimode',
    taskType: 'BING_AIMODE',
    input: 'prompt',
    kind: 'answer',
    sourcesAreRetrieval: true,
  },
  'google-search': {
    path: '/v1/monitor/google',
    input: 'query',
    kind: 'search',
  },
  'google-news': {
    path: '/v1/monitor/google/news',
    input: 'query',
    kind: 'news',
  },
} as const satisfies Record<string, CloroSurface>;
export type CloroSurfaceId = keyof typeof CLORO_SURFACES;

const country = z
  .string()
  .regex(/^[A-Z]{2}$/, 'country must be an uppercase ISO 3166-1 alpha-2 code')
  // Cloro has no default country. It is checked when a request is built, so
  // an unconfigured, unselected adapter does not warn at startup.
  .optional();
const state = z.string().regex(/^[A-Z]{2}$/);
const hl = z.string().trim().min(1).max(16);
const location = z.string().trim().min(1).max(255);
const usState = (
  options: { country?: string; state?: string },
  ctx: z.RefinementCtx,
) => {
  if (options.state !== undefined && options.country !== 'US')
    ctx.addIssue({
      code: 'custom',
      path: ['state'],
      message: 'state requires country US',
    });
};
const googleDevice = z.enum(['desktop', 'mobile', 'ios', 'android']).optional();

export const CloroOptionsSchemas = {
  chatgpt: z
    .object({ country, state: state.optional() })
    .strict()
    .superRefine(usState),
  gemini: z
    .object({ country, state: state.optional() })
    .strict()
    .superRefine(usState),
  'bing-ai-mode': z
    .object({ country, state: state.optional() })
    .strict()
    .superRefine(usState),
  'google-ai-mode': z
    .object({
      country,
      hl: hl.optional(),
      location: location.optional(),
      device: z.enum(['desktop', 'mobile']).optional(),
    })
    .strict(),
  'google-ai-overview': z
    .object({
      country,
      hl: hl.optional(),
      location: location.optional(),
      device: googleDevice,
    })
    .strict(),
  // The google research source has no public country option, so its Cloro
  // collector pins US results instead of leaving geography to the proxy.
  'google-search': z
    .object({
      country: country.default('US'),
      hl: hl.optional(),
      location: location.optional(),
      device: googleDevice,
    })
    .strict(),
  'google-news': z
    .object({
      country: country.default('US'),
      hl: hl.optional(),
      device: googleDevice,
    })
    .strict(),
} as const satisfies Record<CloroSurfaceId, z.ZodTypeAny>;

export class CloroError extends Error {
  constructor(
    readonly kind: ProviderFailureDiagnostic['kind'],
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'CloroError';
  }
}

/** The request body Cloro's sync endpoint and async payload share. */
export function cloroPayload(
  surface: CloroSurfaceId,
  query: string,
  options: Record<string, unknown>,
): Record<string, unknown> {
  const spec = CLORO_SURFACES[surface];
  if (typeof options.country !== 'string')
    throw new CloroError(
      'invalid_request',
      'Cloro requires an uppercase ISO country option, such as "US".',
    );
  if (query.trim() === '' || [...query].length > 10_000)
    throw new CloroError(
      'invalid_request',
      'The Cloro query must contain 1 to 10,000 characters.',
    );
  // Bing puts the prompt in its page URL: 3,500 characters once encoded.
  if (
    surface === 'bing-ai-mode' &&
    new URLSearchParams({ q: query }).toString().length - 2 > 3_500
  )
    throw new CloroError(
      'invalid_request',
      'The Bing AI Mode prompt exceeds 3,500 URL-encoded characters.',
    );
  return {
    [spec.input]: query,
    ...options,
    ...(spec.kind === 'answer' && { include: { markdown: true } }),
    ...(spec.kind === 'overview' && {
      include: { aioverview: { markdown: true } },
    }),
  };
}

/** Map an HTTP failure to a bounded diagnostic and safe message. */
export function cloroHttpError(status: number, body: unknown): CloroError {
  const code = errorCode(body);
  const suffix = code ? `, ${code}` : '';
  const kind: ProviderFailureDiagnostic['kind'] =
    status === 400 || status === 422
      ? 'invalid_request'
      : status === 401
        ? 'authentication'
        : status === 403
          ? 'billing'
          : status === 429
            ? 'rate_limit'
            : status === 408 || status === 504
              ? 'timeout'
              : 'provider';
  return new CloroError(
    kind,
    `Cloro rejected the request (HTTP ${status}${suffix}).`,
    status,
  );
}

export function errorCode(body: unknown): string | undefined {
  const code = record(record(body)?.error)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : undefined;
}

export function cloroCredits(value: unknown): ProviderUsage | undefined {
  const credits =
    typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())
      ? Number(value)
      : typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
  return credits === undefined
    ? undefined
    : { billableUnits: credits, unit: 'credit' };
}

/** Map one Cloro `result` object. Extras stay in the stored evidence only. */
export function mapCloroResult(input: {
  readonly provider: string;
  readonly surface: CloroSurfaceId;
  readonly result: unknown;
  readonly usage?: ProviderUsage;
  readonly durationMs: number;
}): ProviderResult {
  const spec: CloroSurface = CLORO_SURFACES[input.surface];
  const result = record(input.result);
  if (!result)
    throw new CloroError('provider', 'Cloro returned no result object.');
  const base = {
    provider: input.provider,
    tier:
      spec.kind === 'search' || spec.kind === 'news'
        ? ('raw-search' as const)
        : ('ai-grounded' as const),
    durationMs: input.durationMs,
    ...(input.usage && { usage: input.usage }),
  };
  if (spec.kind === 'search' || spec.kind === 'news') {
    const items = records(
      spec.kind === 'news' ? result.newsResults : result.organicResults,
    );
    const citations: Citation[] = [];
    const lines: string[] = [];
    for (const item of items) {
      const url = externalUrl(item.link);
      if (!url || citations.some((citation) => citation.url === url)) continue;
      const title = text(item.title) ?? url;
      const snippet = text(item.snippet);
      const publisher = text(item.source);
      const date = text(item.date);
      citations.push({
        url,
        title,
        provider: input.provider,
        sourceKind: spec.kind === 'news' ? 'news_article' : 'web_page',
        ...(snippet && { snippet }),
        ...(publisher && { publisher }),
      });
      lines.push(
        `${citations.length}. [${escapeMarkdown(title)}](${url})${
          publisher || date
            ? ` — ${[publisher, date]
                .filter(Boolean)
                .map((part) => escapeMarkdown(part as string))
                .join(', ')}`
            : ''
        }${snippet ? `\n   ${escapeMarkdown(snippet)}` : ''}`,
      );
    }
    return { ...base, content: lines.join('\n'), citations };
  }
  const answer = spec.kind === 'overview' ? record(result.aioverview) : result;
  if (!answer)
    throw new CloroError(
      'provider',
      'Google showed no AI Overview for this query; Cloro still charged it.',
    );
  const content = text(answer.markdown) ?? text(answer.text);
  if (!content)
    throw new CloroError('provider', 'Cloro returned no answer content.');
  const pills = records(answer.citationPills);
  const sources = records(answer.sources);
  // ChatGPT and Bing list pages they read in `sources`; citations are the
  // pages the answer links: its pills, and ChatGPT sources linked in the text.
  const cited = spec.sourcesAreRetrieval
    ? [
        ...pills,
        ...sources.filter(
          (source) => input.surface === 'chatgpt' && source.footnote === false,
        ),
      ]
    : [...pills, ...sources];
  const citations: Citation[] = [];
  for (const item of cited) {
    const url = externalUrl(item.url);
    if (!url || citations.some((citation) => citation.url === url)) continue;
    const title = text(item.label);
    const snippet = text(item.description);
    citations.push({
      url,
      provider: input.provider,
      ...(title && { title }),
      ...(snippet && { snippet }),
    });
  }
  const searchResults: SearchResultItem[] | undefined = spec.sourcesAreRetrieval
    ? sources.flatMap((source) => {
        const url = externalUrl(source.url);
        if (!url) return [];
        const title = text(source.label);
        const snippet = text(source.description);
        const publishedAt = isoDate(source.datePublished);
        return [
          {
            url,
            ...(title && { title }),
            ...(snippet && { snippet }),
            ...(publishedAt && { publishedAt }),
          },
        ];
      })
    : undefined;
  const model = text(answer.model);
  return {
    ...base,
    content,
    citations,
    ...(searchResults && { searchResults }),
    ...(model && { model }),
  };
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value))
    return undefined;
  const time = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(time)
    ? undefined
    : new Date(time).toISOString().replace('.000Z', 'Z');
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\[\]])/g, '\\$1').replace(/\s+/g, ' ');
}

function externalUrl(value: unknown): string | undefined {
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

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!record(item))
    : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
