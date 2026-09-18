import { z } from 'zod';

const languageNames = new Intl.DisplayNames(['en'], {
  type: 'language',
  fallback: 'none',
});

/** Shared assigned-code source for provider options that accept ISO 3166-1 alpha-2. */
export const ISO_3166_ALPHA2 = new Set(
  `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`.split(
    ' ',
  ),
);

const countryCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'must be an ISO 3166-1 alpha-2 code')
  .transform((value) => value.toUpperCase())
  .refine(
    (value) => ISO_3166_ALPHA2.has(value),
    'must be an ISO 3166-1 alpha-2 code',
  );

const languageCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'must be an ISO 639-1 language code')
  .transform((value) => value.toLowerCase())
  .refine(
    (value) => languageNames.of(value) !== undefined,
    'must be an ISO 639-1 language code',
  );

const domain = z.string().trim().min(1).max(253);
const query = z.string().trim().min(1, 'must not be empty');

/**
 * Strict local configuration for the Perplexity Search API. `perRequestUsd` is
 * Librarium metering metadata, not an upstream Search API parameter.
 */
export const PerplexitySearchOptionsSchema = z
  .object({
    perRequestUsd: z.number().finite().positive().optional(),
    maxResults: z.number().int().min(1).max(20).optional(),
    country: countryCode.optional(),
    searchLanguageFilter: z.array(languageCode).min(1).max(20).optional(),
    searchDomainAllowlist: z.array(domain).min(1).max(20).optional(),
    searchDomainDenylist: z.array(domain).min(1).max(20).optional(),
    searchContextSize: z.enum(['low', 'medium', 'high']).optional(),
    maxTokens: z.number().int().min(1).max(1_000_000).optional(),
    maxTokensPerPage: z.number().int().min(1).max(1_000_000).optional(),
    additionalQueries: z.array(query).max(4).optional(),
  })
  .strict()
  .superRefine((options, context) => {
    if (
      options.searchDomainAllowlist !== undefined &&
      options.searchDomainDenylist !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'searchDomainAllowlist and searchDomainDenylist are mutually exclusive',
        path: ['searchDomainAllowlist'],
      });
    }

    if (
      options.searchContextSize !== undefined &&
      (options.maxTokens !== undefined ||
        options.maxTokensPerPage !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'searchContextSize cannot be combined with maxTokens or maxTokensPerPage',
        path: ['searchContextSize'],
      });
    }
  });

export type PerplexitySearchOptions = z.infer<
  typeof PerplexitySearchOptionsSchema
>;

export function formatPerplexitySearchOptionsError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'options'}: ${issue.message}`)
    .join('; ');
}
