import type {
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BaseProvider } from './base.js';
import {
  validateYouAnswerQuery,
  type YouAnswerOptions,
  YouAnswerOptionsSchema,
} from './you-answer-options.js';

const YOU_ANSWER_URL = 'https://api.you.com/v1/answer';
const MAX_CITATION_EXCERPT_LENGTH = 8_192;

type JsonRecord = Record<string, unknown>;

interface AnswerCitation {
  readonly number: number;
  readonly sourceUrl: string;
  readonly excerpts: readonly string[];
}

interface ConsideredWebResult {
  readonly url: string;
  readonly title?: string;
  readonly snippets: readonly string[];
}

/** Inline, one-request You.com Answer API adapter for `you-answer/grounded`. */
export class YouAnswerProvider extends BaseProvider {
  readonly id = 'you-answer';
  readonly tier: ProviderTier = 'ai-grounded';
  private readonly configured: unknown;

  constructor(options: YouAnswerOptions | unknown = {}) {
    super();
    this.configured = options;
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    let apiKey: string | undefined;
    try {
      // Validate independently at the adapter boundary. Descriptor validation
      // protects configuration ingress, while this protects direct library use.
      const renderedQuery = validateYouAnswerQuery(query);
      const configured = this.validatedOptions();
      apiKey = this.getApiKey();
      const response = await this.request<unknown>(YOU_ANSWER_URL, {
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
        body: this.requestBody(renderedQuery, configured),
        timeout: options.timeout * 1_000,
        signal: options.signal,
        // Answer calls are paid and have no documented idempotency key.
        retry: { mode: 'never' },
      });
      const durationMs = Math.round(performance.now() - start);
      if (response.status !== 200) {
        return this.error(
          durationMs,
          this.safeHttpError(response.status, response.data, apiKey),
        );
      }

      const parsed = this.parseResponse(response.data);
      return {
        provider: this.id,
        tier: this.tier,
        content: parsed.answer,
        citations: parsed.citations.map((citation) => ({
          url: citation.sourceUrl,
          ...(citation.excerpts[0] !== undefined && {
            snippet: citation.excerpts[0].slice(0, MAX_CITATION_EXCERPT_LENGTH),
          }),
          provider: this.id,
        })),
        durationMs,
        // Keep the response's citation and considered-result distinctions in
        // allowlisted metadata. Considered web results never become citations.
        providerMeta: {
          'you-com:answer': {
            observation: 'api_output',
            citation_entries: parsed.citations.map((citation) => ({
              citation_number: citation.number,
              source_url: citation.sourceUrl,
              excerpts: citation.excerpts,
              inline_reference_count:
                parsed.inlineReferenceCounts.get(citation.number) ?? 0,
            })),
            considered_web_results: parsed.considered,
          },
        },
      };
    } catch (error) {
      return this.error(
        Math.round(performance.now() - start),
        this.redact(this.formatCatchError(error), apiKey),
      );
    }
  }

  /** Health checks would submit a paid Answer request, so they are opt-in only. */
  async test(): Promise<{ ok: boolean; error?: string }> {
    return {
      ok: false,
      error:
        'You.com Answer health checks are disabled because they would create a paid request.',
    };
  }

  private validatedOptions(): YouAnswerOptions {
    const parsed = YouAnswerOptionsSchema.safeParse(this.configured);
    if (!parsed.success) {
      throw new Error(
        `Invalid You.com Answer options: ${parsed.error.issues
          .map(
            (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
          )
          .join('; ')}`,
      );
    }
    return parsed.data;
  }

  private requestBody(
    query: string,
    configured: YouAnswerOptions,
  ): Record<string, unknown> {
    return {
      query,
      ...(configured.freshness && { freshness: configured.freshness }),
      ...(configured.country && { country: configured.country }),
      ...(configured.language && { language: configured.language }),
      ...(configured.includeDomains && {
        include_domains: configured.includeDomains,
      }),
      ...(configured.excludeDomains && {
        exclude_domains: configured.excludeDomains,
      }),
      ...(configured.boostDomains && {
        boost_domains: configured.boostDomains,
      }),
    };
  }

  private parseResponse(data: unknown): {
    answer: string;
    citations: AnswerCitation[];
    considered: ConsideredWebResult[];
    inlineReferenceCounts: Map<number, number>;
  } {
    if (!isRecord(data))
      throw new Error('You.com Answer returned a non-object response');
    if (typeof data.answer !== 'string' || !/\S/.test(data.answer)) {
      throw new Error('You.com Answer returned an empty answer');
    }

    const citations = this.parseCitations(data.citations);
    const inlineReferenceCounts = inlineReferences(
      data.answer,
      citations.length,
    );
    const considered = this.parseConsidered(data.results);
    return {
      answer: data.answer,
      citations,
      considered,
      inlineReferenceCounts,
    };
  }

  private parseCitations(value: unknown): AnswerCitation[] {
    if (!Array.isArray(value)) {
      throw new Error('You.com Answer returned malformed citations');
    }
    return value.map((entry, index) => {
      if (!isRecord(entry) || !isHttpUrl(entry.source)) {
        throw new Error(
          `You.com Answer citation ${index + 1} has no valid source URL`,
        );
      }
      if (
        !Array.isArray(entry.excerpts) ||
        entry.excerpts.some((excerpt) => typeof excerpt !== 'string')
      ) {
        throw new Error(
          `You.com Answer citation ${index + 1} has malformed excerpts`,
        );
      }
      return {
        number: index + 1,
        sourceUrl: entry.source,
        excerpts: entry.excerpts.filter((excerpt) => /\S/.test(excerpt)),
      };
    });
  }

  private parseConsidered(value: unknown): ConsideredWebResult[] {
    if (!isRecord(value)) {
      throw new Error('You.com Answer returned malformed results');
    }
    if (!Array.isArray(value.web)) {
      throw new Error('You.com Answer returned malformed results.web');
    }
    return value.web.map((entry, index) => {
      if (!isRecord(entry) || !isHttpUrl(entry.url)) {
        throw new Error(
          `You.com Answer considered result ${index + 1} has no valid URL`,
        );
      }
      if (entry.title !== undefined && typeof entry.title !== 'string') {
        throw new Error(
          `You.com Answer considered result ${index + 1} has malformed title`,
        );
      }
      if (
        entry.snippets !== undefined &&
        (!Array.isArray(entry.snippets) ||
          entry.snippets.some((snippet) => typeof snippet !== 'string'))
      ) {
        throw new Error(
          `You.com Answer considered result ${index + 1} has malformed snippets`,
        );
      }
      return {
        url: entry.url,
        ...(typeof entry.title === 'string' &&
          entry.title.trim() && {
            title: entry.title,
          }),
        snippets: (entry.snippets ?? []).filter((snippet) =>
          /\S/.test(snippet),
        ),
      };
    });
  }

  private error(durationMs: number, error: string): ProviderResult {
    return {
      provider: this.id,
      tier: this.tier,
      content: '',
      citations: [],
      durationMs,
      error,
      preventFallback: true,
    };
  }

  private safeHttpError(status: number, data: unknown, apiKey: string): string {
    return `You.com Answer API returned ${status}: ${this.redact(
      stringifyDiagnostic(data),
      apiKey,
    )}`;
  }

  private redact(value: string, apiKey?: string): string {
    const withoutKnownKey = apiKey
      ? value.split(apiKey).join('[REDACTED]')
      : value;
    return withoutKnownKey
      .replace(/(x-api-key\s*[:=]\s*)([^\s,}"\]]+)/gi, '$1[REDACTED]')
      .replace(/(api[_-]?key\s*[=:]\s*)([^\s,}"\]]+)/gi, '$1[REDACTED]')
      .slice(0, 500);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function inlineReferences(
  answer: string,
  citationCount: number,
): Map<number, number> {
  const counts = new Map<number, number>();
  for (const match of answer.matchAll(/\[\[([\d\s,]+)\]\]/g)) {
    for (const token of match[1].split(',')) {
      const number = Number(token.trim());
      if (
        !Number.isSafeInteger(number) ||
        number < 1 ||
        number > citationCount
      ) {
        throw new Error(
          'You.com Answer returned an inline citation without a matching citation entry',
        );
      }
      counts.set(number, (counts.get(number) ?? 0) + 1);
    }
  }
  return counts;
}

function stringifyDiagnostic(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
