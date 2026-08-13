import { z } from 'zod/v4';
import { OpaqueIdSchema, Rfc3339UtcSchema } from '../contracts/common.js';
import {
  type ExecutionProfile,
  providerIdentityKey,
  RuntimeEffectiveTargetSchema,
  type StructuredError,
} from '../contracts/domain/index.js';
import {
  type ResearchError,
  type ResearchResponse,
  ResearchResponseSchema,
} from '../contracts/interchange/research-response.js';
import {
  CitationSchema,
  ProviderMetaSchema,
  type ResearchResult,
  UsageSchema,
} from '../contracts/interchange/research-result.js';
import type {
  AttemptLaunch,
  CoordinatorAttemptState,
  CoordinatorSlotState,
  CoordinatorState,
} from './coordinator.js';
import { classifySourceKindFromUrl } from './source-kind.js';

const CanonicalOutputBase = {
  result_id: OpaqueIdSchema,
  citations: z.array(CitationSchema),
  observed_at: Rfc3339UtcSchema,
  completed_at: Rfc3339UtcSchema,
  model: z.string().min(1).optional(),
  effective_target: RuntimeEffectiveTargetSchema.optional(),
  usage: UsageSchema.optional(),
  provider_meta: ProviderMetaSchema.optional(),
};

/**
 * Safe, provider-independent output retained in run.json before a successful
 * coordinator transition commits. Raw provider payloads never enter this
 * shape.
 */
const CanonicalProviderOutputShapeSchema = z.union([
  z.strictObject({
    ...CanonicalOutputBase,
    content_format: z.literal('markdown'),
    content: z.string(),
  }),
  z.strictObject({
    ...CanonicalOutputBase,
    content_format: z.literal('text'),
    content: z.string(),
  }),
  z.strictObject({
    ...CanonicalOutputBase,
    content_format: z.literal('json'),
    content: z.union([z.record(z.string(), z.json()), z.array(z.json())]),
  }),
]);

function inspectPersistedMetadata(
  value: unknown,
  path: PropertyKey[],
  ctx: z.RefinementCtx,
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      inspectPersistedMetadata(child, [...path, index], ctx);
    });
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .replace(/([a-z\d])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[^a-z\d]+/g, '_');
    if (
      /(?:^|_)(?:path|paths|directory|directories|filename|filenames)(?:_|$)/.test(
        normalized,
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Persisted provider metadata cannot contain filesystem paths',
        path: ['provider_meta', ...path, key],
      });
    }
    inspectPersistedMetadata(child, [...path, key], ctx);
  }
}

export const CanonicalProviderOutputSchema =
  CanonicalProviderOutputShapeSchema.superRefine((output, ctx) => {
    inspectPersistedMetadata(output.provider_meta, [], ctx);
  });

export type CanonicalProviderOutput = z.infer<
  typeof CanonicalProviderOutputSchema
>;

const LegacyProviderResultSchema = z.strictObject({
  provider: z.string().min(1),
  tier: z.enum(['deep-research', 'ai-grounded', 'raw-search', 'llm']),
  content: z.string(),
  citations: z.array(
    z.strictObject({
      url: z.string().min(1),
      title: z.string().optional(),
      snippet: z.string().optional(),
      provider: z.string().min(1),
    }),
  ),
  durationMs: z.number().finite().nonnegative(),
  model: z.string().min(1).optional(),
  tokenUsage: z
    .strictObject({
      input: z.number().int().safe().nonnegative().optional(),
      output: z.number().int().safe().nonnegative().optional(),
    })
    .optional(),
  usage: z
    .strictObject({
      inputTokens: z.number().int().safe().nonnegative().optional(),
      outputTokens: z.number().int().safe().nonnegative().optional(),
      totalTokens: z.number().int().safe().nonnegative().optional(),
      cacheWriteInputTokens: z.number().int().safe().nonnegative().optional(),
      cacheReadInputTokens: z.number().int().safe().nonnegative().optional(),
      reasoningTokens: z.number().int().safe().nonnegative().optional(),
      costUsd: z.number().finite().nonnegative().optional(),
      billableUnits: z.number().finite().nonnegative().optional(),
      unit: z.string().min(1).optional(),
      raw: z.unknown().optional(),
    })
    .optional(),
  metering: z
    .strictObject({
      kind: z.enum([
        'native_cost',
        'native_tokens',
        'request_priced',
        'credit_priced',
        'api_unit_priced',
        'manual_unmetered',
      ]),
      pricingVersion: z.string().min(1).optional(),
      estimate: z
        .strictObject({
          estimatedCostUsd: z.number().finite().nonnegative().optional(),
          billableUnits: z.number().finite().nonnegative().optional(),
          unit: z.string().min(1).optional(),
          pricingVersion: z.string().min(1).optional(),
          costConfidence: z.enum([
            'reported',
            'configured',
            'estimated',
            'unknown',
          ]),
        })
        .optional(),
      actual: z
        .strictObject({
          costUsd: z.number().finite().nonnegative().optional(),
          source: z.enum([
            'provider_reported',
            'computed_from_tokens',
            'computed_from_request',
            'computed_from_credits',
            'account_usage_delta',
            'unknown',
          ]),
          billableUnits: z.number().finite().nonnegative().optional(),
        })
        .optional(),
    })
    .optional(),
  providerMeta: ProviderMetaSchema.optional(),
  error: z.string().optional(),
  preventFallback: z.literal(true).optional(),
});

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function decimalFromNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Usage costs must be finite non-negative numbers.');
  }
  if (Number.isInteger(value)) return String(value);
  const fixed = value.toFixed(18).replace(/0+$/, '').replace(/\.$/, '');
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(fixed)) {
    throw new Error('Usage cost cannot be represented as an exact decimal.');
  }
  return fixed;
}

function legacyUsage(
  result: z.infer<typeof LegacyProviderResultSchema>,
): CanonicalProviderOutput['usage'] {
  const promptTokens = result.usage?.inputTokens ?? result.tokenUsage?.input;
  const completionTokens =
    result.usage?.outputTokens ?? result.tokenUsage?.output;
  const actualCost = result.usage?.costUsd ?? result.metering?.actual?.costUsd;
  const estimatedCost = result.metering?.estimate?.estimatedCostUsd;
  const usage = {
    ...(promptTokens !== undefined && { prompt_tokens: promptTokens }),
    ...(completionTokens !== undefined && {
      completion_tokens: completionTokens,
    }),
    ...(result.usage?.cacheWriteInputTokens !== undefined && {
      cache_write_input_tokens: result.usage.cacheWriteInputTokens,
    }),
    ...(result.usage?.cacheReadInputTokens !== undefined && {
      cache_read_input_tokens: result.usage.cacheReadInputTokens,
    }),
    ...(result.usage?.reasoningTokens !== undefined && {
      reasoning_tokens: result.usage.reasoningTokens,
    }),
    ...(actualCost !== undefined && {
      actual_cost: decimalFromNumber(actualCost),
    }),
    ...(estimatedCost !== undefined && {
      estimated_cost: decimalFromNumber(estimatedCost),
    }),
    ...((actualCost !== undefined || estimatedCost !== undefined) && {
      currency: 'USD',
    }),
  };
  return Object.keys(usage).length === 0 ? undefined : UsageSchema.parse(usage);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Convert the existing Node adapter result into the safe staged output model.
 * A future adapter may return CanonicalProviderOutput directly. In both cases
 * the exact launch/result binding is checked before persistence.
 */
export function normalizeProviderAttemptOutput(
  launch: AttemptLaunch,
  resultId: string,
  output: unknown,
  completedAt: string,
): CanonicalProviderOutput {
  const canonical = CanonicalProviderOutputSchema.safeParse(output);
  if (canonical.success) {
    if (canonical.data.result_id !== resultId) {
      throw new Error('Provider output result_id does not match the attempt.');
    }
    return structuredClone(canonical.data);
  }

  const legacy = LegacyProviderResultSchema.parse(output);
  if (legacy.error !== undefined) {
    throw new Error('A successful attempt cannot persist an error result.');
  }
  if (legacy.provider !== launch.binding.adapter_id) {
    throw new Error(
      'Provider output does not match the frozen launch provider.',
    );
  }
  legacy.citations.forEach((citation) => {
    if (citation.provider !== legacy.provider) {
      throw new Error('Provider citation identity does not match its output.');
    }
  });

  const providerMeta = ProviderMetaSchema.parse({
    ...(legacy.providerMeta ?? {}),
    'librarium:tier': legacy.tier,
    'librarium:duration_ms': legacy.durationMs,
    ...(legacy.metering && {
      'librarium:metering': {
        kind: legacy.metering.kind,
        ...(legacy.metering.pricingVersion && {
          pricing_version: legacy.metering.pricingVersion,
        }),
        ...(legacy.metering.actual && {
          actual_cost_source: legacy.metering.actual.source,
        }),
      },
    }),
  });

  return CanonicalProviderOutputSchema.parse({
    result_id: resultId,
    content_format: 'markdown',
    content: legacy.content,
    observed_at: completedAt,
    completed_at: completedAt,
    ...(legacy.model && { model: legacy.model }),
    citations: legacy.citations.map((citation, index) => ({
      id: `citation-${index + 1}`,
      derivation: 'provider_reported' as const,
      source: {
        // URL identity only — never invent tool provenance from the profile.
        kind: classifySourceKindFromUrl(citation.url),
        url: citation.url,
        ...(nonEmpty(citation.title) && { title: nonEmpty(citation.title) }),
      },
      ...(nonEmpty(citation.snippet) && {
        excerpt: nonEmpty(citation.snippet),
      }),
    })),
    ...(legacyUsage(legacy) && { usage: legacyUsage(legacy) }),
    provider_meta: providerMeta,
  });
}

const SUPPORTED_RESULT_KINDS = new Set([
  'search_results',
  'grounded_answer',
  'research_report',
  'model_answer',
]);
const SUPPORTED_RETRIEVAL_METHODS = new Set([
  'search_endpoint',
  'model_search_tool',
  'research_agent',
  'model_only',
]);
const SUPPORTED_CORPORA = new Set(['web', 'news', 'x', 'files', 'places']);

export function assertResearchResponseProjectableProfile(
  profile: ExecutionProfile,
): void {
  if (!SUPPORTED_RESULT_KINDS.has(profile.result_kind)) {
    throw new Error(
      `Profile ${providerIdentityKey(profile.identity)} uses result kind ${profile.result_kind}, which is not representable in ResearchResponse.`,
    );
  }
  if (!SUPPORTED_RETRIEVAL_METHODS.has(profile.retrieval_method)) {
    throw new Error(
      `Profile ${providerIdentityKey(profile.identity)} uses retrieval method ${profile.retrieval_method}, which is not representable in ResearchResponse.`,
    );
  }
  const unsupportedCorpus = profile.corpora.find(
    (corpus) => !SUPPORTED_CORPORA.has(corpus),
  );
  if (unsupportedCorpus) {
    throw new Error(
      `Profile ${providerIdentityKey(profile.identity)} uses corpus ${unsupportedCorpus}, which is not representable in ResearchResponse.`,
    );
  }
}

function terminalProvenance(
  profile: ExecutionProfile,
  output: CanonicalProviderOutput,
): ResearchResult['provenance'] {
  assertResearchResponseProjectableProfile(profile);
  const context = profile.surface_context
    ? {
        ...(profile.surface_context.locale && {
          locale: profile.surface_context.locale,
        }),
        ...(profile.surface_context.country && {
          country: profile.surface_context.country,
        }),
        ...(profile.surface_context.device && {
          device: profile.surface_context.device,
        }),
        authentication: profile.surface_context.account_context,
      }
    : undefined;
  return {
    result_kind:
      profile.result_kind as ResearchResult['provenance']['result_kind'],
    retrieval_methods: [
      profile.retrieval_method as ResearchResult['provenance']['retrieval_methods'][number],
    ],
    corpora: [...(profile.corpora as ResearchResult['provenance']['corpora'])],
    observed_at: output.observed_at,
    ...(profile.collector_id && { collector: profile.collector_id }),
    ...(profile.surface_id && { surface: profile.surface_id }),
    ...(context && { context }),
  };
}

function latestAttempt(
  state: CoordinatorState,
  slot: CoordinatorSlotState,
): CoordinatorAttemptState | undefined {
  return slot.latest_attempt_id
    ? state.attempts.find(
        (attempt) => attempt.attempt_id === slot.latest_attempt_id,
      )
    : undefined;
}

function configuredModel(profile: ExecutionProfile): string | undefined {
  const slots = [
    profile.identity.target.primary,
    profile.identity.target.underlying,
  ];
  return slots.find(
    (target) =>
      target?.kind === 'model' &&
      (target.model_selection === 'fixed' ||
        target.model_selection === 'configurable') &&
      target.target_id,
  )?.target_id;
}

function resultMetadata(
  profile: ExecutionProfile,
  output: CanonicalProviderOutput,
): ResearchResult['provider_meta'] {
  const metadata = {
    ...(output.provider_meta ?? {}),
    'librarium:configured_target': profile.identity.target,
    ...(output.effective_target && {
      'librarium:effective_target': output.effective_target,
    }),
  };
  return ProviderMetaSchema.parse(metadata);
}

function projectResult(
  state: CoordinatorState,
  slot: CoordinatorSlotState,
  attempt: CoordinatorAttemptState,
  output: CanonicalProviderOutput,
): ResearchResult {
  if (
    attempt.status !== 'succeeded' ||
    !attempt.result_id ||
    attempt.result_id !== slot.result_id ||
    output.result_id !== attempt.result_id
  ) {
    throw new Error('Succeeded slot/result state is internally inconsistent.');
  }
  const requestedProfile = slot.primary.identity.profile_id;
  const effectiveProfile = attempt.profile.identity;
  const replaced = attempt.replaces_attempt_id
    ? state.attempts.find(
        (candidate) => candidate.attempt_id === attempt.replaces_attempt_id,
      )
    : undefined;
  if (attempt.replaces_attempt_id && !replaced?.error) {
    throw new Error('Fallback success is missing its replaced attempt error.');
  }
  const model =
    output.model ??
    (output.effective_target?.kind === 'model'
      ? output.effective_target.target_id
      : configuredModel(attempt.profile));
  const common = {
    id: output.result_id,
    requested_profile: requestedProfile,
    provider: effectiveProfile.provider_id,
    profile: effectiveProfile.profile_id,
    provenance: terminalProvenance(attempt.profile, output),
    citations: structuredClone(output.citations),
    completed_at: output.completed_at,
    ...(model && { model }),
    ...(replaced?.error && { fallback_reason: replaced.error.code }),
    ...(output.usage && { usage: structuredClone(output.usage) }),
    provider_meta: resultMetadata(attempt.profile, output),
  };
  if (output.content_format === 'json') {
    return { ...common, content_format: 'json', content: output.content };
  }
  return {
    ...common,
    content_format: output.content_format,
    content: output.content,
  };
}

function publicError(
  error: StructuredError,
  profile?: ExecutionProfile,
): ResearchError {
  return {
    code: `librarium.${error.code}`,
    message: error.message,
    ...(profile && {
      profile: `${profile.identity.provider_id}/${profile.identity.profile_id}`,
    }),
  };
}

function terminalErrors(state: CoordinatorState): ResearchError[] {
  const errors: ResearchError[] = [];
  const seen = new Set<string>();
  const append = (error: StructuredError, profile?: ExecutionProfile) => {
    const projected = publicError(error, profile);
    const key = JSON.stringify(projected);
    if (!seen.has(key)) {
      seen.add(key);
      errors.push(projected);
    }
  };

  for (const slot of [...state.slots].sort(
    (left, right) => left.position - right.position,
  )) {
    if (slot.status === 'succeeded') continue;
    const attempt = latestAttempt(state, slot);
    const error = slot.error ?? attempt?.error;
    if (error) append(error, attempt?.profile ?? slot.primary);
  }
  if (state.infrastructure_error) append(state.infrastructure_error);
  if (state.cancellation?.error) append(state.cancellation.error);

  if (errors.length === 0 && state.status === 'cancelled') {
    errors.push({
      code: 'librarium.request_cancelled',
      message: 'The research request was cancelled.',
    });
  }
  return errors;
}

function addDecimal(left: string, right: string): string {
  const [leftWhole = '0', leftFraction = ''] = left.split('.');
  const [rightWhole = '0', rightFraction = ''] = right.split('.');
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftUnits = BigInt(leftWhole + leftFraction.padEnd(scale, '0'));
  const rightUnits = BigInt(rightWhole + rightFraction.padEnd(scale, '0'));
  const units = (leftUnits + rightUnits).toString().padStart(scale + 1, '0');
  if (scale === 0) return units;
  const whole = units.slice(0, -scale);
  const fraction = units.slice(-scale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function aggregateUsage(
  results: readonly ResearchResult[],
): ResearchResponse['usage'] {
  const usages = results.flatMap((result) =>
    result.usage ? [result.usage] : [],
  );
  if (usages.length === 0) return undefined;
  const integerFields = [
    'prompt_tokens',
    'completion_tokens',
    'cache_write_input_tokens',
    'cache_read_input_tokens',
    'reasoning_tokens',
  ] as const;
  const aggregate: NonNullable<ResearchResponse['usage']> = {};
  for (const field of integerFields) {
    const values = usages.flatMap((usage) =>
      usage[field] === undefined ? [] : [usage[field]],
    );
    if (values.length > 0)
      aggregate[field] = values.reduce((sum, value) => sum + value, 0);
  }
  const currencies = new Set(
    usages.flatMap((usage) => (usage.currency ? [usage.currency] : [])),
  );
  if (currencies.size <= 1) {
    for (const field of ['actual_cost', 'estimated_cost'] as const) {
      const values = usages.flatMap((usage) =>
        usage[field] === undefined ? [] : [usage[field]],
      );
      if (values.length > 0) {
        aggregate[field] = values.reduce(addDecimal, '0');
      }
    }
    if (aggregate.actual_cost || aggregate.estimated_cost) {
      aggregate.currency = [...currencies][0];
    }
  }
  return Object.keys(aggregate).length === 0
    ? undefined
    : UsageSchema.parse(aggregate);
}

function completedAt(state: CoordinatorState): string {
  const terminal = [...state.lifecycle]
    .reverse()
    .find((event) =>
      ['request_completed', 'request_failed', 'request_cancelled'].includes(
        event.event_kind,
      ),
    );
  if (!terminal) {
    throw new Error('Terminal coordinator state is missing a terminal event.');
  }
  return terminal.occurred_at;
}

export interface ResearchResponseProjectionOptions {
  readonly generator: string;
  readonly generator_version: string;
}

/** Deterministically project private coordinator state into the public receipt. */
export function projectResearchResponse(
  state: CoordinatorState,
  outputsByAttempt: Readonly<Record<string, CanonicalProviderOutput>>,
  options: ResearchResponseProjectionOptions,
): ResearchResponse {
  if (state.status === 'running') {
    throw new Error('A running coordinator state has no terminal response.');
  }
  const results = [...state.slots]
    .sort((left, right) => left.position - right.position)
    .flatMap((slot) => {
      if (slot.status !== 'succeeded') return [];
      const attempt = latestAttempt(state, slot);
      if (!attempt) {
        throw new Error('Succeeded slot is missing its selected attempt.');
      }
      const output = outputsByAttempt[attempt.attempt_id];
      if (!output) {
        throw new Error(
          `Succeeded attempt ${attempt.attempt_id} has no durable provider output.`,
        );
      }
      return [projectResult(state, slot, attempt, output)];
    });
  const errors = terminalErrors(state);
  const status =
    results.length > 0
      ? errors.length > 0
        ? 'partial'
        : 'succeeded'
      : 'failed';
  const response = ResearchResponseSchema.parse({
    generator: options.generator,
    generator_version: options.generator_version,
    request_id: state.request_id,
    status,
    completed_at: completedAt(state),
    results,
    errors,
    ...(aggregateUsage(results) && { usage: aggregateUsage(results) }),
  });
  return deepFreeze(response);
}
