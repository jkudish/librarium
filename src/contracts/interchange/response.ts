import { z } from 'zod/v4';
import {
  ExtensionsSchema,
  OpaqueIdSchema,
  Rfc3339UtcSchema,
} from '../common.js';
import {
  DurableHandleSchema,
  ExecutionProfileSchema,
  executionProfilesEqual,
  providerIdentitiesEqual,
  providerIdentityKey,
  StructuredErrorSchema,
  UsageSchema,
} from '../domain/index.js';
import { INTERCHANGE_VERSION } from './request.js';
import { InterchangeResultSchema } from './result.js';

const attemptBase = {
  attempt_id: OpaqueIdSchema,
  slot_id: OpaqueIdSchema,
  attempt_number: z.number().int().positive().safe(),
  profile: ExecutionProfileSchema,
  started_at: Rfc3339UtcSchema,
  replaces_attempt_id: OpaqueIdSchema.optional(),
  candidate_id: OpaqueIdSchema.optional(),
  usage: UsageSchema.optional(),
  extensions: ExtensionsSchema.optional(),
};

export const StartedAttemptSchema = z.strictObject({
  ...attemptBase,
  attempt_status: z.literal('started'),
});

export const SubmittedAttemptSchema = z.strictObject({
  ...attemptBase,
  attempt_status: z.literal('submitted'),
  durable_handle: DurableHandleSchema,
});

export const SucceededAttemptSchema = z.strictObject({
  ...attemptBase,
  attempt_status: z.literal('succeeded'),
  finished_at: Rfc3339UtcSchema,
  result_id: OpaqueIdSchema,
  durable_handle: DurableHandleSchema.optional(),
});

export const FailedAttemptSchema = z.strictObject({
  ...attemptBase,
  attempt_status: z.literal('failed'),
  finished_at: Rfc3339UtcSchema,
  error: StructuredErrorSchema,
  durable_handle: DurableHandleSchema.optional(),
});

export const TimedOutAttemptSchema = z.strictObject({
  ...attemptBase,
  attempt_status: z.literal('timed_out'),
  finished_at: Rfc3339UtcSchema,
  error: StructuredErrorSchema,
  durable_handle: DurableHandleSchema.optional(),
});

export const CancelledAttemptSchema = z.strictObject({
  ...attemptBase,
  attempt_status: z.literal('cancelled'),
  finished_at: Rfc3339UtcSchema,
  error: StructuredErrorSchema.optional(),
  durable_handle: DurableHandleSchema.optional(),
});

export const AttemptSchema = z.discriminatedUnion('attempt_status', [
  StartedAttemptSchema,
  SubmittedAttemptSchema,
  SucceededAttemptSchema,
  FailedAttemptSchema,
  TimedOutAttemptSchema,
  CancelledAttemptSchema,
]);

const slotOutcomeBase = {
  slot_id: OpaqueIdSchema,
  selected_attempt_id: OpaqueIdSchema.optional(),
  extensions: ExtensionsSchema.optional(),
};

export const SlotOutcomeSchema = z.discriminatedUnion('slot_status', [
  z.strictObject({
    ...slotOutcomeBase,
    slot_status: z.literal('pending'),
  }),
  z.strictObject({
    ...slotOutcomeBase,
    slot_status: z.literal('succeeded'),
    selected_attempt_id: OpaqueIdSchema,
    result_id: OpaqueIdSchema,
  }),
  z.strictObject({
    ...slotOutcomeBase,
    slot_status: z.literal('failed'),
    error: StructuredErrorSchema,
  }),
  z.strictObject({
    ...slotOutcomeBase,
    slot_status: z.literal('cancelled'),
    error: StructuredErrorSchema.optional(),
  }),
]);

export const InterchangeResponseSchema = z
  .strictObject({
    interchange_version: z.literal(INTERCHANGE_VERSION),
    message_type: z.literal('response'),
    request_id: OpaqueIdSchema,
    response_status: z.enum([
      'pending',
      'succeeded',
      'partial',
      'failed',
      'cancelled',
      'unsuccessful',
    ]),
    emitted_at: Rfc3339UtcSchema,
    slots: z.array(SlotOutcomeSchema).min(1).max(64),
    attempts: z.array(AttemptSchema).max(256),
    results: z.array(InterchangeResultSchema).max(64),
    errors: z.array(StructuredErrorSchema).max(64),
    extensions: ExtensionsSchema.optional(),
  })
  .superRefine((response, ctx) => {
    const slots = new Map<string, (typeof response.slots)[number]>();
    const attempts = new Map<string, (typeof response.attempts)[number]>();
    const results = new Map<string, (typeof response.results)[number]>();
    const consumedCandidateIds = new Set<string>();
    const executedProfileKeys = new Set<string>();

    response.slots.forEach((slot, index) => {
      if (slots.has(slot.slot_id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'slot_id values must be unique',
          path: ['slots', index, 'slot_id'],
        });
      }
      slots.set(slot.slot_id, slot);
    });

    response.attempts.forEach((attempt, index) => {
      if (attempts.has(attempt.attempt_id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'attempt_id values must be unique',
          path: ['attempts', index, 'attempt_id'],
        });
      }
      attempts.set(attempt.attempt_id, attempt);
      const executedProfileKey = providerIdentityKey(attempt.profile.identity);
      if (executedProfileKeys.has(executedProfileKey)) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Each exact provider profile target may execute at most once across a response',
          path: ['attempts', index, 'profile', 'identity'],
        });
      }
      executedProfileKeys.add(executedProfileKey);
      if (attempt.candidate_id !== undefined) {
        if (consumedCandidateIds.has(attempt.candidate_id)) {
          ctx.addIssue({
            code: 'custom',
            message:
              'Each fallback candidate may be consumed at most once across a response',
            path: ['attempts', index, 'candidate_id'],
          });
        }
        consumedCandidateIds.add(attempt.candidate_id);
      }
      if (!slots.has(attempt.slot_id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Attempt references an unknown slot',
          path: ['attempts', index, 'slot_id'],
        });
      }
      if (
        'durable_handle' in attempt &&
        attempt.durable_handle &&
        !providerIdentitiesEqual(
          attempt.durable_handle.provider,
          attempt.profile.identity,
        )
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Attempt durable-handle provider must match the attempt profile identity',
          path: ['attempts', index, 'durable_handle', 'provider'],
        });
      }
      if (attempt.replaces_attempt_id) {
        const replaced = attempts.get(attempt.replaces_attempt_id);
        if (!replaced || replaced.slot_id !== attempt.slot_id) {
          ctx.addIssue({
            code: 'custom',
            message:
              'Replacement attempts must reference an earlier attempt in the same slot',
            path: ['attempts', index, 'replaces_attempt_id'],
          });
        } else if (
          replaced.attempt_status !== 'failed' &&
          replaced.attempt_status !== 'timed_out'
        ) {
          ctx.addIssue({
            code: 'custom',
            message:
              'Replacement attempts may only follow a failed or timed-out attempt',
            path: ['attempts', index, 'replaces_attempt_id'],
          });
        } else if (!replaced.error.fallback_allowed) {
          ctx.addIssue({
            code: 'custom',
            message:
              'Replacement attempts require fallback_allowed=true on the replaced error',
            path: ['attempts', index, 'replaces_attempt_id'],
          });
        }
      }
    });

    response.results.forEach((result, index) => {
      if (results.has(result.result_id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'result_id values must be unique',
          path: ['results', index, 'result_id'],
        });
      }
      results.set(result.result_id, result);
      const attempt = attempts.get(result.attempt_id);
      if (
        attempt?.attempt_status !== 'succeeded' ||
        attempt.slot_id !== result.slot_id ||
        attempt.result_id !== result.result_id
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Results must reference their matching succeeded attempt and slot',
          path: ['results', index, 'attempt_id'],
        });
      }
      if (
        result.provenance.request_id !== response.request_id ||
        result.provenance.slot_id !== result.slot_id ||
        result.provenance.attempt_id !== result.attempt_id
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Result provenance identifiers must match the enclosing response and result',
          path: ['results', index, 'provenance'],
        });
      }

      const slot = slots.get(result.slot_id);
      if (
        slot?.slot_status !== 'succeeded' ||
        slot.selected_attempt_id !== result.attempt_id ||
        slot.result_id !== result.result_id
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Results must be selected by their matching succeeded slot outcome',
          path: ['results', index, 'slot_id'],
        });
      }

      if (attempt?.attempt_status === 'succeeded') {
        if (
          !executionProfilesEqual(
            result.provenance.effective_profile,
            attempt.profile,
          )
        ) {
          ctx.addIssue({
            code: 'custom',
            message:
              'Result effective_profile must match the producing attempt profile',
            path: ['results', index, 'provenance', 'effective_profile'],
          });
        }
        if (
          !providerIdentitiesEqual(
            result.provenance.collection.provider,
            attempt.profile.identity,
          )
        ) {
          ctx.addIssue({
            code: 'custom',
            message:
              'Collection provider must match the producing attempt provider',
            path: ['results', index, 'provenance', 'collection', 'provider'],
          });
        }
        if (
          result.provenance.replaced_attempt_id !== attempt.replaces_attempt_id
        ) {
          ctx.addIssue({
            code: 'custom',
            message:
              'Result replacement provenance must match the attempt replacement chain',
            path: ['results', index, 'provenance', 'replaced_attempt_id'],
          });
        }

        let requestedAttempt: (typeof response.attempts)[number] = attempt;
        while (requestedAttempt.replaces_attempt_id) {
          const replacedAttempt = attempts.get(
            requestedAttempt.replaces_attempt_id,
          );
          if (!replacedAttempt) break;
          requestedAttempt = replacedAttempt;
        }
        if (
          !executionProfilesEqual(
            result.provenance.requested_profile,
            requestedAttempt.profile,
          )
        ) {
          ctx.addIssue({
            code: 'custom',
            message:
              'Result requested_profile must match the first attempt in its replacement chain',
            path: ['results', index, 'provenance', 'requested_profile'],
          });
        }
      }
    });

    response.attempts.forEach((attempt, index) => {
      if (attempt.attempt_status !== 'succeeded') return;
      const result = results.get(attempt.result_id);
      if (
        !result ||
        result.attempt_id !== attempt.attempt_id ||
        result.slot_id !== attempt.slot_id
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Succeeded attempts must produce their declared result',
          path: ['attempts', index, 'result_id'],
        });
      }
    });

    response.slots.forEach((slot, index) => {
      if (slot.selected_attempt_id) {
        const attempt = attempts.get(slot.selected_attempt_id);
        if (!attempt || attempt.slot_id !== slot.slot_id) {
          ctx.addIssue({
            code: 'custom',
            message:
              'selected_attempt_id must reference an attempt in the same slot',
            path: ['slots', index, 'selected_attempt_id'],
          });
        } else {
          const compatible =
            (slot.slot_status === 'pending' &&
              ['started', 'submitted'].includes(attempt.attempt_status)) ||
            (slot.slot_status === 'succeeded' &&
              attempt.attempt_status === 'succeeded') ||
            (slot.slot_status === 'failed' &&
              ['failed', 'timed_out'].includes(attempt.attempt_status)) ||
            (slot.slot_status === 'cancelled' &&
              attempt.attempt_status === 'cancelled');
          if (!compatible) {
            ctx.addIssue({
              code: 'custom',
              message:
                'selected_attempt_id status must match the slot outcome status',
              path: ['slots', index, 'selected_attempt_id'],
            });
          }
        }
      }
      if (slot.slot_status === 'succeeded') {
        const result = results.get(slot.result_id);
        const attempt = attempts.get(slot.selected_attempt_id);
        if (
          !result ||
          result.slot_id !== slot.slot_id ||
          result.attempt_id !== slot.selected_attempt_id ||
          attempt?.attempt_status !== 'succeeded' ||
          attempt.result_id !== slot.result_id
        ) {
          ctx.addIssue({
            code: 'custom',
            message:
              'Succeeded slots must select the succeeded attempt that produced their result',
            path: ['slots', index, 'result_id'],
          });
        }
      }
    });

    const slotStatuses = response.slots.map((slot) => slot.slot_status);
    if (response.response_status === 'partial') {
      if (
        !slotStatuses.includes('succeeded') ||
        !slotStatuses.some(
          (status) => status === 'failed' || status === 'cancelled',
        ) ||
        slotStatuses.includes('pending')
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Partial responses require at least one succeeded and one failed or cancelled slot',
          path: ['response_status'],
        });
      }
    } else if (
      response.response_status === 'succeeded' &&
      slotStatuses.some((status) => status !== 'succeeded')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Succeeded responses require every slot to succeed',
        path: ['response_status'],
      });
    } else if (
      response.response_status === 'failed' &&
      slotStatuses.some((status) => status !== 'failed')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Failed responses require every slot to fail',
        path: ['response_status'],
      });
    } else if (
      response.response_status === 'cancelled' &&
      slotStatuses.some((status) => status !== 'cancelled')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Cancelled responses require every slot to be cancelled',
        path: ['response_status'],
      });
    } else if (response.response_status === 'unsuccessful') {
      if (
        !slotStatuses.includes('failed') ||
        !slotStatuses.includes('cancelled') ||
        slotStatuses.some(
          (status) => status === 'pending' || status === 'succeeded',
        )
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Unsuccessful responses require a terminal mix of failed and cancelled slots',
          path: ['response_status'],
        });
      }
    } else if (
      response.response_status === 'pending' &&
      !slotStatuses.includes('pending')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Pending responses require at least one pending slot',
        path: ['response_status'],
      });
    }
  });

export type Attempt = z.infer<typeof AttemptSchema>;
export type InterchangeResponse = z.infer<typeof InterchangeResponseSchema>;
export type SlotOutcome = z.infer<typeof SlotOutcomeSchema>;
