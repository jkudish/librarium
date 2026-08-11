/** Pure validation/projection helpers for the internal reconciliation service. */
import { parseMetering, parseUsage } from './node-run-artifact-codecs.js';
import type {
  AsyncTaskStatus,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from './types.js';

export const TASK_STATUSES = new Set<AsyncTaskStatus>([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export const PROVIDER_TIERS = new Set<ProviderTier>([
  'deep-research',
  'ai-grounded',
  'raw-search',
  'llm',
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSafeText(value: unknown, maxLength = 512): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maxLength &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  );
}

export function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function validNonnegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Local, registry-free usage normalization for a completed provider result. */
function normalizeProviderUsage(
  result: Pick<ProviderResult, 'usage' | 'tokenUsage'>,
): ProviderUsage | undefined {
  if (result.usage !== undefined) {
    const usage: ProviderUsage = {};
    const source = result.usage as Record<string, unknown>;
    for (const key of [
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'costUsd',
      'billableUnits',
      'unit',
    ] as const) {
      if (source[key] !== undefined) {
        (usage as Record<string, unknown>)[key] = source[key];
      }
    }
    return usage;
  }
  const tokens = result.tokenUsage;
  if (!tokens || (tokens.input === undefined && tokens.output === undefined)) {
    return undefined;
  }
  return {
    ...(tokens.input === undefined ? {} : { inputTokens: tokens.input }),
    ...(tokens.output === undefined ? {} : { outputTokens: tokens.output }),
    ...(tokens.input === undefined || tokens.output === undefined
      ? {}
      : { totalTokens: tokens.input + tokens.output }),
  };
}

export interface NormalizedSuccess {
  readonly content: string;
  readonly tier: ProviderTier;
  readonly durationMs: number;
  readonly citations: readonly {
    readonly url: string;
    readonly provider: string;
    readonly title?: string;
    readonly snippet?: string;
  }[];
  readonly model?: string;
  readonly tokenUsage?: { readonly input?: number; readonly output?: number };
  readonly usage?: ReturnType<typeof parseUsage>;
  readonly metering?: ReturnType<typeof parseMetering>;
  readonly preventFallback?: true;
}

/**
 * Normalize a provider result before any artifact write. Every rejected shape
 * intentionally maps to one stable code; raw vendor diagnostics never reach
 * the manifest or reconciliation result.
 */
export function normalizeSuccess(
  result: unknown,
  providerId: string,
): NormalizedSuccess | { readonly error: 'provider.result_invalid' } {
  if (!isRecord(result)) return { error: 'provider.result_invalid' };
  if (result.provider !== providerId) {
    return { error: 'provider.result_invalid' };
  }
  if (!PROVIDER_TIERS.has(result.tier as ProviderTier)) {
    return { error: 'provider.result_invalid' };
  }
  if (typeof result.content !== 'string') {
    return { error: 'provider.result_invalid' };
  }
  if (!validNonnegativeNumber(result.durationMs)) {
    return { error: 'provider.result_invalid' };
  }
  if (!Array.isArray(result.citations)) {
    return { error: 'provider.result_invalid' };
  }
  const citations: NormalizedSuccess['citations'][number][] = [];
  for (const citation of result.citations) {
    if (!isRecord(citation)) return { error: 'provider.result_invalid' };
    if (
      typeof citation.url !== 'string' ||
      typeof citation.provider !== 'string' ||
      citation.provider !== providerId ||
      (citation.title !== undefined && typeof citation.title !== 'string') ||
      (citation.snippet !== undefined && typeof citation.snippet !== 'string')
    ) {
      return { error: 'provider.result_invalid' };
    }
    citations.push({
      url: citation.url,
      provider: providerId,
      ...(citation.title === undefined ? {} : { title: citation.title }),
      ...(citation.snippet === undefined ? {} : { snippet: citation.snippet }),
    });
  }
  let tokenUsage: NormalizedSuccess['tokenUsage'];
  if (result.tokenUsage !== undefined) {
    if (!isRecord(result.tokenUsage)) {
      return { error: 'provider.result_invalid' };
    }
    const input = result.tokenUsage.input;
    const output = result.tokenUsage.output;
    for (const key of ['input', 'output'] as const) {
      const value = result.tokenUsage[key];
      if (value !== undefined && !validNonnegativeNumber(value)) {
        return { error: 'provider.result_invalid' };
      }
    }
    if (input === undefined && output === undefined) {
      return { error: 'provider.result_invalid' };
    }
    tokenUsage = {
      ...(input === undefined ? {} : { input: input as number }),
      ...(output === undefined ? {} : { output: output as number }),
    };
  }
  let usage: NormalizedSuccess['usage'];
  if (result.usage !== undefined) {
    usage = parseUsage(result.usage);
    if (usage === undefined) return { error: 'provider.result_invalid' };
  } else {
    const normalized = normalizeProviderUsage(
      result as unknown as ProviderResult,
    );
    if (normalized !== undefined) {
      usage = parseUsage(normalized);
      if (usage === undefined) return { error: 'provider.result_invalid' };
    }
  }
  let metering: NormalizedSuccess['metering'];
  if (result.metering !== undefined) {
    metering = parseMetering(result.metering);
    if (metering === undefined) return { error: 'provider.result_invalid' };
  }
  if (result.model !== undefined && !isSafeText(result.model)) {
    return { error: 'provider.result_invalid' };
  }
  if (result.preventFallback !== undefined && result.preventFallback !== true) {
    return { error: 'provider.result_invalid' };
  }
  return {
    content: result.content,
    tier: result.tier as ProviderTier,
    durationMs: result.durationMs,
    citations,
    ...(result.model === undefined ? {} : { model: result.model }),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    ...(usage === undefined ? {} : { usage }),
    ...(metering === undefined ? {} : { metering }),
    ...(result.preventFallback === true ? { preventFallback: true } : {}),
  };
}

export type ReconciliationTaskOutcome =
  | 'pending'
  | 'running'
  | 'completed'
  | 'retrieved'
  | 'failed'
  | 'cancelled'
  | 'unsupported'
  | 'error';

export interface ReconciliationTaskResult {
  readonly provider: string;
  readonly taskId: string;
  readonly submittedAt: number;
  readonly status: ReconciliationTaskOutcome;
  readonly polled: boolean;
  readonly retrieved: boolean;
  /** True only when this reconciliation pass committed the retrieval. */
  readonly retrievedThisPass: boolean;
  readonly providerStatus?: string;
  readonly lastPolledAt?: number;
  readonly completedAt?: number;
  readonly retrievedAt?: number;
  readonly error?: string;
}

export function taskResultFromReport(
  provider: string,
  report: Readonly<{
    task?: {
      taskId: string;
      submittedAt: number;
      status: AsyncTaskStatus;
      providerStatus?: string;
      lastPolledAt?: number;
      completedAt?: number;
      retrievedAt?: number;
      lastPollError?: string;
    };
  }>,
  polled: boolean,
  retrieved: boolean,
  overrideStatus?: ReconciliationTaskOutcome,
  error?: string,
): ReconciliationTaskResult | null {
  const task = report.task;
  if (!task) return null;
  return {
    provider,
    taskId: task.taskId,
    submittedAt: task.submittedAt,
    status:
      overrideStatus ??
      (retrieved || task.retrievedAt !== undefined
        ? 'retrieved'
        : task.status === 'failed'
          ? 'failed'
          : task.status === 'cancelled'
            ? 'cancelled'
            : task.status),
    polled,
    retrieved: retrieved || task.retrievedAt !== undefined,
    retrievedThisPass: retrieved,
    ...(task.providerStatus === undefined
      ? {}
      : { providerStatus: task.providerStatus }),
    ...(task.lastPolledAt === undefined
      ? {}
      : { lastPolledAt: task.lastPolledAt }),
    ...(task.completedAt === undefined
      ? {}
      : { completedAt: task.completedAt }),
    ...(task.retrievedAt === undefined
      ? {}
      : { retrievedAt: task.retrievedAt }),
    ...(error === undefined && task.lastPollError === undefined
      ? {}
      : { error: error ?? task.lastPollError }),
  };
}
