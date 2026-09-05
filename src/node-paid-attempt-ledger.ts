import { resolve } from 'node:path';
import { z } from 'zod/v4';
import { safeWriteFile } from './core/fs-utils.js';
import {
  DEFAULT_FS,
  resolveContainedPathWithFs,
  resolveRunDirectoryWithFs,
} from './node-run-artifact-codecs.js';
import type { PaidRunLedger } from './run-paid-wallet.js';

export const PAID_ATTEMPT_LEDGER_FILE = 'paid-attempt-ledger.json';

const ExactCostSchema = z.string().regex(/^(?:0|[1-9]\d*)$/);
const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ProviderSchema = z.strictObject({
  provider: z.string().min(1),
  profile: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  estimated_cost_microusd: ExactCostSchema.optional(),
  estimate_source: z.string().min(1).optional(),
});
const StageSchema = z.strictObject({
  stage: z.enum(['refinement', 'research', 'synthesis', 'verification']),
  requested: z.boolean(),
  fallback_authorized: z.boolean(),
  prompt_version: z.string().min(1),
  providers: z.array(ProviderSchema),
  reserve_first_attempt: z.boolean().optional(),
  status: z.enum(['requested', 'not_requested', 'skipped']),
  reason_code: z.string().min(1).optional(),
  reserved_cost_microusd: ExactCostSchema.optional(),
});
const CostStateSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('unknown') }),
  z.strictObject({
    state: z.literal('known'),
    cost_microusd: ExactCostSchema,
    source: z.string().min(1).optional(),
  }),
]);
const AttemptSchema = z.strictObject({
  attempt_id: z.string().min(1),
  stage: z.enum(['refinement', 'research', 'synthesis', 'verification']),
  provider: z.string().min(1),
  profile: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  parent_attempt_id: z.string().min(1).optional(),
  input_fingerprint: FingerprintSchema,
  input_ref: z.string().min(1).optional(),
  output_fingerprint: FingerprintSchema.optional(),
  output_ref: z.string().min(1).optional(),
  started_at: z.iso.datetime({ offset: true }),
  finished_at: z.iso.datetime({ offset: true }).optional(),
  status: z.enum([
    'running',
    'succeeded',
    'failed',
    'accepted',
    'acceptance_unknown',
    'cancelled',
    'blocked',
  ]),
  estimate: CostStateSchema,
  reported: CostStateSchema,
  reason_code: z.string().min(1).optional(),
});

export const PaidRunLedgerSchema = z.strictObject({
  schema_version: z.literal(1),
  artifact: z.literal('librarium.paid-attempt-ledger'),
  artifact_version: z.literal('1.0.0'),
  request_id: z.string().min(1),
  canonical_run_ref: z.literal('run.json'),
  request_fingerprint: FingerprintSchema,
  config_fingerprint: FingerprintSchema,
  created_at: z.iso.datetime({ offset: true }),
  deadline_at: z.iso.datetime({ offset: true }),
  cancellation_requested_at: z.iso.datetime({ offset: true }).optional(),
  limits: z.strictObject({
    max_estimated_cost_microusd: ExactCostSchema.optional(),
    max_actual_cost_microusd: ExactCostSchema.optional(),
  }),
  stages: z.array(StageSchema).length(4),
  attempts: z.array(AttemptSchema),
});

export function writePaidRunLedger(
  runsRoot: string,
  runDirectory: string,
  ledger: PaidRunLedger,
): void {
  const root = DEFAULT_FS.realpathSync(resolve(runsRoot));
  const directory = resolveRunDirectoryWithFs(
    DEFAULT_FS,
    root,
    resolve(runDirectory),
  );
  if (!directory)
    throw new Error('Paid attempt ledger must remain inside its runs root.');
  const path = resolveContainedPathWithFs(
    DEFAULT_FS,
    directory,
    PAID_ATTEMPT_LEDGER_FILE,
  );
  const parsed = PaidRunLedgerSchema.parse(structuredClone(ledger));
  safeWriteFile(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
}
