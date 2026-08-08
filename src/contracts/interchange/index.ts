import { z } from 'zod/v4';
import { LifecycleEventSchema } from './lifecycle.js';
import { InterchangeRequestSchema } from './request.js';
import { InterchangeResponseSchema } from './response.js';

export * from './lifecycle.js';
export * from './request.js';
export * from './response.js';
export * from './result.js';

export const InterchangeMessageSchema = z.discriminatedUnion('message_type', [
  InterchangeRequestSchema,
  InterchangeResponseSchema,
  LifecycleEventSchema,
]);

export type InterchangeMessage = z.infer<typeof InterchangeMessageSchema>;
