import { z } from 'zod/v4';
import {
  CONTRACT_LIMITS,
  JsonPointerSchema,
  OpaqueIdSchema,
  SnakeCaseNameSchema,
} from '../common.js';

export const ErrorCategorySchema = z.enum([
  'validation',
  'authentication',
  'authorization',
  'rate_limit',
  'timeout',
  'network',
  'provider',
  'budget',
  'cancelled',
  'unsupported',
  'internal',
]);

export const ErrorDetailSchema = z.strictObject({
  detail_code: SnakeCaseNameSchema,
  message: z.string().min(1).max(512),
  field_path: JsonPointerSchema.optional(),
  related_id: OpaqueIdSchema.optional(),
});

export const StructuredErrorSchema = z.strictObject({
  code: SnakeCaseNameSchema,
  message: z.string().min(1).max(CONTRACT_LIMITS.safeMessageLength),
  category: ErrorCategorySchema,
  retryable: z.boolean(),
  fallback_allowed: z.boolean(),
  provider_code: z.string().min(1).max(128).optional(),
  field_path: JsonPointerSchema.optional(),
  details: z.array(ErrorDetailSchema).max(16).optional(),
});

export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;
export type ErrorDetail = z.infer<typeof ErrorDetailSchema>;
export type StructuredError = z.infer<typeof StructuredErrorSchema>;
