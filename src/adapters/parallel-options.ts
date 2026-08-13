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

export const ParallelSearchOptionsSchema = z
  .object({
    objective: z.string().trim().min(1).max(20_000).optional(),
    searchQueries: z
      .array(z.string().trim().min(1).max(1_000))
      .min(1)
      .max(10)
      .optional(),
    mode: z.enum(['turbo', 'fast', 'basic', 'advanced']).optional(),
    maxCharsTotal: z.number().int().positive().optional(),
    maxCharsPerResult: z.number().int().positive().optional(),
    maxResults: z.number().int().positive().optional(),
    location: location.optional(),
    sourcePolicy: sourcePolicy.optional(),
    fetchPolicy: fetchPolicy.optional(),
  })
  .strict();

export const ParallelChatOptionsSchema = z
  .object({
    responseFormat: z
      .object({
        name: z.string().trim().min(1).max(64),
        schema: z.record(z.string(), z.json()),
        strict: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ParallelResearchOptionsSchema = z
  .object({
    processor: z.enum(['pro', 'pro-fast', 'ultra', 'ultra-fast']).optional(),
    includeDomains: z.array(domain).min(1).max(200).optional(),
    excludeDomains: z.array(domain).min(1).max(200).optional(),
    location: location.optional(),
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
export type ParallelChatOptions = z.infer<typeof ParallelChatOptionsSchema>;
export type ParallelResearchOptions = z.infer<
  typeof ParallelResearchOptionsSchema
>;
