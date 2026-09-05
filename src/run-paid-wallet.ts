import { createHash } from 'node:crypto';
import type { ProviderUsage } from './types.js';

export type PaidRunStage =
  | 'refinement'
  | 'research'
  | 'synthesis'
  | 'verification';

export interface PaidStageProvider {
  readonly provider: string;
  readonly profile?: string;
  readonly model?: string;
  readonly estimated_cost_microusd?: string;
  readonly estimate_source?: string;
}

export interface PaidStageDeclaration {
  readonly stage: PaidRunStage;
  readonly requested: boolean;
  readonly fallback_authorized: boolean;
  readonly prompt_version: string;
  readonly providers: readonly PaidStageProvider[];
  readonly reserve_first_attempt?: boolean;
}

export interface PaidAttemptInput {
  readonly stage: PaidRunStage;
  readonly provider: string;
  readonly profile?: string;
  readonly model?: string;
  readonly estimated_cost_microusd?: string;
  readonly estimate_source?: string;
  readonly input_fingerprint: string;
  readonly parent_attempt_id?: string;
  readonly input_ref?: string;
}

export type PaidAttemptStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'accepted'
  | 'acceptance_unknown'
  | 'cancelled'
  | 'blocked';

export interface PaidAttemptCompletion {
  readonly status: Exclude<PaidAttemptStatus, 'running' | 'blocked'>;
  readonly usage?: ProviderUsage;
  readonly output_fingerprint?: string;
  readonly output_ref?: string;
}

export interface PaidAttemptLedgerEntry {
  readonly attempt_id: string;
  readonly stage: PaidRunStage;
  readonly provider: string;
  readonly profile?: string;
  readonly model?: string;
  readonly parent_attempt_id?: string;
  readonly input_fingerprint: string;
  readonly input_ref?: string;
  readonly output_fingerprint?: string;
  readonly output_ref?: string;
  readonly started_at: string;
  readonly finished_at?: string;
  readonly status: PaidAttemptStatus;
  readonly estimate:
    | {
        readonly state: 'known';
        readonly cost_microusd: string;
        readonly source: string;
      }
    | { readonly state: 'unknown' };
  readonly reported:
    | { readonly state: 'known'; readonly cost_microusd: string }
    | { readonly state: 'unknown' };
  readonly reason_code?: string;
}

export interface PaidRunLedger {
  readonly schema_version: 1;
  readonly artifact: 'librarium.paid-attempt-ledger';
  readonly artifact_version: '1.0.0';
  readonly request_id: string;
  readonly canonical_run_ref: 'run.json';
  readonly request_fingerprint: string;
  readonly config_fingerprint: string;
  readonly created_at: string;
  readonly deadline_at: string;
  readonly cancellation_requested_at?: string;
  readonly limits: {
    readonly max_estimated_cost_microusd?: string;
    readonly max_actual_cost_microusd?: string;
  };
  readonly stages: readonly (PaidStageDeclaration & {
    readonly status: 'requested' | 'not_requested' | 'skipped';
    readonly reason_code?: string;
    readonly reserved_cost_microusd?: string;
  })[];
  readonly attempts: readonly PaidAttemptLedgerEntry[];
}

export class PaidRunAdmissionError extends Error {
  constructor(readonly reasonCode: string) {
    super(`Paid attempt blocked: ${reasonCode}`);
    this.name = 'PaidRunAdmissionError';
  }
}

export function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : canonicalJson(value))
    .digest('hex');
}

export function costMicrousdFromUsd(
  value: number | undefined,
): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return BigInt(Math.ceil(value * 1_000_000)).toString();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(
        ([key]) =>
          !/(?:api[_-]?key|token|secret|password|credential)/i.test(key),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function add(left: string, right: string): string {
  return (BigInt(left) + BigInt(right)).toString();
}

function exceeds(value: string, limit: string | undefined): boolean {
  return limit !== undefined && BigInt(value) > BigInt(limit);
}

function authorizedKey(provider: PaidStageProvider): string {
  return `${provider.provider}\0${provider.profile ?? ''}\0${provider.model ?? ''}`;
}

export interface RunPaidWalletOptions {
  readonly request_id: string;
  readonly request_fingerprint: string;
  readonly config_fingerprint: string;
  readonly created_at: string;
  readonly deadline_at: string;
  readonly limits?: PaidRunLedger['limits'];
  readonly stages: readonly PaidStageDeclaration[];
  readonly on_change?: (ledger: PaidRunLedger) => void;
  readonly now?: () => number;
  /** Previously validated durable state, used only when resuming a sidecar-bearing run. */
  readonly restored_ledger?: PaidRunLedger;
  /** Short cross-process critical section; never held across a provider call. */
  readonly with_mutation_lock?: <T>(action: () => T) => T;
  /** Fresh state read inside with_mutation_lock before every mutation. */
  readonly load_latest?: () => PaidRunLedger | undefined;
}

/** Sole run-wide admission and accounting authority for every paid call. */
export class RunPaidWallet {
  readonly #options: RunPaidWalletOptions;
  readonly #attempts: PaidAttemptLedgerEntry[] = [];
  readonly #stages: PaidRunLedger['stages'];
  readonly #authorized = new Map<PaidRunStage, Set<string>>();
  readonly #controller = new AbortController();
  readonly #signal: AbortSignal;
  readonly #policyFingerprint: string;
  #sequence = 0;
  #cancellationRequestedAt?: string;

  constructor(options: RunPaidWalletOptions) {
    this.#options = options;
    const remainingMs = Date.parse(options.deadline_at) - this.#now();
    const deadlineSignal =
      remainingMs <= 0
        ? AbortSignal.abort(new Error('Run deadline exceeded'))
        : AbortSignal.timeout(remainingMs);
    this.#signal = AbortSignal.any([this.#controller.signal, deadlineSignal]);
    if (options.restored_ledger) {
      const restored = structuredClone(options.restored_ledger);
      this.#stages = restored.stages;
      this.#attempts.push(...restored.attempts);
      this.#sequence = restored.attempts.reduce((highest, attempt) => {
        const sequence = Number.parseInt(
          attempt.attempt_id.replace(/^paid-attempt-/, ''),
          10,
        );
        return Number.isSafeInteger(sequence)
          ? Math.max(highest, sequence)
          : highest;
      }, 0);
      this.#cancellationRequestedAt = restored.cancellation_requested_at;
      if (this.#cancellationRequestedAt) this.#controller.abort();
      for (const stage of restored.stages) {
        this.#authorized.set(
          stage.stage,
          new Set(stage.providers.map(authorizedKey)),
        );
      }
      this.#policyFingerprint = fingerprint({
        limits: restored.limits,
        stages: restored.stages,
      });
      return;
    }
    let reserved = '0';
    this.#stages = options.stages.map((declaration) => {
      this.#authorized.set(
        declaration.stage,
        new Set(declaration.providers.map(authorizedKey)),
      );
      if (!declaration.requested) {
        return { ...declaration, status: 'not_requested' as const };
      }
      if (declaration.providers.length === 0) {
        return {
          ...declaration,
          status: 'skipped' as const,
          reason_code: 'no_authorized_provider',
        };
      }
      if (!declaration.reserve_first_attempt) {
        return { ...declaration, status: 'requested' as const };
      }
      const estimate = declaration.providers[0]?.estimated_cost_microusd;
      if (this.hasHardLimit() && estimate === undefined) {
        return {
          ...declaration,
          status: 'skipped' as const,
          reason_code: 'unknown_cost_under_hard_budget',
        };
      }
      if (estimate !== undefined) {
        const next = add(reserved, estimate);
        if (
          exceeds(next, options.limits?.max_estimated_cost_microusd) ||
          exceeds(next, options.limits?.max_actual_cost_microusd)
        ) {
          return {
            ...declaration,
            status: 'skipped' as const,
            reason_code: 'stage_reservation_exceeds_budget',
          };
        }
        reserved = next;
        return {
          ...declaration,
          status: 'requested' as const,
          reserved_cost_microusd: estimate,
        };
      }
      return { ...declaration, status: 'requested' as const };
    });
    this.#policyFingerprint = fingerprint({
      limits: options.limits ?? {},
      stages: this.#stages,
    });
    this.#emit();
  }

  get signal(): AbortSignal {
    return this.#signal;
  }

  get deadlineAt(): string {
    return this.#options.deadline_at;
  }

  remainingMs(): number {
    return Math.max(0, Date.parse(this.deadlineAt) - this.#now());
  }

  stageStatus(
    stage: PaidRunStage,
  ): PaidRunLedger['stages'][number] | undefined {
    return this.#stages.find((entry) => entry.stage === stage);
  }

  isAuthorized(
    stage: PaidRunStage,
    provider: Pick<PaidStageProvider, 'provider' | 'profile' | 'model'>,
  ): boolean {
    return this.#authorized.get(stage)?.has(authorizedKey(provider)) ?? false;
  }

  fallbackAuthorized(stage: PaidRunStage): boolean {
    return this.stageStatus(stage)?.fallback_authorized ?? false;
  }

  authorizedProvider(
    stage: PaidRunStage,
    provider: string,
  ): PaidStageProvider | undefined {
    const matches = this.stageStatus(stage)?.providers.filter(
      (candidate) => candidate.provider === provider,
    );
    if (!matches || matches.length === 0) return undefined;
    const distinct = new Set(matches.map(authorizedKey));
    return distinct.size === 1 ? matches[0] : undefined;
  }

  cancel(): void {
    this.#mutate(() => {
      if (this.#cancellationRequestedAt) return;
      this.#cancellationRequestedAt = new Date(this.#now()).toISOString();
      this.#controller.abort();
      this.#emit();
    });
  }

  begin(input: PaidAttemptInput): string {
    return this.#mutate(() => this.#begin(input));
  }

  #begin(input: PaidAttemptInput): string {
    const now = this.#now();
    const stage = this.stageStatus(input.stage);
    let reasonCode: string | undefined;
    if (stage?.status !== 'requested') {
      reasonCode = stage?.reason_code ?? 'stage_not_requested';
    } else if (this.#cancellationRequestedAt) {
      reasonCode = 'run_cancelled';
    } else if (now >= Date.parse(this.deadlineAt)) {
      reasonCode = 'run_deadline_exceeded';
    } else if (!this.#authorized.get(input.stage)?.has(authorizedKey(input))) {
      reasonCode = 'provider_not_authorized';
    } else if (
      this.hasHardLimit() &&
      input.estimated_cost_microusd === undefined
    ) {
      reasonCode = 'unknown_cost_under_hard_budget';
    } else {
      const estimate = input.estimated_cost_microusd ?? '0';
      const projectedEstimate = add(
        add(this.#committedEstimated(), this.#futureReservations(input.stage)),
        estimate,
      );
      const projectedActual = add(
        add(this.#committedActual(), this.#futureReservations(input.stage)),
        estimate,
      );
      if (
        exceeds(
          projectedEstimate,
          this.#options.limits?.max_estimated_cost_microusd,
        )
      ) {
        reasonCode = 'estimated_budget_exhausted';
      } else if (
        exceeds(projectedActual, this.#options.limits?.max_actual_cost_microusd)
      ) {
        reasonCode = 'actual_budget_exhausted';
      }
    }

    const attemptId = `paid-attempt-${++this.#sequence}`;
    const entry: PaidAttemptLedgerEntry = {
      attempt_id: attemptId,
      stage: input.stage,
      provider: input.provider,
      ...(input.profile && { profile: input.profile }),
      ...(input.model && { model: input.model }),
      ...(input.parent_attempt_id && {
        parent_attempt_id: input.parent_attempt_id,
      }),
      input_fingerprint: input.input_fingerprint,
      ...(input.input_ref && { input_ref: input.input_ref }),
      started_at: new Date(now).toISOString(),
      status: reasonCode ? 'blocked' : 'running',
      estimate:
        input.estimated_cost_microusd === undefined
          ? { state: 'unknown' }
          : {
              state: 'known',
              cost_microusd: input.estimated_cost_microusd,
              source: input.estimate_source ?? 'network_free_estimate',
            },
      reported: { state: 'unknown' },
      ...(reasonCode && {
        finished_at: new Date(now).toISOString(),
        reason_code: reasonCode,
      }),
    };
    this.#attempts.push(entry);
    this.#emit();
    if (reasonCode) throw new PaidRunAdmissionError(reasonCode);
    return attemptId;
  }

  finish(attemptId: string, completion: PaidAttemptCompletion): void {
    this.#mutate(() => this.#finish(attemptId, completion));
  }

  #finish(attemptId: string, completion: PaidAttemptCompletion): void {
    const index = this.#attempts.findIndex(
      (entry) => entry.attempt_id === attemptId,
    );
    const prior = this.#attempts[index];
    if (prior?.status !== 'running') return;
    const reported = costMicrousdFromUsd(completion.usage?.costUsd);
    this.#attempts[index] = {
      ...prior,
      status: this.#cancellationRequestedAt ? 'cancelled' : completion.status,
      finished_at: new Date(this.#now()).toISOString(),
      reported:
        reported === undefined
          ? { state: 'unknown' }
          : { state: 'known', cost_microusd: reported },
      ...(completion.output_fingerprint && {
        output_fingerprint: completion.output_fingerprint,
      }),
      ...(completion.output_ref && { output_ref: completion.output_ref }),
    };
    this.#emit();
  }

  reconcileParentAttempt(
    parentAttemptId: string,
    completion: PaidAttemptCompletion,
  ): void {
    this.#mutate(() =>
      this.#reconcileParentAttempt(parentAttemptId, completion),
    );
  }

  #reconcileParentAttempt(
    parentAttemptId: string,
    completion: PaidAttemptCompletion,
  ): void {
    const attempt = this.#attempts.findLast(
      (entry) =>
        entry.parent_attempt_id === parentAttemptId &&
        ['running', 'accepted', 'acceptance_unknown'].includes(entry.status),
    );
    if (!attempt) return;
    const index = this.#attempts.indexOf(attempt);
    const reported = costMicrousdFromUsd(completion.usage?.costUsd);
    this.#attempts[index] = {
      ...attempt,
      status: this.#cancellationRequestedAt ? 'cancelled' : completion.status,
      finished_at: new Date(this.#now()).toISOString(),
      reported:
        reported === undefined
          ? { state: 'unknown' }
          : { state: 'known', cost_microusd: reported },
      ...(completion.output_fingerprint && {
        output_fingerprint: completion.output_fingerprint,
      }),
      ...(completion.output_ref && { output_ref: completion.output_ref }),
    };
    this.#emit();
  }

  snapshot(): PaidRunLedger {
    return structuredClone({
      schema_version: 1 as const,
      artifact: 'librarium.paid-attempt-ledger' as const,
      artifact_version: '1.0.0' as const,
      request_id: this.#options.request_id,
      canonical_run_ref: 'run.json' as const,
      request_fingerprint: this.#options.request_fingerprint,
      config_fingerprint: this.#options.config_fingerprint,
      created_at: this.#options.created_at,
      deadline_at: this.#options.deadline_at,
      ...(this.#cancellationRequestedAt && {
        cancellation_requested_at: this.#cancellationRequestedAt,
      }),
      limits: this.#options.limits ?? {},
      stages: this.#stages,
      attempts: this.#attempts,
    });
  }

  private hasHardLimit(): boolean {
    return Boolean(
      this.#options.limits?.max_estimated_cost_microusd !== undefined ||
        this.#options.limits?.max_actual_cost_microusd !== undefined,
    );
  }

  #committedEstimated(): string {
    return this.#attempts.reduce(
      (total, attempt) =>
        attempt.status === 'blocked' || attempt.estimate.state === 'unknown'
          ? total
          : add(total, attempt.estimate.cost_microusd),
      '0',
    );
  }

  #committedActual(): string {
    return this.#attempts.reduce((total, attempt) => {
      if (attempt.status === 'blocked') return total;
      if (attempt.reported.state === 'known') {
        return add(total, attempt.reported.cost_microusd);
      }
      return attempt.estimate.state === 'known'
        ? add(total, attempt.estimate.cost_microusd)
        : total;
    }, '0');
  }

  #futureReservations(activeStage: PaidRunStage): string {
    return this.#stages.reduce((total, stage) => {
      if (
        stage.stage === activeStage ||
        stage.status !== 'requested' ||
        stage.reserved_cost_microusd === undefined ||
        this.#attempts.some(
          (attempt) =>
            attempt.stage === stage.stage && attempt.status !== 'blocked',
        )
      ) {
        return total;
      }
      return add(total, stage.reserved_cost_microusd);
    }, '0');
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #mutate<T>(action: () => T): T {
    const mutate = () => {
      if (this.#options.load_latest) {
        const latest = this.#options.load_latest();
        if (!latest) {
          throw new Error('The required paid-attempt ledger is missing.');
        }
        if (
          latest.request_id !== this.#options.request_id ||
          latest.request_fingerprint !== this.#options.request_fingerprint ||
          latest.config_fingerprint !== this.#options.config_fingerprint ||
          latest.created_at !== this.#options.created_at ||
          latest.deadline_at !== this.#options.deadline_at ||
          fingerprint({ limits: latest.limits, stages: latest.stages }) !==
            this.#policyFingerprint
        ) {
          throw new Error(
            'The paid-attempt ledger no longer matches this run.',
          );
        }
        this.#attempts.splice(
          0,
          this.#attempts.length,
          ...structuredClone(latest.attempts),
        );
        this.#sequence = this.#attempts.reduce((highest, attempt) => {
          const sequence = Number.parseInt(
            attempt.attempt_id.replace(/^paid-attempt-/, ''),
            10,
          );
          return Number.isSafeInteger(sequence)
            ? Math.max(highest, sequence)
            : highest;
        }, 0);
        this.#cancellationRequestedAt = latest.cancellation_requested_at;
        if (this.#cancellationRequestedAt) this.#controller.abort();
      }
      return action();
    };
    return this.#options.with_mutation_lock
      ? this.#options.with_mutation_lock(mutate)
      : mutate();
  }

  #emit(): void {
    this.#options.on_change?.(this.snapshot());
  }
}
