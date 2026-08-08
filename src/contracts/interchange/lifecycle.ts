import { z } from 'zod/v4';
import { OpaqueIdSchema, Rfc3339UtcSchema } from '../common.js';
import {
  DurableHandleSchema,
  ProviderIdentitySchema,
  StructuredErrorSchema,
} from '../domain/index.js';
import { ExecutionModeSchema, INTERCHANGE_VERSION } from './request.js';

const lifecycleBase = {
  interchange_version: z.literal(INTERCHANGE_VERSION),
  message_type: z.literal('lifecycle_event'),
  event_id: OpaqueIdSchema,
  request_id: OpaqueIdSchema,
  sequence: z.number().int().nonnegative().safe(),
  occurred_at: Rfc3339UtcSchema,
};

const attemptLifecycleBase = {
  ...lifecycleBase,
  slot_id: OpaqueIdSchema,
  attempt_id: OpaqueIdSchema,
};

export const RequestStartedEventSchema = z.strictObject({
  ...lifecycleBase,
  event_kind: z.literal('request_started'),
  data: z.strictObject({ mode: ExecutionModeSchema }),
});

export const AttemptStartedEventSchema = z.strictObject({
  ...attemptLifecycleBase,
  event_kind: z.literal('attempt_started'),
  data: z.strictObject({
    provider: ProviderIdentitySchema,
    attempt_number: z.number().int().positive().safe(),
  }),
});

export const DurableTaskSubmittedEventSchema = z.strictObject({
  ...attemptLifecycleBase,
  event_kind: z.literal('durable_task_submitted'),
  data: z.strictObject({ handle: DurableHandleSchema }),
});

export const AttemptProgressEventSchema = z.strictObject({
  ...attemptLifecycleBase,
  event_kind: z.literal('attempt_progress'),
  data: z.strictObject({
    progress_percent: z.number().int().min(0).max(100),
    message: z.string().min(1).max(512).optional(),
  }),
});

export const AttemptFinishedEventSchema = z.strictObject({
  ...attemptLifecycleBase,
  event_kind: z.literal('attempt_finished'),
  data: z.discriminatedUnion('outcome', [
    z.strictObject({ outcome: z.literal('succeeded') }),
    z.strictObject({
      outcome: z.literal('failed'),
      error: StructuredErrorSchema,
    }),
    z.strictObject({
      outcome: z.literal('timed_out'),
      error: StructuredErrorSchema,
    }),
    z.strictObject({
      outcome: z.literal('cancelled'),
      error: StructuredErrorSchema.optional(),
    }),
  ]),
});

export const FallbackSelectedEventSchema = z.strictObject({
  ...attemptLifecycleBase,
  event_kind: z.literal('fallback_selected'),
  data: z.strictObject({
    failed_attempt_id: OpaqueIdSchema,
    replacement_attempt_id: OpaqueIdSchema,
    candidate_id: OpaqueIdSchema,
  }),
});

export const RequestCompletedEventSchema = z.strictObject({
  ...lifecycleBase,
  event_kind: z.literal('request_completed'),
  data: z.strictObject({
    outcome: z.enum(['succeeded', 'partial', 'unsuccessful']),
  }),
});

export const RequestFailedEventSchema = z.strictObject({
  ...lifecycleBase,
  event_kind: z.literal('request_failed'),
  data: z.strictObject({ error: StructuredErrorSchema }),
});

export const RequestCancelledEventSchema = z.strictObject({
  ...lifecycleBase,
  event_kind: z.literal('request_cancelled'),
  data: z.strictObject({ error: StructuredErrorSchema.optional() }),
});

export const LifecycleEventSchema = z.discriminatedUnion('event_kind', [
  RequestStartedEventSchema,
  AttemptStartedEventSchema,
  DurableTaskSubmittedEventSchema,
  AttemptProgressEventSchema,
  AttemptFinishedEventSchema,
  FallbackSelectedEventSchema,
  RequestCompletedEventSchema,
  RequestFailedEventSchema,
  RequestCancelledEventSchema,
]);

const TERMINAL_EVENT_KINDS = new Set([
  'request_completed',
  'request_failed',
  'request_cancelled',
]);

export const LifecycleTraceSchema = z
  .array(LifecycleEventSchema)
  .min(1)
  .max(10_000)
  .superRefine((events, ctx) => {
    const requestId = events[0]?.request_id;
    const eventIds = new Set<string>();
    let priorSequence = -1;
    let priorTimestamp = Number.NEGATIVE_INFINITY;
    let terminalSeen = false;

    events.forEach((event, index) => {
      if (event.request_id !== requestId) {
        ctx.addIssue({
          code: 'custom',
          message: 'Lifecycle traces may contain only one request_id',
          path: [index, 'request_id'],
        });
      }
      if (eventIds.has(event.event_id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'event_id values must be unique',
          path: [index, 'event_id'],
        });
      }
      eventIds.add(event.event_id);
      if (event.sequence <= priorSequence) {
        ctx.addIssue({
          code: 'custom',
          message: 'Lifecycle sequence values must increase monotonically',
          path: [index, 'sequence'],
        });
      }
      priorSequence = event.sequence;
      const timestamp = Date.parse(event.occurred_at);
      if (timestamp < priorTimestamp) {
        ctx.addIssue({
          code: 'custom',
          message: 'Lifecycle timestamps must not move backwards',
          path: [index, 'occurred_at'],
        });
      }
      priorTimestamp = timestamp;
      if (terminalSeen) {
        ctx.addIssue({
          code: 'custom',
          message: 'No lifecycle event may follow a terminal request event',
          path: [index, 'event_kind'],
        });
      }
      if (TERMINAL_EVENT_KINDS.has(event.event_kind)) terminalSeen = true;
    });

    if (events[0]?.event_kind !== 'request_started') {
      ctx.addIssue({
        code: 'custom',
        message: 'Lifecycle traces must begin with request_started',
        path: [0, 'event_kind'],
      });
    }
  });

export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>;
export type LifecycleTrace = z.infer<typeof LifecycleTraceSchema>;
