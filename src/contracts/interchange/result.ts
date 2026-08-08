import { z } from 'zod/v4';
import {
  ExtensionsSchema,
  OpaqueIdSchema,
  Rfc3339UtcSchema,
} from '../common.js';
import {
  CitationSchema,
  CollectionProvenanceSchema,
  ExecutionProfileSchema,
  SemanticFactsSchema,
  UsageSchema,
} from '../domain/index.js';

export const ResultProvenanceSchema = z.strictObject({
  request_id: OpaqueIdSchema,
  slot_id: OpaqueIdSchema,
  attempt_id: OpaqueIdSchema,
  requested_profile: ExecutionProfileSchema,
  effective_profile: ExecutionProfileSchema,
  collection: CollectionProvenanceSchema,
  replaced_attempt_id: OpaqueIdSchema.optional(),
  extensions: ExtensionsSchema.optional(),
});

export const InterchangeResultSchema = z.strictObject({
  result_id: OpaqueIdSchema,
  slot_id: OpaqueIdSchema,
  attempt_id: OpaqueIdSchema,
  content_format: z.enum(['plain_text', 'markdown']),
  content: z.string().min(1).max(2_000_000),
  semantic_facts: SemanticFactsSchema,
  citations: z.array(CitationSchema).max(10_000),
  provenance: ResultProvenanceSchema,
  usage: UsageSchema.optional(),
  completed_at: Rfc3339UtcSchema,
  extensions: ExtensionsSchema.optional(),
});

export type InterchangeResult = z.infer<typeof InterchangeResultSchema>;
export type ResultProvenance = z.infer<typeof ResultProvenanceSchema>;
