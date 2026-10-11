import { z } from 'zod';
import { ISO_3166_ALPHA2 } from './perplexity-search-options.js';

const hostnameLabel = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const hostname = new RegExp(`^${hostnameLabel}(?:\\.${hostnameLabel})+$`, 'i');
const bareExtension = new RegExp(
  `^\\.${hostnameLabel}(?:\\.${hostnameLabel})*$`,
  'i',
);

/** Parallel accepts domains or bare extensions such as `.edu`, never URLs. */
const domain = z
  .string()
  .trim()
  .min(2)
  .max(253)
  .refine(
    (value) => hostname.test(value) || bareExtension.test(value),
    'must be a plain domain or bare extension (for example, example.com or .edu)',
  )
  .transform((value) => value.toLowerCase());

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }, 'must be a real RFC 3339 calendar date');

const location = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'must be an ISO 3166-1 alpha-2 code')
  .transform((value) => value.toUpperCase())
  .refine(
    (value) => ISO_3166_ALPHA2.has(value),
    'must be an ISO 3166-1 alpha-2 code',
  );

const sourcePolicy = z
  .object({
    includeDomains: z.array(domain).min(1).max(200).optional(),
    excludeDomains: z.array(domain).min(1).max(200).optional(),
    afterDate: date.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.includeDomains?.length ?? 0) +
        (value.excludeDomains?.length ?? 0) >
      200
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'includeDomains and excludeDomains cannot contain more than 200 domains total',
      });
    }
  });

const fetchPolicy = z
  .object({
    maxAgeSeconds: z.number().int().min(600).optional(),
    timeoutSeconds: z.number().finite().positive().optional(),
    disableCacheFallback: z.boolean().optional(),
  })
  .strict();

const ParallelSearchControlsSchema = z
  .object({
    objective: z.string().trim().min(1).max(20_000).optional(),
    searchQueries: z
      .array(z.string().trim().min(1).max(1_000))
      .min(1)
      .max(10)
      .optional(),
    maxCharsTotal: z.number().int().positive().optional(),
    maxCharsPerResult: z.number().int().positive().optional(),
    maxResults: z.number().int().positive().optional(),
    location: location.optional(),
    sourcePolicy: sourcePolicy.optional(),
    fetchPolicy: fetchPolicy.optional(),
  })
  .strict();

export const ParallelSearchOptionsSchema = ParallelSearchControlsSchema.extend({
  mode: z.enum(['turbo', 'fast', 'basic', 'advanced']).optional(),
}).strict();

/** Turbo locks Search API `mode` to `turbo`; callers cannot override it. */
export const ParallelTurboOptionsSchema = ParallelSearchControlsSchema;

/**
 * Every Task API processor Parallel lists, cheapest first
 * (https://docs.parallel.ai/task-api/guides/choose-a-processor, accessed
 * 2026-10-11). The delisted `pro-fast` and `ultra-fast` are not accepted.
 */
export const PARALLEL_RESEARCH_PROCESSORS = [
  'lite',
  'base',
  'core',
  'core2x',
  'pro',
  'ultra',
  'ultra2x',
  'ultra4x',
  'ultra8x',
] as const;

export const DEFAULT_PARALLEL_RESEARCH_PROCESSOR = 'pro';

const pathSegment = /^[^\s/?#:]+$/;

/**
 * Task API source policies also accept domain/path prefixes such as
 * `docs.python.org/3`. Hosts are case-insensitive; paths are not.
 */
const domainOrPathPrefix = z
  .string()
  .trim()
  .min(2)
  .max(253)
  .transform((value) => value.replace(/\/+$/, ''))
  .refine((value) => {
    const [host = '', ...segments] = value.split('/');
    return (
      (hostname.test(host) || bareExtension.test(host)) &&
      segments.every(
        (segment) =>
          pathSegment.test(segment) && segment !== '.' && segment !== '..',
      )
    );
  }, 'must be a plain domain, domain/path prefix, or bare extension (for example, example.com, docs.python.org/3, or .edu)')
  .transform((value) => {
    const slash = value.indexOf('/');
    return slash < 0
      ? value.toLowerCase()
      : `${value.slice(0, slash).toLowerCase()}${value.slice(slash)}`;
  });

/** A JSON Schema object for structured output; Parallel supports a subset. */
const jsonSchemaObject = z
  .record(z.string(), z.unknown())
  .refine(
    (schema) => Object.keys(schema).length > 0,
    'must be a non-empty JSON Schema object',
  );

const metadata = z
  .record(
    z.string().min(1).max(16),
    z.union([z.string().max(512), z.number().finite(), z.boolean()]),
  )
  .refine(
    (value) => Object.keys(value).length > 0,
    'must contain at least one key',
  );

export const ParallelResearchOptionsSchema = z
  .object({
    processor: z.enum(PARALLEL_RESEARCH_PROCESSORS).optional(),
    includeDomains: z.array(domainOrPathPrefix).min(1).max(200).optional(),
    excludeDomains: z.array(domainOrPathPrefix).min(1).max(200).optional(),
    afterDate: date.optional(),
    location: location.optional(),
    /** A text description of the report, or a JSON Schema for JSON output. */
    outputSchema: z
      .union([z.string().trim().min(1), jsonSchemaObject])
      .optional(),
    metadata: metadata.optional(),
    memoryScopeKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/, 'must be 1-128 of [A-Za-z0-9_-]')
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.includeDomains?.length ?? 0) +
        (value.excludeDomains?.length ?? 0) >
      200
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'includeDomains and excludeDomains cannot contain more than 200 domains total',
      });
    }
  });

export type ParallelSearchOptions = z.infer<typeof ParallelSearchOptionsSchema>;
export type ParallelTurboOptions = z.infer<typeof ParallelTurboOptionsSchema>;
export type ParallelResearchOptions = z.infer<
  typeof ParallelResearchOptionsSchema
>;
