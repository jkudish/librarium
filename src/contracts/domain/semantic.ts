import { z } from 'zod/v4';
import {
  ExtensionsSchema,
  OpaqueIdSchema,
  Rfc3339UtcSchema,
} from '../common.js';

export const ResultKindSchema = z.enum([
  'search_results',
  'grounded_answer',
  'research_report',
  'model_answer',
  'surface_observation',
]);

export const GroundingPolicySchema = z.enum(['required', 'optional', 'none']);
export const GroundingOutcomeSchema = z.enum(['used', 'not_used', 'unknown']);
export const ObservationModeSchema = z.enum(['api_output', 'surface_snapshot']);
export const CorpusSchema = z.enum([
  'web',
  'news',
  'x',
  'files',
  'places',
  'specialized',
]);
export const RetrievalMethodSchema = z.enum([
  'search_endpoint',
  'model_search_tool',
  'research_agent',
  'surface_collector',
  'model_only',
]);
export const AccessModeSchema = z.enum(['direct', 'brokered', 'collected']);

export const SurfaceContextSchema = z.strictObject({
  account_context: z.enum(['anonymous', 'authenticated', 'managed', 'unknown']),
  locale: z.string().min(1).max(64).optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  device: z.string().min(1).max(128).optional(),
  personalization: z.enum(['present', 'absent', 'unknown']),
  extensions: ExtensionsSchema.optional(),
});

export const SurfaceContextConstraintSchema = z
  .strictObject({
    account_context: z
      .enum(['anonymous', 'authenticated', 'managed'])
      .optional(),
    locale: z.string().min(1).max(64).optional(),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    device: z.string().min(1).max(128).optional(),
    personalization: z.enum(['present', 'absent']).optional(),
  })
  .superRefine((constraint, ctx) => {
    if (Object.values(constraint).every((value) => value === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Surface context constraints must specify at least one field',
      });
    }
  });

export const SemanticFactsSchema = z
  .strictObject({
    result_kinds: z.array(ResultKindSchema).min(1).max(8),
    grounding_outcome: GroundingOutcomeSchema.optional(),
    observation_mode: ObservationModeSchema,
    corpora: z.array(CorpusSchema).max(8),
    retrieval_methods: z.array(RetrievalMethodSchema).min(1).max(8),
    observed_at: Rfc3339UtcSchema,
    measured_surface_id: OpaqueIdSchema.optional(),
    surface_context: SurfaceContextSchema.optional(),
    extensions: ExtensionsSchema.optional(),
  })
  .superRefine((facts, ctx) => {
    const searchResultsOnly = facts.result_kinds.every(
      (kind) => kind === 'search_results',
    );
    if (searchResultsOnly && facts.grounding_outcome !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Search-results-only facts must omit inapplicable grounding_outcome',
        path: ['grounding_outcome'],
      });
    } else if (!searchResultsOnly && facts.grounding_outcome === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Answer and observation facts require grounding_outcome',
        path: ['grounding_outcome'],
      });
    }
  });

export type AccessMode = z.infer<typeof AccessModeSchema>;
export type Corpus = z.infer<typeof CorpusSchema>;
export type GroundingOutcome = z.infer<typeof GroundingOutcomeSchema>;
export type GroundingPolicy = z.infer<typeof GroundingPolicySchema>;
export type ObservationMode = z.infer<typeof ObservationModeSchema>;
export type ResultKind = z.infer<typeof ResultKindSchema>;
export type RetrievalMethod = z.infer<typeof RetrievalMethodSchema>;
export type SemanticFacts = z.infer<typeof SemanticFactsSchema>;
export type SurfaceContext = z.infer<typeof SurfaceContextSchema>;
export type SurfaceContextConstraint = z.infer<
  typeof SurfaceContextConstraintSchema
>;
