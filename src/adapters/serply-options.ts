import { z } from 'zod';

/** Serply Google Search options; every field maps to the documented endpoint. */
export const SerplyOptionsSchema = z
  .object({
    // Serply serves an unpinned request from whichever proxy region is free,
    // so results drift between calls. The country is always sent.
    gl: z
      .string()
      .regex(/^[a-z]{2}$/, 'gl must be a lowercase two-letter country code')
      .default('us'),
    hl: z.string().trim().min(1).max(16).optional(),
    // Google serves about ten organic results per page; Serply caps num at 10.
    num: z.number().int().min(1).max(10).default(10),
    device: z.enum(['desktop', 'mobile']).optional(),
  })
  .strict();

export type SerplyOptions = z.infer<typeof SerplyOptionsSchema>;
