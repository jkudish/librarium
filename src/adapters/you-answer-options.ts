import { z } from 'zod';

/** Values enumerated by the You.com Answer API reference on 2026-08-13. */
export const YOU_ANSWER_COUNTRIES = [
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

/** Values enumerated by the You.com Answer API reference on 2026-08-13. */
export const YOU_ANSWER_LANGUAGES = [
  'AR',
  'EU',
  'BN',
  'BG',
  'CA',
  'HR',
  'CS',
  'DA',
  'NL',
  'EN',
  'EN-GB',
  'ET',
  'FI',
  'FR',
  'GL',
  'DE',
  'EL',
  'GU',
  'HE',
  'HI',
  'HU',
  'IS',
  'IT',
  'KN',
  'KO',
  'LV',
  'LT',
  'MS',
  'ML',
  'MR',
  'NB',
  'PL',
  'PA',
  'RO',
  'RU',
  'SR',
  'SK',
  'SL',
  'ES',
  'SV',
  'TA',
  'TE',
  'TH',
  'TR',
  'UK',
  'VI',
] as const;

const domain = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/,
    'Expected a valid domain name',
  )
  .transform((value) => value.toLowerCase());

const domains = z.array(domain).min(1).max(500);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value)
    );
  }, 'Expected a real calendar date');
const freshness = z
  .union([
    z.enum(['day', 'week', 'month', 'year']),
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/)
      .superRefine((value, ctx) => {
        const [start, end] = value.split('to') as [string, string];
        for (const [path, candidate] of [
          ['start', start],
          ['end', end],
        ] as const) {
          const parsed = date.safeParse(candidate);
          if (!parsed.success) {
            ctx.addIssue({
              code: 'custom',
              path: [path],
              message: 'Expected a real YYYY-MM-DD date range',
            });
          }
        }
        if (
          date.safeParse(start).success &&
          date.safeParse(end).success &&
          start > end
        ) {
          ctx.addIssue({
            code: 'custom',
            message: 'Freshness range start must be on or before its end',
          });
        }
      }),
  ])
  .optional();

/**
 * Every configured Answer API control is checked before transport creation.
 * The schema intentionally has no target-domain default: source controls are
 * caller intent, not a visibility or evaluation policy.
 */
export const YouAnswerOptionsSchema = z
  .object({
    freshness,
    country: z.enum(YOU_ANSWER_COUNTRIES).optional(),
    language: z.enum(YOU_ANSWER_LANGUAGES).optional(),
    includeDomains: domains.optional(),
    excludeDomains: domains.optional(),
    boostDomains: domains.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.includeDomains && value.excludeDomains) {
      ctx.addIssue({
        code: 'custom',
        path: ['includeDomains'],
        message: 'includeDomains cannot be combined with excludeDomains',
      });
    }
    if (value.includeDomains && value.boostDomains) {
      ctx.addIssue({
        code: 'custom',
        path: ['includeDomains'],
        message: 'includeDomains cannot be combined with boostDomains',
      });
    }
  });

export type YouAnswerOptions = z.infer<typeof YouAnswerOptionsSchema>;

export function validateYouAnswerQuery(query: unknown): string {
  if (typeof query !== 'string' || !/\S/.test(query)) {
    throw new Error('You.com Answer query must not be blank');
  }
  if (query.length > 400) {
    throw new Error('You.com Answer query must contain at most 400 characters');
  }
  return query;
}
