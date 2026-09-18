import { z } from 'zod/v4';
import {
  ExtensionsSchema,
  NamespacedKeySchema,
  OpaqueIdSchema,
} from '../common.js';
import { ProviderIdentitySchema } from './identity.js';
import { AccessModeSchema, SurfaceContextSchema } from './semantic.js';

export const CorrelationKeysSchema = z
  .record(NamespacedKeySchema, z.string().min(1).max(512))
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 32) {
      ctx.addIssue({
        code: 'custom',
        message: 'Correlation keys must contain at most 32 entries',
      });
    }
  });

export const CollectionProvenanceSchema = z.strictObject({
  provider: ProviderIdentitySchema,
  access_mode: AccessModeSchema,
  operator_id: OpaqueIdSchema,
  collector_id: OpaqueIdSchema.optional(),
  surface_id: OpaqueIdSchema.optional(),
  surface_context: SurfaceContextSchema.optional(),
  origin_key: OpaqueIdSchema.optional(),
  correlation_keys: CorrelationKeysSchema.optional(),
  extensions: ExtensionsSchema.optional(),
});

export type CollectionProvenance = z.infer<typeof CollectionProvenanceSchema>;
export type CorrelationKeys = z.infer<typeof CorrelationKeysSchema>;
