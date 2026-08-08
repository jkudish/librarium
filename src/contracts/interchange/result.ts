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

export const InterchangeResultSchema = z
  .strictObject({
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
  })
  .superRefine((result, ctx) => {
    const facts = result.semantic_facts;
    const profile = result.provenance.effective_profile;

    if (!facts.result_kinds.includes(profile.result_kind)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Result semantic facts must include the effective profile result kind',
        path: ['semantic_facts', 'result_kinds'],
      });
    }
    if (!facts.retrieval_methods.includes(profile.retrieval_method)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Result semantic facts must include the effective profile retrieval method',
        path: ['semantic_facts', 'retrieval_methods'],
      });
    }
    for (const [index, corpus] of facts.corpora.entries()) {
      if (!profile.corpora.includes(corpus)) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Result semantic facts cannot claim corpora outside the effective profile',
          path: ['semantic_facts', 'corpora', index],
        });
      }
    }
    if (facts.observation_mode !== profile.observation_mode) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Result observation mode must match the effective profile observation mode',
        path: ['semantic_facts', 'observation_mode'],
      });
    }
    if (
      profile.surface_id !== undefined &&
      facts.measured_surface_id !== profile.surface_id
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Result measured surface must match the effective profile surface',
        path: ['semantic_facts', 'measured_surface_id'],
      });
    }
    if (
      profile.surface_id === undefined &&
      facts.measured_surface_id !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Result semantic facts cannot claim a measured surface absent from the effective profile',
        path: ['semantic_facts', 'measured_surface_id'],
      });
    }
    if (
      (profile.grounding_policy === 'required' &&
        facts.grounding_outcome !== 'used') ||
      (profile.grounding_policy === 'none' &&
        facts.grounding_outcome === 'used')
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Result grounding outcome must satisfy the effective profile grounding policy',
        path: ['semantic_facts', 'grounding_outcome'],
      });
    }
  });

export type InterchangeResult = z.infer<typeof InterchangeResultSchema>;
export type ResultProvenance = z.infer<typeof ResultProvenanceSchema>;
