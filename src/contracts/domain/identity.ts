import { z } from 'zod/v4';
import { OpaqueIdSchema } from '../common.js';

export const TargetKindSchema = z.enum(['model', 'agent', 'preset']);
export const ModelSelectionSchema = z.enum([
  'configurable',
  'fixed',
  'provider_managed',
  'not_applicable',
]);

export const ProfileTargetSlotSchema = z
  .strictObject({
    model_selection: ModelSelectionSchema,
    kind: TargetKindSchema.optional(),
    target_id: OpaqueIdSchema.optional(),
  })
  .superRefine((slot, ctx) => {
    if (
      slot.model_selection === 'configurable' ||
      slot.model_selection === 'fixed'
    ) {
      if (slot.kind === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `${slot.model_selection} targets require kind`,
          path: ['kind'],
        });
      }
      if (slot.target_id === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `${slot.model_selection} targets require target_id`,
          path: ['target_id'],
        });
      }
      return;
    }

    if (
      slot.model_selection === 'provider_managed' &&
      slot.target_id !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'provider_managed targets must omit target_id until the provider reports it at runtime',
        path: ['target_id'],
      });
    }

    if (slot.model_selection === 'not_applicable') {
      if (slot.kind !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'not_applicable targets must omit kind',
          path: ['kind'],
        });
      }
      if (slot.target_id !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'not_applicable targets must omit target_id',
          path: ['target_id'],
        });
      }
    }
  });

export const ProfileTargetSchema = z
  .strictObject({
    primary: ProfileTargetSlotSchema,
    underlying: ProfileTargetSlotSchema.optional(),
  })
  .superRefine((target, ctx) => {
    const underlying = target.underlying;
    if (!underlying) return;

    if (target.primary.kind !== 'agent' && target.primary.kind !== 'preset') {
      ctx.addIssue({
        code: 'custom',
        message:
          'Underlying targets require a primary target whose kind is agent or preset',
        path: ['underlying'],
      });
    }
    if (
      underlying.model_selection !== 'configurable' &&
      underlying.model_selection !== 'fixed'
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Underlying targets must be separately configurable or fixed',
        path: ['underlying', 'model_selection'],
      });
    }
    if (underlying.kind !== 'model') {
      ctx.addIssue({
        code: 'custom',
        message:
          'Underlying targets must identify a model, not nested agents or presets',
        path: ['underlying', 'kind'],
      });
    }
  });

export const RuntimeEffectiveTargetSchema = z.strictObject({
  source: z.literal('provider_reported'),
  kind: TargetKindSchema,
  target_id: OpaqueIdSchema,
});

export const ProviderIdentitySchema = z.strictObject({
  provider_id: OpaqueIdSchema,
  profile_id: OpaqueIdSchema,
  target: ProfileTargetSchema,
});

export type ModelSelection = z.infer<typeof ModelSelectionSchema>;
export type ProfileTarget = z.infer<typeof ProfileTargetSchema>;
export type ProfileTargetSlot = z.infer<typeof ProfileTargetSlotSchema>;
export type ProviderIdentity = z.infer<typeof ProviderIdentitySchema>;
export type RuntimeEffectiveTarget = z.infer<
  typeof RuntimeEffectiveTargetSchema
>;
export type TargetKind = z.infer<typeof TargetKindSchema>;

export function providerIdentityKey(identity: ProviderIdentity): string {
  const { primary, underlying } = identity.target;
  return JSON.stringify([
    identity.provider_id,
    identity.profile_id,
    primary.model_selection,
    primary.kind ?? null,
    primary.target_id ?? null,
    underlying?.model_selection ?? null,
    underlying?.kind ?? null,
    underlying?.target_id ?? null,
  ]);
}
