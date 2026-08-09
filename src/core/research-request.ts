import { z } from 'zod/v4';
import { OpaqueIdSchema } from '../contracts/common.js';
import { EvidenceRequirementsSchema } from '../contracts/interchange/request.js';

export const RESEARCH_REQUEST_LIMITS = {
  queryLength: 100_000,
  exactIntegerLength: 64,
  profiles: 64,
  exclusions: 128,
  minConcurrency: 1,
  maxConcurrency: 64,
  minDeadlineMs: 1_000,
  maxDeadlineMs: 7 * 24 * 60 * 60 * 1_000,
  minPollIntervalMs: 100,
  maxPollIntervalMs: 5 * 60 * 1_000,
} as const;

export const ExactMicrousdSchema = z
  .string()
  .max(RESEARCH_REQUEST_LIMITS.exactIntegerLength)
  .regex(/^(?:0|[1-9]\d*)$/, 'Expected an exact non-negative integer string');

export const ProfileTargetSchema = z.strictObject({
  provider_id: OpaqueIdSchema,
  profile_id: OpaqueIdSchema.optional(),
});

export const ResearchSelectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('targets'),
    targets: z
      .array(ProfileTargetSchema)
      .min(1)
      .max(RESEARCH_REQUEST_LIMITS.profiles),
  }),
  z.strictObject({
    kind: z.literal('group'),
    group_id: OpaqueIdSchema,
  }),
  z.strictObject({
    kind: z.literal('capabilities'),
    requirements: EvidenceRequirementsSchema,
    result_count: z
      .number()
      .int()
      .min(1)
      .max(RESEARCH_REQUEST_LIMITS.profiles)
      .optional(),
  }),
  z.strictObject({ kind: z.literal('default') }),
]);

export const FallbackIntentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('disabled') }),
  z.strictObject({ kind: z.literal('configured') }),
  z.strictObject({
    kind: z.literal('explicit'),
    reserve: z
      .array(ProfileTargetSchema)
      .min(1)
      .max(RESEARCH_REQUEST_LIMITS.profiles),
  }),
]);

export const ResearchExecutionLimitsSchema = z
  .strictObject({
    max_concurrency: z
      .number()
      .int()
      .min(RESEARCH_REQUEST_LIMITS.minConcurrency)
      .max(RESEARCH_REQUEST_LIMITS.maxConcurrency),
    request_deadline_ms: z
      .number()
      .int()
      .min(RESEARCH_REQUEST_LIMITS.minDeadlineMs)
      .max(RESEARCH_REQUEST_LIMITS.maxDeadlineMs),
    inline_attempt_deadline_ms: z
      .number()
      .int()
      .min(RESEARCH_REQUEST_LIMITS.minDeadlineMs)
      .max(RESEARCH_REQUEST_LIMITS.maxDeadlineMs),
    background_attempt_deadline_ms: z
      .number()
      .int()
      .min(RESEARCH_REQUEST_LIMITS.minDeadlineMs)
      .max(RESEARCH_REQUEST_LIMITS.maxDeadlineMs),
    poll_interval_ms: z
      .number()
      .int()
      .min(RESEARCH_REQUEST_LIMITS.minPollIntervalMs)
      .max(RESEARCH_REQUEST_LIMITS.maxPollIntervalMs),
  })
  .superRefine((limits, ctx) => {
    if (limits.inline_attempt_deadline_ms > limits.request_deadline_ms) {
      ctx.addIssue({
        code: 'custom',
        message: 'Inline attempt deadline cannot exceed the request deadline',
        path: ['inline_attempt_deadline_ms'],
      });
    }
    if (limits.background_attempt_deadline_ms > limits.request_deadline_ms) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Background attempt deadline cannot exceed the request deadline',
        path: ['background_attempt_deadline_ms'],
      });
    }
    if (limits.poll_interval_ms > limits.background_attempt_deadline_ms) {
      ctx.addIssue({
        code: 'custom',
        message: 'Poll interval cannot exceed the background attempt deadline',
        path: ['poll_interval_ms'],
      });
    }
  });

export const ExactBudgetLimitsSchema = z
  .strictObject({
    // Zero is intentional: it is a fail-closed ceiling that permits only work
    // whose network-free reservation is exactly zero.
    max_estimated_cost_microusd: ExactMicrousdSchema.optional(),
    max_actual_cost_microusd: ExactMicrousdSchema.optional(),
  })
  .superRefine((budgets, ctx) => {
    if (
      budgets.max_estimated_cost_microusd === undefined &&
      budgets.max_actual_cost_microusd === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'At least one exact budget limit is required',
      });
    }
  });

export const RefinementIntentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('disabled') }),
  z.strictObject({
    kind: z.literal('requested'),
    strategy_id: OpaqueIdSchema.optional(),
  }),
]);

export const CanonicalResearchRequestSchema = z.strictObject({
  query: z.string().trim().min(1).max(RESEARCH_REQUEST_LIMITS.queryLength),
  mode: z.enum(['sync', 'async']),
  selector: ResearchSelectorSchema,
  fallback: FallbackIntentSchema,
  limits: ResearchExecutionLimitsSchema,
  budgets: ExactBudgetLimitsSchema.optional(),
  exclusions: z
    .array(ProfileTargetSchema)
    .max(RESEARCH_REQUEST_LIMITS.exclusions)
    .default([]),
  refinement: RefinementIntentSchema.default({ kind: 'disabled' }),
});

export type CanonicalResearchRequest = z.infer<
  typeof CanonicalResearchRequestSchema
>;
export type ExactBudgetLimits = z.infer<typeof ExactBudgetLimitsSchema>;
export type FallbackIntent = z.infer<typeof FallbackIntentSchema>;
export type ProfileTarget = z.infer<typeof ProfileTargetSchema>;
export type RefinementIntent = z.infer<typeof RefinementIntentSchema>;
export type ResearchExecutionLimits = z.infer<
  typeof ResearchExecutionLimitsSchema
>;
export type ResearchSelector = z.infer<typeof ResearchSelectorSchema>;

export type PreparationPhase =
  | 'transport'
  | 'migration'
  | 'canonicalization'
  | 'selection'
  | 'validation'
  | 'compilation';

export interface PreparationDiagnostic {
  readonly code: string;
  readonly phase: PreparationPhase;
  readonly path: string;
  readonly message: string;
  readonly profile_key?: string;
}

export type PreparationIssue = PreparationDiagnostic;
export type PreparationNotice = PreparationDiagnostic;

export interface LegacyMigrationResult {
  readonly input: unknown;
  readonly notices: readonly PreparationNotice[];
}

/**
 * Runs before canonical validation. Canonical schemas deliberately never accept
 * `mixed`; only this compatibility boundary can translate it.
 */
export function migrateLegacyResearchRequest(
  input: unknown,
): LegacyMigrationResult {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    (input as { mode?: unknown }).mode !== 'mixed'
  ) {
    return { input, notices: [] };
  }

  return {
    input: { ...(input as Record<string, unknown>), mode: 'async' },
    notices: [
      {
        code: 'legacy_mixed_mode_migrated',
        phase: 'migration',
        path: '/mode',
        message:
          'Legacy mixed mode is deprecated and was migrated to async mode.',
      },
    ],
  };
}
