import { z } from 'zod/v4';
import { OpaqueIdSchema } from '../common.js';

export const ProviderIdentitySchema = z.strictObject({
  provider_id: OpaqueIdSchema,
  profile_id: OpaqueIdSchema,
  model_id: OpaqueIdSchema.optional(),
});

export type ProviderIdentity = z.infer<typeof ProviderIdentitySchema>;
