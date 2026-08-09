import { z } from 'zod/v4';
import {
  ExtensionsSchema,
  OpaqueIdSchema,
  Rfc3339UtcSchema,
} from '../common.js';
import {
  CorpusSchema,
  ExecutionProfileSchema,
  GroundingPolicySchema,
  ObservationModeSchema,
  ResultKindSchema,
  RetrievalMethodSchema,
  SurfaceContextConstraintSchema,
} from '../domain/index.js';
import {
  compatibilityIssues,
  fallbackCompatibilityIssues,
  profileKey,
} from './compatibility.js';

export const INTERCHANGE_VERSION = '1.0.0' as const;

export const ExecutionModeSchema = z.enum(['sync', 'async']);

export const EvidenceRequirementsSchema = z
  .strictObject({
    result_kind: ResultKindSchema,
    grounding_policy: GroundingPolicySchema.optional(),
    observation_mode: ObservationModeSchema.optional(),
    corpora: z.array(CorpusSchema).max(8),
    retrieval_methods: z.array(RetrievalMethodSchema).max(8).optional(),
    surface_id: OpaqueIdSchema.optional(),
    surface_context_constraint: SurfaceContextConstraintSchema.optional(),
  })
  .superRefine((requirements, ctx) => {
    if (
      requirements.result_kind === 'search_results' &&
      requirements.grounding_policy !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Search-results requirements must omit inapplicable grounding_policy',
        path: ['grounding_policy'],
      });
    } else if (
      requirements.result_kind !== 'search_results' &&
      requirements.grounding_policy === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Non-search requirements require grounding_policy',
        path: ['grounding_policy'],
      });
    }
  });

export const RequestSlotSchema = z.strictObject({
  slot_id: OpaqueIdSchema,
  position: z.number().int().nonnegative().safe(),
  requirements: EvidenceRequirementsSchema,
  primary: ExecutionProfileSchema,
  extensions: ExtensionsSchema.optional(),
});

export const FallbackCandidateSchema = z.strictObject({
  candidate_id: OpaqueIdSchema,
  position: z.number().int().nonnegative().safe(),
  profile: ExecutionProfileSchema,
  eligible_slot_ids: z.array(OpaqueIdSchema).min(1).max(64),
  extensions: ExtensionsSchema.optional(),
});

export const InterchangeRequestSchema = z
  .strictObject({
    interchange_version: z.literal(INTERCHANGE_VERSION),
    message_type: z.literal('request'),
    request_id: OpaqueIdSchema,
    requested_at: Rfc3339UtcSchema,
    mode: ExecutionModeSchema,
    query: z.string().min(1).max(100_000),
    slots: z.array(RequestSlotSchema).min(1).max(64),
    fallback_reserve: z.array(FallbackCandidateSchema).max(64),
    extensions: ExtensionsSchema.optional(),
  })
  .superRefine((request, ctx) => {
    const slotById = new Map(request.slots.map((slot) => [slot.slot_id, slot]));
    const profilePaths = new Map<string, PropertyKey[]>();
    const slotIds = new Set<string>();

    request.slots.forEach((slot, index) => {
      if (slotIds.has(slot.slot_id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'slot_id values must be unique',
          path: ['slots', index, 'slot_id'],
        });
      }
      slotIds.add(slot.slot_id);
      if (slot.position !== index) {
        ctx.addIssue({
          code: 'custom',
          message: 'Slot positions must be contiguous and match array order',
          path: ['slots', index, 'position'],
        });
      }
      const incompatible = compatibilityIssues(slot.requirements, slot.primary);
      if (incompatible.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: `Primary profile is incompatible with slot requirements: ${incompatible.join(', ')}`,
          path: ['slots', index, 'primary'],
        });
      }
      const key = profileKey(slot.primary);
      if (profilePaths.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Each exact provider profile target may execute at most once per request',
          path: ['slots', index, 'primary', 'identity'],
        });
      }
      profilePaths.set(key, ['slots', index, 'primary', 'identity']);
      if (request.mode === 'async' && slot.primary.resumability !== 'durable') {
        ctx.addIssue({
          code: 'custom',
          message:
            'Async requests require every selected profile to be durable',
          path: ['slots', index, 'primary', 'resumability'],
        });
      }
    });

    const candidateIds = new Set<string>();
    request.fallback_reserve.forEach((candidate, index) => {
      if (candidateIds.has(candidate.candidate_id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'candidate_id values must be unique',
          path: ['fallback_reserve', index, 'candidate_id'],
        });
      }
      candidateIds.add(candidate.candidate_id);
      if (candidate.position !== index) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Fallback positions must be contiguous and match reserve order',
          path: ['fallback_reserve', index, 'position'],
        });
      }
      const key = profileKey(candidate.profile);
      if (profilePaths.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Each exact provider profile target may appear only once in the primary and reserve plan',
          path: ['fallback_reserve', index, 'profile', 'identity'],
        });
      }
      profilePaths.set(key, ['fallback_reserve', index, 'profile', 'identity']);
      if (
        request.mode === 'async' &&
        candidate.profile.resumability !== 'durable'
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Async requests require every reserve profile to be durable',
          path: ['fallback_reserve', index, 'profile', 'resumability'],
        });
      }
      const eligibleIds = new Set<string>();
      candidate.eligible_slot_ids.forEach((slotId, slotIndex) => {
        if (eligibleIds.has(slotId)) {
          ctx.addIssue({
            code: 'custom',
            message: 'eligible_slot_ids must be unique',
            path: ['fallback_reserve', index, 'eligible_slot_ids', slotIndex],
          });
        }
        eligibleIds.add(slotId);
        const slot = slotById.get(slotId);
        if (!slot) {
          ctx.addIssue({
            code: 'custom',
            message: 'Fallback candidate references an unknown slot',
            path: ['fallback_reserve', index, 'eligible_slot_ids', slotIndex],
          });
          return;
        }
        const incompatible = fallbackCompatibilityIssues(
          slot,
          candidate.profile,
        );
        if (incompatible.length > 0) {
          ctx.addIssue({
            code: 'custom',
            message: `Fallback profile is incompatible with the referenced slot: ${incompatible.join(', ')}`,
            path: ['fallback_reserve', index, 'eligible_slot_ids', slotIndex],
          });
        }
      });
    });
  });

export type EvidenceRequirements = z.infer<typeof EvidenceRequirementsSchema>;
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
export type FallbackCandidate = z.infer<typeof FallbackCandidateSchema>;
export type InterchangeRequest = z.infer<typeof InterchangeRequestSchema>;
export type RequestSlot = z.infer<typeof RequestSlotSchema>;
