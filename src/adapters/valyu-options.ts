import { z } from 'zod';

export const VALYU_COUNTRY_CODES = [
  'ALL',
  'AR',
  'AU',
  'AT',
  'BE',
  'BR',
  'CA',
  'CL',
  'DK',
  'FI',
  'FR',
  'DE',
  'HK',
  'IN',
  'ID',
  'IT',
  'JP',
  'KR',
  'MY',
  'MX',
  'NL',
  'NZ',
  'NO',
  'CN',
  'PL',
  'PT',
  'PH',
  'RU',
  'SA',
  'ZA',
  'ES',
  'SE',
  'CH',
  'TW',
  'TR',
  'GB',
  'US',
] as const;

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value)
    );
  }, 'Expected a real calendar date');
const sources = z.array(z.string().trim().min(1)).nonempty();
const biases = z.record(
  z.string().trim().min(1),
  z.number().int().min(-5).max(5),
);
const responseLength = z.union([
  z.enum(['short', 'medium', 'large', 'max']),
  z.number().int().positive(),
]);
const httpUrlWithoutCredentials = z
  .string()
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username &&
      !parsed.password
    );
  }, 'Expected an HTTP(S) URL without embedded credentials');

function dateRange(
  value: { startDate?: string; endDate?: string },
  ctx: z.RefinementCtx,
): void {
  if (value.startDate && value.endDate && value.startDate > value.endDate) {
    ctx.addIssue({
      code: 'custom',
      path: ['endDate'],
      message: 'endDate must be on or after startDate',
    });
  }
}

export const ValyuSearchOptionsSchema = z
  .strictObject({
    maxResults: z.number().int().min(1).max(20).optional(),
    searchType: z.enum(['all', 'web', 'proprietary', 'news']).optional(),
    maxPrice: z.number().positive().optional(),
    relevanceThreshold: z.number().min(0).max(1).optional(),
    includedSources: sources.optional(),
    excludedSources: sources.optional(),
    sourceBiases: biases.optional(),
    instructions: z.string().trim().min(1).max(500).optional(),
    isToolCall: z.boolean().optional(),
    responseLength: responseLength.optional(),
    startDate: date.optional(),
    endDate: date.optional(),
    countryCode: z.enum(VALYU_COUNTRY_CODES).optional(),
    fastMode: z.boolean().optional(),
    urlOnly: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    dateRange(value, ctx);
    if (value.includedSources && value.excludedSources) {
      ctx.addIssue({
        code: 'custom',
        path: ['excludedSources'],
        message: 'includedSources and excludedSources are mutually exclusive',
      });
    }
    if (value.fastMode && value.searchType === 'proprietary') {
      ctx.addIssue({
        code: 'custom',
        path: ['fastMode'],
        message: 'fastMode cannot be used with proprietary search',
      });
    }
    if (
      value.urlOnly &&
      value.searchType !== 'web' &&
      value.searchType !== 'news'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['urlOnly'],
        message: 'urlOnly requires searchType web or news',
      });
    }
    if (value.fastMode || value.urlOnly) {
      for (const key of [
        'relevanceThreshold',
        'sourceBiases',
        'instructions',
      ] as const) {
        if (value[key] !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is unavailable when reranking is bypassed`,
          });
        }
      }
    }
  });

export type ValyuSearchOptions = z.infer<typeof ValyuSearchOptionsSchema>;

export const ValyuResearchSearchOptionsSchema = z
  .strictObject({
    searchType: z.enum(['all', 'web', 'proprietary']).optional(),
    includedSources: sources.optional(),
    excludedSources: sources.optional(),
    sourceBiases: biases.optional(),
    startDate: date.optional(),
    endDate: date.optional(),
    countryCode: z.enum(VALYU_COUNTRY_CODES).optional(),
  })
  .superRefine((value, ctx) => {
    dateRange(value, ctx);
    if (value.includedSources && value.excludedSources) {
      ctx.addIssue({
        code: 'custom',
        path: ['excludedSources'],
        message: 'includedSources and excludedSources are mutually exclusive',
      });
    }
  });

export const ValyuResearchOptionsSchema = z
  .strictObject({
    mode: z.enum(['fast', 'standard', 'heavy', 'max']).optional(),
    researchStrategy: z.string().trim().min(1).max(15_000).optional(),
    reportFormat: z.string().trim().min(1).max(15_000).optional(),
    search: ValyuResearchSearchOptionsSchema.optional(),
    urls: z.array(httpUrlWithoutCredentials).nonempty().max(10).optional(),
    outputFormats: z
      .union([
        z.tuple([z.literal('markdown')]),
        z.tuple([z.literal('markdown'), z.literal('pdf')]),
      ])
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.researchStrategy?.length ?? 0) +
        (value.reportFormat?.length ?? 0) >
      15_000
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['reportFormat'],
        message:
          'researchStrategy and reportFormat cannot exceed 15000 characters combined',
      });
    }
  });

export type ValyuResearchOptions = z.infer<typeof ValyuResearchOptionsSchema>;
