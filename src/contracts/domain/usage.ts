import { z } from 'zod/v4';
import {
  CONTRACT_LIMITS,
  ExtensionsSchema,
  SemverSchema,
  SnakeCaseNameSchema,
} from '../common.js';

const DecimalSchema = z
  .string()
  .max(CONTRACT_LIMITS.decimalStringLength)
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/, {
    message:
      'Expected a non-negative base-10 decimal string with at most 18 fractional digits',
  });

export const MonetaryAmountSchema = z.strictObject({
  amount_decimal: DecimalSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export const UsageUnitSchema = z.strictObject({
  unit: SnakeCaseNameSchema,
  quantity_decimal: DecimalSchema,
  source: z.enum(['provider_reported', 'computed', 'configured', 'estimated']),
});

export const CostRecordSchema = z.strictObject({
  amount: MonetaryAmountSchema,
  source: z.enum([
    'provider_reported',
    'computed_from_tokens',
    'computed_from_request',
    'computed_from_credits',
    'account_usage_delta',
    'configured',
    'pricing_snapshot',
  ]),
  pricing_version: SemverSchema.optional(),
});

export const UsageSchema = z
  .strictObject({
    input_tokens: z.number().int().nonnegative().safe().optional(),
    output_tokens: z.number().int().nonnegative().safe().optional(),
    total_tokens: z.number().int().nonnegative().safe().optional(),
    billable_units: z.array(UsageUnitSchema).max(32).optional(),
    actual_cost: CostRecordSchema.optional(),
    estimated_cost: CostRecordSchema.optional(),
    completeness: z.enum(['complete', 'partial', 'unknown']),
    extensions: ExtensionsSchema.optional(),
  })
  .superRefine((usage, ctx) => {
    if (
      usage.actual_cost &&
      ['configured', 'pricing_snapshot'].includes(usage.actual_cost.source)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'actual_cost must identify reported or computed actual-cost provenance',
        path: ['actual_cost', 'source'],
      });
    }
    if (
      usage.estimated_cost &&
      !['configured', 'pricing_snapshot'].includes(usage.estimated_cost.source)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'estimated_cost must identify configured or pricing_snapshot provenance',
        path: ['estimated_cost', 'source'],
      });
    }
    if (
      usage.estimated_cost?.source === 'pricing_snapshot' &&
      !usage.estimated_cost.pricing_version
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'pricing_snapshot estimates require pricing_version',
        path: ['estimated_cost', 'pricing_version'],
      });
    }
  });

export type CostRecord = z.infer<typeof CostRecordSchema>;
export type MonetaryAmount = z.infer<typeof MonetaryAmountSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type UsageUnit = z.infer<typeof UsageUnitSchema>;
