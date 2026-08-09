import { z } from 'zod/v4';
import {
  ExtensionsSchema,
  jsonValuesEqual,
  OpaqueIdSchema,
  Rfc3339UtcSchema,
} from '../common.js';
import { ProviderIdentitySchema } from './identity.js';
import {
  AccessModeSchema,
  CorpusSchema,
  GroundingPolicySchema,
  ObservationModeSchema,
  ResultKindSchema,
  RetrievalMethodSchema,
  SurfaceContextSchema,
} from './semantic.js';

export const InvocationSchema = z.enum(['inline', 'background']);
export const ResumabilitySchema = z.enum(['none', 'process_local', 'durable']);

const ResearchProfileObjectSchema = z.strictObject({
  identity: ProviderIdentitySchema,
  result_kind: ResultKindSchema,
  grounding_policy: GroundingPolicySchema.optional(),
  observation_mode: ObservationModeSchema,
  corpora: z.array(CorpusSchema).max(8),
  retrieval_method: RetrievalMethodSchema,
  access_mode: AccessModeSchema,
  operator_id: OpaqueIdSchema,
  collector_id: OpaqueIdSchema.optional(),
  surface_id: OpaqueIdSchema.optional(),
  surface_context: SurfaceContextSchema.optional(),
  extensions: ExtensionsSchema.optional(),
});

type ResearchProfileFields = z.infer<typeof ResearchProfileObjectSchema>;

const refineResearchProfile = (
  profile: ResearchProfileFields,
  ctx: z.RefinementCtx,
): void => {
  if (
    profile.result_kind === 'search_results' &&
    profile.grounding_policy !== undefined
  ) {
    ctx.addIssue({
      code: 'custom',
      message:
        'Search-results profiles must omit inapplicable grounding_policy',
      path: ['grounding_policy'],
    });
  } else if (
    profile.result_kind !== 'search_results' &&
    profile.grounding_policy === undefined
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Non-search profiles require grounding_policy',
      path: ['grounding_policy'],
    });
  }
  if (
    profile.result_kind === 'surface_observation' &&
    profile.surface_id === undefined
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Surface-observation profiles require surface_id',
      path: ['surface_id'],
    });
  }
  if (profile.observation_mode === 'surface_snapshot') {
    if (profile.result_kind !== 'surface_observation') {
      ctx.addIssue({
        code: 'custom',
        message: 'Surface-snapshot profiles must produce surface observations',
        path: ['result_kind'],
      });
    }
    if (profile.retrieval_method !== 'surface_collector') {
      ctx.addIssue({
        code: 'custom',
        message:
          'Surface-snapshot profiles must use the surface_collector retrieval method',
        path: ['retrieval_method'],
      });
    }
    if (profile.collector_id === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Surface-snapshot profiles require collector_id',
        path: ['collector_id'],
      });
    }
    if (profile.access_mode !== 'collected') {
      ctx.addIssue({
        code: 'custom',
        message: 'Surface-snapshot profiles must use collected access',
        path: ['access_mode'],
      });
    }
  }
};

/** Descriptive profile facts allowed in the shared terminal response. */
export const ResearchProfileSchema = ResearchProfileObjectSchema.superRefine(
  refineResearchProfile,
);

export const ExecutionProfileSchema = z
  .strictObject({
    ...ResearchProfileObjectSchema.shape,
    invocation: InvocationSchema,
    resumability: ResumabilitySchema,
  })
  .superRefine((profile, ctx) => {
    refineResearchProfile(profile, ctx);
    if (profile.invocation === 'inline' && profile.resumability !== 'none') {
      ctx.addIssue({
        code: 'custom',
        message: 'Inline profiles must use none resumability',
        path: ['resumability'],
      });
    }
    if (
      profile.invocation === 'background' &&
      profile.resumability === 'none'
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Background profiles must use process_local or durable resumability',
        path: ['resumability'],
      });
    }
  });

export const DurableHandleStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

export const DurableHandleSchema = z.strictObject({
  handle_id: OpaqueIdSchema,
  provider_task_id: OpaqueIdSchema.describe(
    'Non-secret public provider reference; resume credentials remain adapter-local',
  ),
  provider: ProviderIdentitySchema,
  submitted_at: Rfc3339UtcSchema,
  last_observed_at: Rfc3339UtcSchema.optional(),
  status: DurableHandleStatusSchema,
  extensions: ExtensionsSchema.optional(),
});

export type DurableHandle = z.infer<typeof DurableHandleSchema>;
export type DurableHandleStatus = z.infer<typeof DurableHandleStatusSchema>;
export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;
export type ResearchProfile = z.infer<typeof ResearchProfileSchema>;
export type Invocation = z.infer<typeof InvocationSchema>;
export type Resumability = z.infer<typeof ResumabilitySchema>;

export const providerIdentitiesEqual = (
  left: z.infer<typeof ProviderIdentitySchema>,
  right: z.infer<typeof ProviderIdentitySchema>,
): boolean => jsonValuesEqual(left, right);

export const executionProfilesEqual = (
  left: ExecutionProfile,
  right: ExecutionProfile,
): boolean => jsonValuesEqual(left, right);
