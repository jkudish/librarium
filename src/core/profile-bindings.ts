import type { z } from 'zod';
import { OpaqueIdSchema } from '../contracts/common.js';
import type { Corpus, ExecutionProfile } from '../contracts/domain/index.js';
import type { NetworkFreeEstimate } from './execution-plan.js';
import {
  getBuiltinProviderDefinition,
  type ProviderMeteringDescriptor,
} from './provider-descriptor.js';
import {
  catalogProfileKey,
  declaredExecutionProfile,
  type ExecutableProfileDeclaration,
} from './provider-profiles.js';

/**
 * The provider configuration a binding resolves against.
 *
 * This is the v1 `ProviderConfig` shape, narrowed to the two fields that decide
 * the executable strategy. `model` is deliberately top-level rather than an
 * option: `src/adapters/provider-descriptors.ts` reads `providerConfig.model`
 * for every model-configurable adapter, so that is the identifier the adapter
 * actually sends. `options` stays behind `options_schema` and is never widened
 * here.
 */
export interface ProfileBindingConfig {
  readonly model?: string;
  readonly options?: unknown;
}

/**
 * One implemented declaration binds to exactly one adapter strategy. The
 * binding turns a validated configuration into the single exact execution
 * profile that will run, plus a network-free estimate when -- and only when --
 * the price is exact and non-volatile.
 *
 * The record itself is shallow-frozen: metadata cannot be reassigned after
 * construction, while the shared zod schema and the resolver closure are kept
 * by reference rather than recursively frozen.
 */
export interface ProfileBinding {
  readonly provider_id: string;
  readonly profile_id: string;
  readonly adapter_id: string;
  readonly binding_id: string;
  readonly options_schema: z.ZodTypeAny;
  /** Validates a top-level v1/v2 model override before adapter construction. */
  validateModel(model?: string): void;
  resolve(config?: ProfileBindingConfig): {
    readonly profile: ExecutionProfile;
    readonly estimate?: NetworkFreeEstimate;
  };
}

export class ProfileBindingError extends Error {}

/** A stable, path-independent diagnostic from the shared target policy. */
export class TargetSelectionError extends ProfileBindingError {
  constructor(
    readonly code:
      | 'config_model_not_configurable'
      | 'config_model_not_allowed'
      | 'config_model_invalid',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Exact reviewed models which preserve each provider's dedicated tool contract.
 *
 * These lists are intentionally small. A provider may add a model only after a
 * reviewed compatibility change; a prefix or family match would silently turn
 * an unsupported configuration into a paid request.
 */
const MODEL_OVERRIDE_ALLOWLISTS: Readonly<Record<string, ReadonlySet<string>>> =
  {
    'gemini-grounded': new Set(['gemini-2.5-flash', 'gemini-2.5-pro']),
    'openrouter-online': new Set(['openai/gpt-4o-mini', 'openai/gpt-4o']),
    'parallel-chat': new Set(['speed', 'lite', 'base', 'core']),
    'parallel-research': new Set(['pro', 'pro-fast', 'ultra', 'ultra-fast']),
  };

function normalizedConfiguredModel(
  model: string | undefined,
): string | undefined {
  const normalized = model?.trim();
  return normalized || undefined;
}

/**
 * Apply the one model-selection policy shared by catalog resolution and both
 * configuration ingress paths. It deliberately validates only a selected
 * model. Omission and whitespace preserve the declared/provider-owned target.
 */
function validateConfiguredModel(
  profile: ExecutionProfile,
  adapterId: string,
  model: string | undefined,
): void {
  const configured = normalizedConfiguredModel(model);
  if (!configured) return;

  const target = profile.identity.target;
  const slot =
    target.primary.model_selection === 'configurable'
      ? target.primary
      : target.primary.kind !== 'model' &&
          target.underlying?.model_selection === 'provider_managed'
        ? target.underlying
        : undefined;
  if (!slot) {
    throw new TargetSelectionError(
      'config_model_not_configurable',
      'This provider profile does not support selecting a different model.',
    );
  }

  const parsed = OpaqueIdSchema.safeParse(configured);
  if (!parsed.success) {
    throw new TargetSelectionError(
      'config_model_invalid',
      parsed.error.issues[0]?.message ?? 'Invalid model identifier.',
    );
  }

  const allowlist = MODEL_OVERRIDE_ALLOWLISTS[adapterId];
  if (allowlist && !allowlist.has(parsed.data)) {
    throw new TargetSelectionError(
      'config_model_not_allowed',
      `The configured model is not supported by ${adapterId}; choose a reviewed compatible model.`,
    );
  }
}

/**
 * Only exact, plan-priced metering yields a cost estimate.
 *
 * `native_cost`, `native_tokens` and `api_unit_priced` prices are volatile:
 * they depend on tokens, rows, or account tiers that are unknowable before the
 * call. Those estimates are omitted entirely, which makes a hard budget reject
 * the profile up front. Unknown never means zero.
 */
export function networkFreeEstimate(
  metering: ProviderMeteringDescriptor,
): NetworkFreeEstimate | undefined {
  const billableUnits =
    metering.unit !== undefined && metering.defaultUnitsPerRequest !== undefined
      ? [
          {
            unit: metering.unit,
            quantity: String(metering.defaultUnitsPerRequest),
          },
        ]
      : undefined;

  if (metering.kind === 'request_priced') {
    if (metering.defaultPerRequestUsd === undefined) {
      return billableUnits ? { billable_units: billableUnits } : undefined;
    }
    return {
      estimated_cost_microusd: String(
        Math.round(metering.defaultPerRequestUsd * 1_000_000),
      ),
      ...(billableUnits && { billable_units: billableUnits }),
    };
  }

  // Credits are exact in units but their USD value is account-specific, so the
  // units are recorded and the cost stays unknown.
  if (metering.kind === 'credit_priced' && billableUnits) {
    return { billable_units: billableUnits };
  }

  return undefined;
}

interface BindingInput {
  readonly provider_id: string;
  readonly declaration: ExecutableProfileDeclaration;
  readonly adapter_id: string;
  readonly binding_id?: string;
  /** Rewrites the declared profile from validated options, when configurable. */
  readonly project?: (
    profile: ExecutionProfile,
    options: Record<string, unknown>,
  ) => ExecutionProfile;
}

function bindingOptionsSchema(adapterId: string): z.ZodTypeAny {
  const definition = getBuiltinProviderDefinition(adapterId);
  if (!definition) {
    throw new ProfileBindingError(
      `Profile binding references an unknown adapter: ${adapterId}`,
    );
  }
  return definition.optionsSchema;
}

function bindingEstimate(adapterId: string): NetworkFreeEstimate | undefined {
  const definition = getBuiltinProviderDefinition(adapterId);
  if (!definition) {
    throw new ProfileBindingError(
      `Profile binding references an unknown adapter: ${adapterId}`,
    );
  }
  return networkFreeEstimate(definition.metering);
}

/**
 * Project the configured target identifier into a `configurable` primary slot.
 *
 * Only a `configurable` declaration may be overridden: `fixed`,
 * `provider_managed`, and `not_applicable` targets describe what the adapter
 * does regardless of configuration, so they are returned untouched. A blank or
 * whitespace-only value resolves to the declared default, exactly as every
 * adapter's `options.model?.trim() || DEFAULT` does, and a value the contract
 * cannot carry as an identifier is rejected so the profile is reported as
 * misconfigured rather than resolved to something the adapter would not send.
 */
function configuredTargetProjection(
  profile: ExecutionProfile,
  adapterId: string,
  configuredModel: string | undefined,
): ExecutionProfile {
  validateConfiguredModel(profile, adapterId, configuredModel);
  const targetId = normalizedConfiguredModel(configuredModel);
  if (!targetId) return profile;

  const target = profile.identity.target;
  const primary = target.primary;
  if (primary.model_selection === 'configurable') {
    if (targetId === primary.target_id) return profile;
    return {
      ...profile,
      identity: {
        ...profile.identity,
        target: {
          ...target,
          primary: { ...primary, target_id: targetId },
        },
      },
    };
  }

  const underlying = target.underlying;
  if (
    primary.kind === 'model' ||
    underlying?.model_selection !== 'provider_managed'
  ) {
    return profile;
  }

  return {
    ...profile,
    identity: {
      ...profile.identity,
      target: {
        ...target,
        underlying: {
          model_selection: 'configurable',
          kind: 'model',
          target_id: targetId,
        },
      },
    },
  };
}

function bind(input: BindingInput): ProfileBinding {
  const optionsSchema = bindingOptionsSchema(input.adapter_id);
  const estimate = bindingEstimate(input.adapter_id);
  const declared = declaredExecutionProfile(
    input.provider_id,
    input.declaration,
  );
  return Object.freeze({
    provider_id: input.provider_id,
    profile_id: input.declaration.profile_id,
    adapter_id: input.adapter_id,
    binding_id:
      input.binding_id ??
      `${input.provider_id}.${input.declaration.profile_id}.${input.adapter_id}`,
    options_schema: optionsSchema,
    validateModel(model?: string) {
      validateConfiguredModel(declared, input.adapter_id, model);
    },
    resolve(config?: ProfileBindingConfig) {
      const parsed = optionsSchema.safeParse(config?.options ?? {});
      if (!parsed.success) {
        throw new ProfileBindingError(
          parsed.error.issues
            .map(
              (issue) =>
                `${issue.path.join('.') || '(root)'}: ${issue.message}`,
            )
            .join('; '),
        );
      }
      const options = (parsed.data ?? {}) as Record<string, unknown>;
      const projected = input.project
        ? input.project(declared, options)
        : declared;
      // The configured identifier is applied last so an options-driven strategy
      // change (web search off, widened corpora) never discards it.
      const profile = configuredTargetProjection(
        projected,
        input.adapter_id,
        config?.model,
      );
      return { profile, ...(estimate && { estimate }) };
    },
  });
}

/**
 * A chat profile whose web search is switched off is a different executable
 * strategy, not a grounded profile with a flag flipped. It resolves to a
 * distinct `model_answer / none / [] / model_only` profile.
 */
function chatWebSearchProjection(
  profile: ExecutionProfile,
  options: Record<string, unknown>,
): ExecutionProfile {
  if (options.webSearch !== false) return profile;
  const { grounding_policy: _dropped, ...rest } = profile;
  return {
    ...rest,
    result_kind: 'model_answer',
    grounding_policy: 'none',
    corpora: [],
    retrieval_method: 'model_only',
  };
}

/** Firecrawl widens its corpora only when the configuration proves it. */
function firecrawlSourcesProjection(
  profile: ExecutionProfile,
  options: Record<string, unknown>,
): ExecutionProfile {
  const sources = options.sources;
  if (!Array.isArray(sources) || sources.length === 0) return profile;
  const corpora: Corpus[] = [];
  for (const source of sources) {
    if (source === 'web' && !corpora.includes('web')) corpora.push('web');
    if (source === 'news' && !corpora.includes('news')) corpora.push('news');
  }
  return corpora.length > 0 ? { ...profile, corpora } : profile;
}

export interface AdapterProfileBinding {
  readonly adapter_id: string;
  readonly provider_id: string;
  readonly profile_id: string;
}

interface BindingSpec extends AdapterProfileBinding {
  readonly project?: BindingInput['project'];
}

function parallelResearchTargetProjection(
  profile: ExecutionProfile,
  options: Record<string, unknown>,
): ExecutionProfile {
  const processor = options.processor;
  if (typeof processor !== 'string') return profile;
  return {
    ...profile,
    identity: {
      ...profile.identity,
      target: {
        ...profile.identity.target,
        primary: {
          model_selection: 'configurable',
          kind: 'preset',
          target_id: processor,
        },
      },
    },
  };
}

/**
 * Every implemented declaration appears here exactly once. Missing, duplicate,
 * and orphan bindings all fail deterministically at catalog construction.
 */
export const BUILTIN_PROFILE_BINDING_SPECS: readonly BindingSpec[] = [
  {
    provider_id: 'parallel',
    profile_id: 'research',
    adapter_id: 'parallel-research',
    project: parallelResearchTargetProjection,
  },
  { provider_id: 'parallel', profile_id: 'chat', adapter_id: 'parallel-chat' },
  {
    provider_id: 'parallel',
    profile_id: 'search',
    adapter_id: 'parallel-search',
  },
  {
    provider_id: 'perplexity-sonar-deep',
    profile_id: 'research',
    adapter_id: 'perplexity-sonar-deep',
  },
  {
    provider_id: 'perplexity-deep-research',
    profile_id: 'research',
    adapter_id: 'perplexity-deep-research',
  },
  {
    provider_id: 'perplexity-advanced-deep',
    profile_id: 'research',
    adapter_id: 'perplexity-advanced-deep',
  },
  {
    provider_id: 'openai-research',
    profile_id: 'research',
    adapter_id: 'openai-research',
  },
  {
    provider_id: 'gemini-deep',
    profile_id: 'research',
    adapter_id: 'gemini-deep',
  },
  {
    provider_id: 'perplexity-sonar-pro',
    profile_id: 'grounded',
    adapter_id: 'perplexity-sonar-pro',
  },
  {
    provider_id: 'perplexity-pro-search',
    profile_id: 'grounded',
    adapter_id: 'perplexity-pro-search',
  },
  {
    provider_id: 'gemini-grounded',
    profile_id: 'grounded',
    adapter_id: 'gemini-grounded',
  },
  { provider_id: 'grok', profile_id: 'web', adapter_id: 'grok' },
  { provider_id: 'grok-x-only', profile_id: 'x', adapter_id: 'grok-x-only' },
  {
    provider_id: 'grok-combined',
    profile_id: 'combined',
    adapter_id: 'grok-combined',
  },
  {
    provider_id: 'openrouter',
    profile_id: 'grounded',
    adapter_id: 'openrouter-online',
  },
  {
    provider_id: 'brave-answers',
    profile_id: 'grounded',
    adapter_id: 'brave-answers',
  },
  {
    provider_id: 'you-research',
    profile_id: 'grounded',
    adapter_id: 'you-research',
  },
  {
    provider_id: 'you-research',
    profile_id: 'research',
    adapter_id: 'you-research-background',
  },
  {
    provider_id: 'kagi-fastgpt',
    profile_id: 'grounded',
    adapter_id: 'kagi-fastgpt',
  },
  { provider_id: 'exa', profile_id: 'search', adapter_id: 'exa' },
  {
    provider_id: 'exa',
    profile_id: 'research',
    adapter_id: 'exa-research',
  },
  {
    provider_id: 'perplexity-search',
    profile_id: 'search',
    adapter_id: 'perplexity-search',
  },
  {
    provider_id: 'brave-search',
    profile_id: 'search',
    adapter_id: 'brave-search',
  },
  {
    provider_id: 'jina-search',
    profile_id: 'search',
    adapter_id: 'jina-search',
  },
  {
    provider_id: 'firecrawl-search',
    profile_id: 'search',
    adapter_id: 'firecrawl-search',
    project: firecrawlSourcesProjection,
  },
  { provider_id: 'searchapi', profile_id: 'search', adapter_id: 'searchapi' },
  { provider_id: 'serpapi', profile_id: 'search', adapter_id: 'serpapi' },
  { provider_id: 'tavily', profile_id: 'search', adapter_id: 'tavily' },
  {
    provider_id: 'tavily',
    profile_id: 'research',
    adapter_id: 'tavily-research',
  },
  {
    provider_id: 'searchapi-chatgpt',
    profile_id: 'surface',
    adapter_id: 'searchapi-chatgpt',
  },
  {
    provider_id: 'searchapi-gemini',
    profile_id: 'surface',
    adapter_id: 'searchapi-gemini',
  },
  {
    provider_id: 'searchapi-perplexity',
    profile_id: 'surface',
    adapter_id: 'searchapi-perplexity',
  },
  {
    provider_id: 'searchapi-google-ai-mode',
    profile_id: 'surface',
    adapter_id: 'searchapi-google-ai-mode',
  },
  {
    provider_id: 'searchapi-bing-copilot',
    profile_id: 'surface',
    adapter_id: 'searchapi-bing-copilot',
  },
  {
    provider_id: 'searchapi-google-ai-overview',
    profile_id: 'surface',
    adapter_id: 'searchapi-google-ai-overview',
  },
  {
    provider_id: 'claude',
    profile_id: 'chat',
    adapter_id: 'claude',
    project: chatWebSearchProjection,
  },
  {
    provider_id: 'openai-chat',
    profile_id: 'chat',
    adapter_id: 'openai-chat',
    project: chatWebSearchProjection,
  },
  {
    provider_id: 'gemini-chat',
    profile_id: 'chat',
    adapter_id: 'gemini-chat',
    project: chatWebSearchProjection,
  },
  {
    provider_id: 'openrouter',
    profile_id: 'chat',
    adapter_id: 'openrouter-chat',
    project: chatWebSearchProjection,
  },
];

/**
 * Resolve one v1 adapter id to its exact catalog identity.
 *
 * Provider configuration is keyed by adapter id, while the v2 catalog is
 * keyed by provider/profile. Keeping this small validated bridge here avoids
 * callers accidentally treating an alias as a provider id (notably the two
 * distinct OpenRouter strategies).
 */
export function adapterProfileBinding(
  adapterId: string,
  specs: readonly AdapterProfileBinding[] = BUILTIN_PROFILE_BINDING_SPECS,
): AdapterProfileBinding | undefined {
  const matches = specs.filter((spec) => spec.adapter_id === adapterId);
  if (matches.length > 1) {
    throw new ProfileBindingError(
      `Adapter id has more than one exact profile binding: ${adapterId}`,
    );
  }
  const match = matches[0];
  return match
    ? Object.freeze({
        adapter_id: match.adapter_id,
        provider_id: match.provider_id,
        profile_id: match.profile_id,
      })
    : undefined;
}

/** Validate and materialize the complete adapter-id binding matrix. */
export function adapterProfileBindings(
  specs: readonly AdapterProfileBinding[] = BUILTIN_PROFILE_BINDING_SPECS,
): ReadonlyMap<string, AdapterProfileBinding> {
  const bindings = new Map<string, AdapterProfileBinding>();
  for (const spec of specs) {
    if (bindings.has(spec.adapter_id)) {
      throw new ProfileBindingError(
        `Adapter id has more than one exact profile binding: ${spec.adapter_id}`,
      );
    }
    bindings.set(
      spec.adapter_id,
      Object.freeze({
        adapter_id: spec.adapter_id,
        provider_id: spec.provider_id,
        profile_id: spec.profile_id,
      }),
    );
  }
  return bindings;
}

export function buildProfileBindings(
  declarationsByKey: ReadonlyMap<string, ExecutableProfileDeclaration>,
  specs: readonly BindingSpec[] = BUILTIN_PROFILE_BINDING_SPECS,
): Map<string, ProfileBinding> {
  const bindings = new Map<string, ProfileBinding>();
  for (const spec of specs) {
    const key = catalogProfileKey(spec.provider_id, spec.profile_id);
    const declaration = declarationsByKey.get(key);
    if (!declaration) {
      throw new ProfileBindingError(
        `Profile binding has no catalog declaration: ${key}`,
      );
    }
    if (declaration.status !== 'implemented') {
      throw new ProfileBindingError(
        `Planned profile declarations must not be bound: ${key}`,
      );
    }
    if (bindings.has(key)) {
      throw new ProfileBindingError(
        `Profile declaration has more than one binding: ${key}`,
      );
    }
    bindings.set(
      key,
      bind({
        provider_id: spec.provider_id,
        declaration,
        adapter_id: spec.adapter_id,
        ...(spec.project && { project: spec.project }),
      }),
    );
  }
  return bindings;
}
