import { z } from 'zod/v4';
import {
  PackageIdentitySchema,
  PackageReleaseSchema,
  Rfc3339UtcSchema,
} from '../common.js';
import {
  ResearchResultSchema,
  TerminalIdSchema,
  UsageSchema,
} from './research-result.js';

export const ResearchErrorSchema = z.strictObject({
  code: z
    .string()
    .min(3)
    .max(255)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:[.:/][A-Za-z0-9_.-]+)+$/,
      'Error codes must be namespaced',
    ),
  message: z.string().min(1).max(2_048),
  profile: z.string().min(1).optional(),
});

/** The entire cross-runtime terminal receipt. */
export const ResearchResponseSchema = z
  .strictObject({
    generator: PackageIdentitySchema,
    generator_version: PackageReleaseSchema,
    request_id: TerminalIdSchema,
    status: z.enum(['succeeded', 'partial', 'failed']),
    completed_at: Rfc3339UtcSchema,
    results: z.array(ResearchResultSchema),
    errors: z.array(ResearchErrorSchema),
    usage: UsageSchema.optional(),
  })
  .superRefine((response, ctx) => {
    const shape =
      (response.status === 'succeeded' &&
        response.results.length >= 1 &&
        response.errors.length === 0) ||
      (response.status === 'partial' &&
        response.results.length >= 1 &&
        response.errors.length >= 1) ||
      (response.status === 'failed' &&
        response.results.length === 0 &&
        response.errors.length >= 1);
    if (!shape) {
      ctx.addIssue({
        code: 'custom',
        message: 'Terminal status must match results and errors',
        path: response.results.length === 0 ? ['results'] : ['errors'],
      });
    }
  });

export type ResearchError = z.infer<typeof ResearchErrorSchema>;
export type ResearchResponse = z.infer<typeof ResearchResponseSchema>;
