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
  StructuredErrorSchema,
} from '../domain/index.js';
import { InterchangeResultSchema } from '../interchange/result.js';

export const CUSTOM_PROVIDER_PROTOCOL_VERSION = '1.0.0' as const;

const requestHeader = {
  protocol_version: z.literal(CUSTOM_PROVIDER_PROTOCOL_VERSION),
  request_id: OpaqueIdSchema,
  attempt_id: OpaqueIdSchema,
  sent_at: Rfc3339UtcSchema,
};

const executionRequest = {
  ...requestHeader,
  query: z.string().min(1).max(100_000),
  profile: ExecutionProfileSchema,
  options: ExtensionsSchema.optional(),
};

export const CustomProviderExecuteRequestSchema = z.strictObject({
  ...executionRequest,
  message_type: z.literal('execute'),
});

export const CustomProviderSubmitRequestSchema = z.strictObject({
  ...executionRequest,
  message_type: z.literal('submit'),
});

export const CustomProviderPollRequestSchema = z.strictObject({
  ...requestHeader,
  message_type: z.literal('poll'),
  durable_handle: DurableHandleSchema,
});

export const CustomProviderRetrieveRequestSchema = z.strictObject({
  ...requestHeader,
  message_type: z.literal('retrieve'),
  durable_handle: DurableHandleSchema,
});

export const CustomProviderRequestSchema = z
  .discriminatedUnion('message_type', [
    CustomProviderExecuteRequestSchema,
    CustomProviderSubmitRequestSchema,
    CustomProviderPollRequestSchema,
    CustomProviderRetrieveRequestSchema,
  ])
  .superRefine((request, ctx) => {
    if (
      request.message_type === 'execute' &&
      request.profile.invocation !== 'inline'
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'execute requests require an inline profile',
        path: ['profile', 'invocation'],
      });
    }
    if (
      request.message_type === 'submit' &&
      (request.profile.invocation !== 'background' ||
        request.profile.resumability !== 'durable')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'submit requests require a durable background profile',
        path: ['profile', 'resumability'],
      });
    }
  });

const responseHeader = {
  protocol_version: z.literal(CUSTOM_PROVIDER_PROTOCOL_VERSION),
  request_id: OpaqueIdSchema,
  attempt_id: OpaqueIdSchema,
  emitted_at: Rfc3339UtcSchema,
};

const NonterminalDurableHandleSchema = DurableHandleSchema.extend({
  status: z.enum(['pending', 'running']),
});

const TerminalDurableHandleSchema = DurableHandleSchema.extend({
  status: z.enum(['succeeded', 'failed', 'cancelled']),
});

export const CustomProviderResultResponseSchema = z.strictObject({
  ...responseHeader,
  message_type: z.literal('result'),
  result: InterchangeResultSchema,
});

export const CustomProviderSubmittedResponseSchema = z.strictObject({
  ...responseHeader,
  message_type: z.literal('submitted'),
  durable_handle: NonterminalDurableHandleSchema,
});

export const CustomProviderProgressResponseSchema = z.strictObject({
  ...responseHeader,
  message_type: z.literal('progress'),
  durable_handle: NonterminalDurableHandleSchema,
  progress_percent: z.number().int().min(0).max(100).optional(),
  message: z.string().min(1).max(512).optional(),
});

export const CustomProviderStatusResponseSchema = z.strictObject({
  ...responseHeader,
  message_type: z.literal('status'),
  durable_handle: TerminalDurableHandleSchema,
});

export const CustomProviderErrorResponseSchema = z.strictObject({
  ...responseHeader,
  message_type: z.literal('error'),
  error: StructuredErrorSchema,
});

export const CustomProviderResponseSchema = z.discriminatedUnion(
  'message_type',
  [
    CustomProviderResultResponseSchema,
    CustomProviderSubmittedResponseSchema,
    CustomProviderProgressResponseSchema,
    CustomProviderStatusResponseSchema,
    CustomProviderErrorResponseSchema,
  ],
);

export const CustomProviderExchangeSchema = z
  .strictObject({
    request: CustomProviderRequestSchema,
    response: CustomProviderResponseSchema,
  })
  .superRefine((exchange, ctx) => {
    if (exchange.request.request_id !== exchange.response.request_id) {
      ctx.addIssue({
        code: 'custom',
        message: 'Response request_id must match its request',
        path: ['response', 'request_id'],
      });
    }
    if (exchange.request.attempt_id !== exchange.response.attempt_id) {
      ctx.addIssue({
        code: 'custom',
        message: 'Response attempt_id must match its request',
        path: ['response', 'attempt_id'],
      });
    }

    if (exchange.response.message_type === 'result') {
      const result = exchange.response.result;
      if (
        result.attempt_id !== exchange.response.attempt_id ||
        result.provenance.request_id !== exchange.response.request_id ||
        result.provenance.attempt_id !== result.attempt_id ||
        result.provenance.slot_id !== result.slot_id
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Result slot, attempt, and provenance identifiers must match each other and the response envelope',
          path: ['response', 'result', 'provenance'],
        });
      }

      const expectedProvider =
        exchange.request.message_type === 'execute'
          ? exchange.request.profile.identity
          : exchange.request.message_type === 'retrieve'
            ? exchange.request.durable_handle.provider
            : undefined;
      const actualProvider = result.provenance.effective_profile.identity;
      if (
        expectedProvider &&
        (!providerIdentitiesEqual(expectedProvider, actualProvider) ||
          !providerIdentitiesEqual(
            expectedProvider,
            result.provenance.collection.provider,
          ))
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Result provider must match the executing profile or durable handle',
          path: [
            'response',
            'result',
            'provenance',
            'effective_profile',
            'identity',
          ],
        });
      }

      if (
        exchange.request.message_type === 'execute' &&
        !executionProfilesEqual(
          result.provenance.effective_profile,
          exchange.request.profile,
        )
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Inline result effective_profile must match the executing profile',
          path: ['response', 'result', 'provenance', 'effective_profile'],
        });
      }
    }

    if (
      exchange.request.message_type === 'submit' &&
      exchange.response.message_type === 'submitted' &&
      !providerIdentitiesEqual(
        exchange.request.profile.identity,
        exchange.response.durable_handle.provider,
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Submitted handle provider must match the requested profile',
        path: ['response', 'durable_handle', 'provider'],
      });
    }

    if (
      exchange.request.message_type === 'poll' &&
      (exchange.response.message_type === 'progress' ||
        exchange.response.message_type === 'status') &&
      (exchange.request.durable_handle.handle_id !==
        exchange.response.durable_handle.handle_id ||
        exchange.request.durable_handle.provider_task_id !==
          exchange.response.durable_handle.provider_task_id ||
        !providerIdentitiesEqual(
          exchange.request.durable_handle.provider,
          exchange.response.durable_handle.provider,
        ))
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Poll response handle must match the polled handle',
        path: ['response', 'durable_handle', 'handle_id'],
      });
    }

    const allowed: Record<
      z.infer<typeof CustomProviderRequestSchema>['message_type'],
      string[]
    > = {
      execute: ['result', 'error'],
      submit: ['submitted', 'error'],
      poll: ['progress', 'status', 'error'],
      retrieve: ['result', 'error'],
    };
    if (
      !allowed[exchange.request.message_type].includes(
        exchange.response.message_type,
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `Response type ${exchange.response.message_type} is not valid for ${exchange.request.message_type}`,
        path: ['response', 'message_type'],
      });
    }
  });

export type CustomProviderExchange = z.infer<
  typeof CustomProviderExchangeSchema
>;
export type CustomProviderRequest = z.infer<typeof CustomProviderRequestSchema>;
export type CustomProviderResponse = z.infer<
  typeof CustomProviderResponseSchema
>;
