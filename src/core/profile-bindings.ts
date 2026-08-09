import type { z } from 'zod';
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
 * One implemented declaration binds to exactly one adapter strategy. The
 * binding turns a validated configuration into the single exact execution
 * profile that will run, plus a network-free estimate when -- and only when --
 * the price is exact and non-volatile.
 */
export interface ProfileBinding {
  readonly provider_id: string;
  readonly profile_id: string;
  readonly adapter_id: string;
  readonly binding_id: string;
  readonly options_schema: z.ZodTypeAny;
  resolve(config: unknown): {
    readonly profile: ExecutionProfile;
    readonly estimate?: NetworkFreeEstimate;
  };
}

export class ProfileBindingError extends Error {}

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

function bind(input: BindingInput): ProfileBinding {
  const optionsSchema = bindingOptionsSchema(input.adapter_id);
  const estimate = bindingEstimate(input.adapter_id);
  const declared = declaredExecutionProfile(
    input.provider_id,
    input.declaration,
  );
  return {
    provider_id: input.provider_id,
    profile_id: input.declaration.profile_id,
    adapter_id: input.adapter_id,
    binding_id:
      input.binding_id ??
      `${input.provider_id}.${input.declaration.profile_id}.${input.adapter_id}`,
    options_schema: optionsSchema,
    resolve(config: unknown) {
      const parsed = optionsSchema.safeParse(config ?? {});
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
      const profile = input.project
        ? input.project(declared, options)
        : declared;
      return { profile, ...(estimate && { estimate }) };
    },
  };
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

interface BindingSpec {
  readonly provider_id: string;
  readonly profile_id: string;
  readonly adapter_id: string;
  readonly project?: BindingInput['project'];
}

/**
 * Every implemented declaration appears here exactly once. Missing, duplicate,
 * and orphan bindings all fail deterministically at catalog construction.
 */
export const BUILTIN_PROFILE_BINDING_SPECS: readonly BindingSpec[] = [
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
    provider_id: 'kagi-fastgpt',
    profile_id: 'grounded',
    adapter_id: 'kagi-fastgpt',
  },
  { provider_id: 'exa', profile_id: 'search', adapter_id: 'exa' },
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
