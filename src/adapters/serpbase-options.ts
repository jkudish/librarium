import { z } from 'zod';

const commonSerpBaseOptions = z.object({
  creditUsd: z.number().finite().positive().optional(),
  hl: z.string().trim().min(1).optional(),
  gl: z.string().trim().min(1).optional(),
  page: z.number().int().min(1).optional(),
});

/** SerpBase Google Search options; every field maps to the documented endpoint. */
export const SerpBaseSearchOptionsSchema = commonSerpBaseOptions
  .extend({
    device: z.enum(['default', 'pc', 'mobile']).optional(),
    includeRichResults: z.boolean().default(false),
  })
  .strict();

/** SerpBase Google News does not accept Search's device or rich-result options. */
export const SerpBaseNewsOptionsSchema = commonSerpBaseOptions.strict();

export type SerpBaseSearchOptions = z.infer<typeof SerpBaseSearchOptionsSchema>;
export type SerpBaseNewsOptions = z.infer<typeof SerpBaseNewsOptionsSchema>;
