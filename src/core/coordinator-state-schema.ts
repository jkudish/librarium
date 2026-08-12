import { z } from 'zod/v4';
import { OpaqueIdSchema, Rfc3339UtcSchema } from '../contracts/common.js';
import {
  DurableHandleSchema,
  ExecutionProfileSchema,
  ProviderIdentitySchema,
  StructuredErrorSchema,
} from '../contracts/domain/index.js';
import { LifecycleTraceSchema } from '../contracts/interchange/lifecycle.js';
import type { CoordinatorState } from './coordinator.js';
import { profileIdentityKey } from './execution-plan.js';

const NonNegativeDecimalIntegerSchema = z
  .string()
  .max(128)
  .regex(/^(?:0|[1-9]\d*)$/, 'Expected a non-negative decimal integer');

const AdapterBindingIdentitySchema = z.strictObject({
  adapter_id: OpaqueIdSchema,
  binding_id: OpaqueIdSchema,
});

const NetworkFreeEstimateSchema = z.strictObject({
  estimated_cost_microusd: NonNegativeDecimalIntegerSchema.optional(),
  billable_units: z
    .array(
      z.strictObject({
        unit: z.string().min(1),
        quantity: z.string().min(1),
      }),
    )
    .optional(),
});

const PreparedProfilePlanSchema = z.strictObject({
  profile_key: z.string().min(1),
  identity: ProviderIdentitySchema,
  binding: AdapterBindingIdentitySchema,
  estimate: NetworkFreeEstimateSchema.optional(),
});

const CoordinatorSlotStatusSchema = z.enum([
  'unstarted',
  'fallback_pending',
  'dispatch_pending',
  'submitting',
  'acceptance_unknown',
  'submitted',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
]);

const CoordinatorAttemptStatusSchema = z.enum([
  'dispatch_pending',
  'submitting',
  'acceptance_unknown',
  'submitted',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
]);

const CoordinatorSlotStateSchema = z.strictObject({
  slot_id: OpaqueIdSchema,
  position: z.number().int().safe().nonnegative(),
  primary: ExecutionProfileSchema,
  status: CoordinatorSlotStatusSchema,
  deadline_at: Rfc3339UtcSchema,
  refined_query: z.string().min(1).optional(),
  latest_attempt_id: OpaqueIdSchema.optional(),
  result_id: OpaqueIdSchema.optional(),
  error: StructuredErrorSchema.optional(),
  fallback_exhausted: z.boolean(),
});

const CoordinatorAttemptStateSchema = z.strictObject({
  attempt_id: OpaqueIdSchema,
  slot_id: OpaqueIdSchema,
  attempt_number: z.number().int().safe().positive(),
  round: z.number().int().safe().nonnegative(),
  profile: ExecutionProfileSchema,
  status: CoordinatorAttemptStatusSchema,
  query: z.string().min(1),
  queued_at: Rfc3339UtcSchema,
  started_at: Rfc3339UtcSchema.optional(),
  deadline_at: Rfc3339UtcSchema,
  delivery_lease_id: OpaqueIdSchema.optional(),
  delivery_lease_expires_at: Rfc3339UtcSchema.optional(),
  finished_at: Rfc3339UtcSchema.optional(),
  replaces_attempt_id: OpaqueIdSchema.optional(),
  candidate_id: OpaqueIdSchema.optional(),
  adapter_state_ref: OpaqueIdSchema.optional(),
  durable_handle: DurableHandleSchema.optional(),
  transient_poll_error: StructuredErrorSchema.optional(),
  result_id: OpaqueIdSchema.optional(),
  error: StructuredErrorSchema.optional(),
  reserved_estimated_cost_microusd: NonNegativeDecimalIntegerSchema,
  actual_cost_microusd: NonNegativeDecimalIntegerSchema.optional(),
});

const CoordinatorReserveCandidateSchema = z.strictObject({
  candidate_id: OpaqueIdSchema,
  position: z.number().int().safe().nonnegative(),
  profile: ExecutionProfileSchema,
  eligible_slot_ids: z.array(OpaqueIdSchema).min(1),
  claimed_by_slot_id: OpaqueIdSchema.optional(),
});

const PendingFallbackLaunchSchema = z.strictObject({
  attempt_id: OpaqueIdSchema,
  slot_id: OpaqueIdSchema,
  attempt_number: z.number().int().safe().positive(),
  round: z.number().int().safe().positive(),
  candidate_id: OpaqueIdSchema,
  replaces_attempt_id: OpaqueIdSchema,
});

const UnresolvedAcceptanceSchema = z.strictObject({
  attempt_id: OpaqueIdSchema,
  profile_key: z.string().min(1),
  observed_at: Rfc3339UtcSchema,
  reason: z.enum([
    'submission_response_uncertain',
    'submission_deadline_exceeded',
    'request_deadline_exceeded',
    'cancelled_while_acceptance_unknown',
    'infrastructure_failure_while_acceptance_unknown',
  ]),
  adapter_state_ref: OpaqueIdSchema.optional(),
});

/**
 * Strict persisted form of the Worker-safe coordinator state.
 *
 * The reducer owns semantic transitions. This schema is the storage trust
 * boundary and rejects unknown or malformed recovery fields before they can be
 * supplied to the reducer.
 */
export const CoordinatorStateSchema = z
  .strictObject({
    request_id: OpaqueIdSchema,
    mode: z.enum(['sync', 'async']),
    original_query: z.string().min(1),
    status: z.enum([
      'running',
      'succeeded',
      'partial',
      'unsuccessful',
      'cancelled',
      'failed',
    ]),
    created_at: Rfc3339UtcSchema,
    request_deadline_at: Rfc3339UtcSchema,
    inline_attempt_deadline_ms: z.number().int().safe().positive(),
    background_attempt_deadline_ms: z.number().int().safe().positive(),
    poll_interval_ms: z.number().int().safe().positive(),
    max_concurrency: z.number().int().safe().positive(),
    catalog_revision: z.string().min(1),
    catalog_digest: z.string().min(1),
    slots: z.array(CoordinatorSlotStateSchema).min(1).max(64),
    attempts: z.array(CoordinatorAttemptStateSchema).max(256),
    reserve: z.array(CoordinatorReserveCandidateSchema).max(64),
    pending_fallbacks: z.array(PendingFallbackLaunchSchema).max(64),
    used_profile_keys: z.array(z.string().min(1)).max(128),
    unresolved_acceptances: z.array(UnresolvedAcceptanceSchema).max(256),
    profile_plans_by_identity: z.record(
      z.string().min(1),
      PreparedProfilePlanSchema,
    ),
    budget: z.strictObject({
      max_estimated_cost_microusd: NonNegativeDecimalIntegerSchema.optional(),
      max_actual_cost_microusd: NonNegativeDecimalIntegerSchema.optional(),
      reserved_estimated_cost_microusd: NonNegativeDecimalIntegerSchema,
      actual_cost_microusd: NonNegativeDecimalIntegerSchema,
    }),
    cancellation: z
      .strictObject({
        requested_at: Rfc3339UtcSchema,
        error: StructuredErrorSchema.optional(),
      })
      .optional(),
    infrastructure_error: StructuredErrorSchema.optional(),
    lifecycle_sequence: z.number().int().safe().nonnegative(),
    lifecycle: LifecycleTraceSchema,
  })
  .superRefine((state, ctx) => {
    if (state.lifecycle_sequence !== state.lifecycle.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Lifecycle sequence must equal the persisted event count',
        path: ['lifecycle_sequence'],
      });
    }
    if (
      state.lifecycle.some((event) => event.request_id !== state.request_id)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Lifecycle request ids must match coordinator request_id',
        path: ['lifecycle'],
      });
    }
    if (state.lifecycle[0]?.sequence !== 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Lifecycle sequence must start at zero',
        path: ['lifecycle', 0, 'sequence'],
      });
    }
    state.lifecycle.forEach((event, index) => {
      if (event.sequence !== index) {
        ctx.addIssue({
          code: 'custom',
          message: 'Lifecycle sequence must be contiguous',
          path: ['lifecycle', index, 'sequence'],
        });
      }
    });
    const started = state.lifecycle[0];
    if (
      started?.event_kind !== 'request_started' ||
      started.data.mode !== state.mode
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Request-started lifecycle event must match coordinator mode',
        path: ['lifecycle', 0],
      });
    }
    const terminalEvents = state.lifecycle.filter((event) =>
      ['request_completed', 'request_failed', 'request_cancelled'].includes(
        event.event_kind,
      ),
    );
    if (state.status === 'running' && terminalEvents.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Running coordinator state cannot contain a terminal event',
        path: ['lifecycle'],
      });
    }
    if (state.status !== 'running' && terminalEvents.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Terminal coordinator state requires exactly one terminal event',
        path: ['lifecycle'],
      });
    }
    if (
      state.status !== 'running' &&
      (state.pending_fallbacks.length > 0 ||
        state.slots.some((slot) =>
          [
            'unstarted',
            'fallback_pending',
            'dispatch_pending',
            'submitting',
            'acceptance_unknown',
            'submitted',
            'running',
          ].includes(slot.status),
        ) ||
        state.attempts.some((attempt) =>
          [
            'dispatch_pending',
            'submitting',
            'acceptance_unknown',
            'submitted',
            'running',
          ].includes(attempt.status),
        ))
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Terminal coordinator state requires terminal slots and attempts with no pending fallbacks',
        path: ['status'],
      });
    }

    const slotIds = new Set<string>();
    state.slots.forEach((slot, index) => {
      if (slotIds.has(slot.slot_id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Coordinator slot ids must be unique',
          path: ['slots', index, 'slot_id'],
        });
      }
      slotIds.add(slot.slot_id);
      if (slot.position !== index) {
        ctx.addIssue({
          code: 'custom',
          message: 'Coordinator slot positions must match array order',
          path: ['slots', index, 'position'],
        });
      }
    });

    const attemptIds = new Set<string>();
    const attemptsById = new Map<string, (typeof state.attempts)[number]>();
    state.attempts.forEach((attempt, index) => {
      if (attemptIds.has(attempt.attempt_id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Coordinator attempt ids must be unique',
          path: ['attempts', index, 'attempt_id'],
        });
      }
      attemptIds.add(attempt.attempt_id);
      attemptsById.set(attempt.attempt_id, attempt);
      if (!slotIds.has(attempt.slot_id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Coordinator attempts must reference an existing slot',
          path: ['attempts', index, 'slot_id'],
        });
      }
      if (
        (attempt.status === 'submitted' || attempt.status === 'running') &&
        attempt.profile.resumability === 'durable' &&
        !attempt.durable_handle
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Accepted durable attempts require a persisted durable handle',
          path: ['attempts', index, 'durable_handle'],
        });
      }
      if (attempt.replaces_attempt_id) {
        const replaced = state.attempts.find(
          (candidate) => candidate.attempt_id === attempt.replaces_attempt_id,
        );
        if (
          !replaced ||
          replaced.slot_id !== attempt.slot_id ||
          replaced.attempt_number + 1 !== attempt.attempt_number ||
          (replaced.status !== 'failed' && replaced.status !== 'timed_out') ||
          replaced.error?.fallback_allowed !== true
        ) {
          ctx.addIssue({
            code: 'custom',
            message:
              'Replacement attempts must immediately follow a replaceable failed attempt in the same slot',
            path: ['attempts', index, 'replaces_attempt_id'],
          });
        }
      }
      if (
        (attempt.status === 'submitted' || attempt.status === 'running') &&
        attempt.durable_handle &&
        !['pending', 'running'].includes(attempt.durable_handle.status)
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Active durable attempts require a pending or running handle',
          path: ['attempts', index, 'durable_handle', 'status'],
        });
      }
      if (
        attempt.status === 'succeeded' &&
        attempt.durable_handle &&
        attempt.durable_handle.status !== 'succeeded'
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Succeeded durable attempts require a succeeded handle',
          path: ['attempts', index, 'durable_handle', 'status'],
        });
      }
      if (
        attempt.durable_handle &&
        (attempt.profile.invocation === 'inline' ||
          attempt.profile.resumability !== 'durable')
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Only durable background attempts may retain durable handles',
          path: ['attempts', index, 'durable_handle'],
        });
      }
    });

    state.slots.forEach((slot, index) => {
      const latestAttempt = slot.latest_attempt_id
        ? attemptsById.get(slot.latest_attempt_id)
        : undefined;
      if (slot.latest_attempt_id !== undefined && !latestAttempt) {
        ctx.addIssue({
          code: 'custom',
          message: 'Latest attempt ids must reference a persisted attempt',
          path: ['slots', index, 'latest_attempt_id'],
        });
      } else if (latestAttempt && latestAttempt.slot_id !== slot.slot_id) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Latest attempt ids must reference an attempt in the same slot',
          path: ['slots', index, 'latest_attempt_id'],
        });
      }
    });

    const profileKeys = new Set(Object.keys(state.profile_plans_by_identity));
    for (const [key, plan] of Object.entries(state.profile_plans_by_identity)) {
      if (
        key !== plan.profile_key ||
        key !== profileIdentityKey(plan.identity)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Profile-plan keys must match their exact provider identity',
          path: ['profile_plans_by_identity', key],
        });
      }
    }
    const referencedProfiles = [
      ...state.slots.map((slot) => slot.primary),
      ...state.reserve.map((candidate) => candidate.profile),
      ...state.attempts.map((attempt) => attempt.profile),
    ];
    referencedProfiles.forEach((profile, index) => {
      if (!profileKeys.has(profileIdentityKey(profile.identity))) {
        ctx.addIssue({
          code: 'custom',
          message: 'Every coordinator profile requires an exact frozen plan',
          path: ['profile_plans_by_identity', index],
        });
      }
    });
    if (
      new Set(state.used_profile_keys).size !== state.used_profile_keys.length
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Used profile keys must be unique',
        path: ['used_profile_keys'],
      });
    }
    state.used_profile_keys.forEach((key, index) => {
      if (!profileKeys.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Used profile keys must reference a frozen profile plan',
          path: ['used_profile_keys', index],
        });
      }
    });
    state.unresolved_acceptances.forEach((unresolved, index) => {
      const attempt = state.attempts.find(
        (candidate) => candidate.attempt_id === unresolved.attempt_id,
      );
      if (
        attempt?.profile.resumability !== 'durable' ||
        unresolved.profile_key !==
          profileIdentityKey(attempt.profile.identity) ||
        (unresolved.adapter_state_ref !== undefined &&
          unresolved.adapter_state_ref !== attempt.adapter_state_ref)
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Unresolved acceptance must match an exact durable attempt and adapter reference',
          path: ['unresolved_acceptances', index],
        });
      }
    });
    const candidateClaims = new Set<string>();
    state.reserve.forEach((candidate, index) => {
      if (candidate.claimed_by_slot_id) {
        if (
          !candidate.eligible_slot_ids.includes(candidate.claimed_by_slot_id) ||
          !slotIds.has(candidate.claimed_by_slot_id)
        ) {
          ctx.addIssue({
            code: 'custom',
            message: 'Fallback candidate claims must name an eligible slot',
            path: ['reserve', index, 'claimed_by_slot_id'],
          });
        }
        if (candidateClaims.has(candidate.candidate_id)) {
          ctx.addIssue({
            code: 'custom',
            message: 'Fallback candidates can be claimed only once',
            path: ['reserve', index, 'candidate_id'],
          });
        }
        candidateClaims.add(candidate.candidate_id);
      }
    });
    state.pending_fallbacks.forEach((pending, index) => {
      const candidate = state.reserve.find(
        (entry) => entry.candidate_id === pending.candidate_id,
      );
      const replaced = state.attempts.find(
        (attempt) => attempt.attempt_id === pending.replaces_attempt_id,
      );
      if (
        !candidate ||
        candidate.claimed_by_slot_id !== pending.slot_id ||
        !candidate.eligible_slot_ids.includes(pending.slot_id) ||
        !replaced ||
        replaced.slot_id !== pending.slot_id ||
        (replaced.status !== 'failed' && replaced.status !== 'timed_out') ||
        replaced.error?.fallback_allowed !== true
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Pending fallback must match a claimed eligible candidate and failed replaceable attempt',
          path: ['pending_fallbacks', index],
        });
      }
    });
  });

export function parseCoordinatorState(value: unknown): CoordinatorState {
  return CoordinatorStateSchema.parse(value) as CoordinatorState;
}
