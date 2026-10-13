import { z } from 'zod';

export const MoneySchema = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
export const RunIdSchema = z.string().regex(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);
export const SourceNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .max(64);
const time = z.iso.datetime({ offset: true });
export const RunResultSchema = z
  .strictObject({
    source: SourceNameSchema,
    status: z.enum(['queued', 'running', 'done', 'failed']),
    observation: z.enum(['api', 'surface']),
    answer: z.string().nullable(),
    citations: z.array(
      z.strictObject({ url: z.url(), title: z.string().nullable().optional() }),
    ),
    cost: z.strictObject({
      estimated: MoneySchema.nullable(),
      reported: MoneySchema.nullable(),
    }),
    started_at: time.nullable(),
    duration_ms: z.number().int().nonnegative().nullable(),
    provenance: z.strictObject({
      provider: z.string(),
      variant: z.string(),
      model: z.string().nullable(),
      collector: z.string().nullable(),
    }),
    error: z
      .strictObject({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
      })
      .nullable(),
  })
  .superRefine((result, ctx) => {
    if ((result.status === 'failed') !== (result.error !== null))
      ctx.addIssue({
        code: 'custom',
        message: 'Only failed results have an error',
      });
  });
export const RunSchema = z
  .strictObject({
    spec: z.literal('librarium.run/1'),
    id: RunIdSchema,
    question: z.string().min(1),
    summary_of: RunIdSchema.optional(),
    depth: z.enum(['quick', 'deep']),
    status: z.enum(['planned', 'running', 'done', 'partial', 'failed']),
    created_at: time,
    finished_at: time.nullable(),
    cost: z.strictObject({
      estimated: MoneySchema.nullable(),
      reported: MoneySchema.nullable(),
      complete: z.boolean(),
      max: MoneySchema.nullable(),
    }),
    results: z.array(RunResultSchema),
    skipped: z.array(
      z.strictObject({
        source: SourceNameSchema,
        reason: z.enum([
          'not_configured',
          'no_deep_variant',
          'unpriced',
          'over_budget',
          'excluded',
          'no_collector',
        ]),
      }),
    ),
    notices: z.array(z.object({ code: z.string(), message: z.string() })),
  })
  .superRefine((run, ctx) => {
    if (
      (run.status === 'running' || run.status === 'planned') !==
      (run.finished_at === null)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Terminal Runs require finished_at',
      });
  });
export type Run = z.infer<typeof RunSchema>;
export type RunResult = z.infer<typeof RunResultSchema>;
export const StoredRunSchema = z.strictObject({
  run: RunSchema,
  state: z.record(z.string(), z.unknown()),
  files: z.record(
    z.string().regex(/^(answers\/[a-z0-9-]+\.md|evidence\/[a-z0-9-]+\.json)$/),
    z.string(),
  ),
  version: z.number().int().min(1),
});
export type StoredRun = z.infer<typeof StoredRunSchema>;
export type RunSummary = Pick<
  Run,
  'id' | 'question' | 'depth' | 'status' | 'created_at' | 'finished_at' | 'cost'
>;
export interface RunStore {
  get(id: string): Promise<StoredRun | null>;
  save(doc: StoredRun, expectedVersion: number | null): Promise<number>;
  list(opts?: { limit?: number; before?: string }): Promise<RunSummary[]>;
  delete(id: string): Promise<void>;
}
export class RunStoreConflict extends Error {
  constructor() {
    super('RunStore version conflict');
    this.name = 'RunStoreConflict';
  }
}
export function runSummary(run: Run): RunSummary {
  const { id, question, depth, status, created_at, finished_at, cost } = run;
  return { id, question, depth, status, created_at, finished_at, cost };
}
export function listRuns(
  runs: Run[],
  opts: { limit?: number; before?: string } = {},
): RunSummary[] {
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 0)
    throw new TypeError('limit must be a nonnegative integer');
  runs.sort(
    (a, b) =>
      b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
  );
  const start = opts.before
    ? runs.findIndex((run) => run.id === opts.before) + 1
    : 0;
  return runs.slice(start, start + limit).map(runSummary);
}
export class MemoryRunStore implements RunStore {
  readonly #documents = new Map<string, StoredRun>();
  async get(id: string): Promise<StoredRun | null> {
    RunIdSchema.parse(id);
    return structuredClone(this.#documents.get(id) ?? null);
  }
  async save(doc: StoredRun, expectedVersion: number | null): Promise<number> {
    const parsed = StoredRunSchema.parse(doc);
    const current = this.#documents.get(parsed.run.id);
    if ((current?.version ?? null) !== expectedVersion)
      throw new RunStoreConflict();
    const version = (expectedVersion ?? 0) + 1;
    this.#documents.set(parsed.run.id, structuredClone({ ...parsed, version }));
    return version;
  }
  async list(opts?: {
    limit?: number;
    before?: string;
  }): Promise<RunSummary[]> {
    return listRuns(
      [...this.#documents.values()].map((doc) => doc.run),
      opts,
    );
  }
  async delete(id: string): Promise<void> {
    RunIdSchema.parse(id);
    this.#documents.delete(id);
  }
}
/** Exact decimal arithmetic through 18 places, matching provider-reported costs. */
export function decimalUnits(value: string): bigint {
  MoneySchema.parse(value);
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > 18)
    throw new TypeError('Money supports at most 18 decimal places');
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}
export function decimalFromUnits(value: bigint): string {
  const digits = value.toString().padStart(19, '0');
  const fraction = digits.slice(-18).replace(/0+$/, '');
  return `${digits.slice(0, -18)}${fraction ? `.${fraction}` : ''}`;
}
