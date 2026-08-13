import type { z } from 'zod';
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  BUILTIN_PROVIDER_DEFINITIONS_IN_REGISTRATION_ORDER,
  claudeOptions,
  exaResearchOptions,
  firecrawlSearchOptions,
  getBuiltinProviderDefinition,
  openAiResearchOptions,
  openRouterGroundedOptions,
  openRouterOptions as openRouterOptionsSchema,
  type ProviderDescriptorDefinition,
  parallelChatOptions,
  parallelResearchOptions,
  parallelSearchOptions,
  tavilyResearchOptions,
  webSearchOptions,
  youResearchBackgroundOptions,
} from '../core/provider-descriptor.js';
import {
  type SearchApiOptions,
  searchApiOptionsSchema,
} from '../core/searchapi.js';
import type { Config, Provider, ProviderConfig } from '../types.js';
import { BraveAnswersProvider } from './brave-answers.js';
import { BraveSearchProvider } from './brave-search.js';
import { ClaudeProvider } from './claude.js';
import { ExaProvider } from './exa.js';
import { ExaResearchProvider } from './exa-research.js';
import { FirecrawlSearchProvider } from './firecrawl-search.js';
import { GeminiChatProvider } from './gemini-chat.js';
import { GeminiDeepProvider } from './gemini-deep.js';
import { GeminiGroundedProvider } from './gemini-grounded.js';
import {
  GrokCombinedProvider,
  GrokProvider,
  GrokXOnlyProvider,
} from './grok.js';
import {
  grokCombinedOptionsSchema,
  grokWebOptionsSchema,
  grokXOnlyOptionsSchema,
} from './grok-options.js';
import { JinaSearchProvider } from './jina-search.js';
import { KagiFastGPTProvider } from './kagi-fastgpt.js';
import { OpenAIChatProvider } from './openai-chat.js';
import { OpenAIResearchProvider } from './openai-research.js';
import type { OpenRouterProviderOptions } from './openrouter.js';
import { OpenRouterChatProvider } from './openrouter-chat.js';
import { OpenRouterOnlineProvider } from './openrouter-online.js';
import {
  ParallelChatProvider,
  ParallelResearchProvider,
  ParallelSearchProvider,
} from './parallel.js';
import { PerplexityAdvancedDeepProvider } from './perplexity-advanced-deep.js';
import { PerplexityDeepResearchProvider } from './perplexity-deep-research.js';
import { PerplexityProSearchProvider } from './perplexity-pro-search.js';
import { PerplexitySearchProvider } from './perplexity-search.js';
import {
  type PerplexitySearchOptions,
  PerplexitySearchOptionsSchema,
} from './perplexity-search-options.js';
import { PerplexitySonarDeepProvider } from './perplexity-sonar-deep.js';
import { PerplexitySonarProProvider } from './perplexity-sonar-pro.js';
import { SearchApiProvider } from './searchapi.js';
import { SearchApiBingCopilotProvider } from './searchapi-bing-copilot.js';
import { SearchApiChatGptProvider } from './searchapi-chatgpt.js';
import { SearchApiGeminiProvider } from './searchapi-gemini.js';
import { SearchApiGoogleAiModeProvider } from './searchapi-google-ai-mode.js';
import { SearchApiGoogleAiOverviewProvider } from './searchapi-google-ai-overview.js';
import { SearchApiPerplexityProvider } from './searchapi-perplexity.js';
import { SerpApiProvider } from './serpapi.js';
import { TavilyProvider } from './tavily.js';
import { TavilyResearchProvider } from './tavily-research.js';
import type {
  ValyuResearchOptions,
  ValyuSearchOptions,
} from './valyu-options.js';
import {
  ValyuResearchOptionsSchema,
  ValyuSearchOptionsSchema,
} from './valyu-options.js';
import { ValyuResearchProvider } from './valyu-research.js';
import { ValyuSearchProvider } from './valyu-search.js';
import { YouAnswerProvider } from './you-answer.js';
import {
  type YouAnswerOptions,
  YouAnswerOptionsSchema,
} from './you-answer-options.js';
import { YouResearchProvider } from './you-research.js';
import { YouResearchBackgroundProvider } from './you-research-background.js';

export interface BuiltInProviderFactoryContext {
  providerConfig?: Omit<ProviderConfig, 'options'>;
  /** Descriptor-validated options. This private boundary never receives raw config. */
  options?: unknown;
  defaults?: Config['defaults'];
}

export interface BuiltInProviderDescriptor
  extends ProviderDescriptorDefinition {
  factory(context: BuiltInProviderFactoryContext): Provider;
}

type ProviderFactory = BuiltInProviderDescriptor['factory'];

type TypedFactoryContext<T extends z.ZodType> = Omit<
  BuiltInProviderFactoryContext,
  'options'
> & {
  readonly options: z.output<T>;
};

/** Keep descriptor validation authoritative while preserving its inferred output. */
function typedFactory<T extends z.ZodType>(
  schema: T,
  factory: (context: TypedFactoryContext<T>) => Provider,
): ProviderFactory {
  return (context) =>
    factory({ ...context, options: schema.parse(context.options ?? {}) });
}

function model(
  id: string,
  context: BuiltInProviderFactoryContext,
): string | undefined {
  return (
    configuredModel(context) ?? getBuiltinProviderDefinition(id)?.defaultModel
  );
}

/** Blank legacy values mean no override, matching binding resolution. */
function configuredModel(
  context: BuiltInProviderFactoryContext,
): string | undefined {
  return context.providerConfig?.model?.trim() || undefined;
}

function webSearch(
  context: TypedFactoryContext<typeof webSearchOptions>,
): boolean {
  return context.options.webSearch ?? context.defaults?.llmWebSearch ?? true;
}

function openRouterOptions(
  context: TypedFactoryContext<
    typeof openRouterOptionsSchema | typeof openRouterGroundedOptions
  >,
): Pick<
  OpenRouterProviderOptions,
  | 'providerOrder'
  | 'allowFallbacks'
  | 'requireParameters'
  | 'dataCollection'
  | 'zdr'
  | 'reasoningEffort'
  | 'reasoningMaxTokens'
  | 'reasoningExclude'
> {
  const options = context.options;
  return {
    ...(options.providerOrder !== undefined && {
      providerOrder: options.providerOrder,
    }),
    ...(options.allowFallbacks !== undefined && {
      allowFallbacks: options.allowFallbacks,
    }),
    ...(options.requireParameters !== undefined && {
      requireParameters: options.requireParameters,
    }),
    ...(options.dataCollection !== undefined && {
      dataCollection: options.dataCollection,
    }),
    ...(options.zdr !== undefined && { zdr: options.zdr }),
    ...(options.reasoningEffort !== undefined && {
      reasoningEffort: options.reasoningEffort,
    }),
    ...(options.reasoningMaxTokens !== undefined && {
      reasoningMaxTokens: options.reasoningMaxTokens,
    }),
    ...(options.reasoningExclude !== undefined && {
      reasoningExclude: options.reasoningExclude,
    }),
  };
}

function searchApiZeroRetention(options: SearchApiOptions): boolean {
  return options.zeroRetention;
}

/** Descriptor metering values are local metadata, not Parallel API options. */
function parallelOptions<
  T extends z.output<
    | typeof parallelSearchOptions
    | typeof parallelChatOptions
    | typeof parallelResearchOptions
  >,
>(
  options: T,
): Omit<T, 'perRequestUsd' | 'creditUsd' | 'creditsPerRequest' | 'perUnitUsd'> {
  const {
    perRequestUsd: _perRequestUsd,
    creditUsd: _creditUsd,
    creditsPerRequest: _creditsPerRequest,
    perUnitUsd: _perUnitUsd,
    ...adapterOptions
  } = options;
  return adapterOptions;
}

const factories: Record<string, ProviderFactory> = {
  'parallel-research': typedFactory(
    parallelResearchOptions,
    (context) =>
      new ParallelResearchProvider({
        model:
          configuredModel(context) ?? context.options.processor ?? undefined,
        configuredOptions: parallelOptions(context.options),
      }),
  ),
  'parallel-chat': typedFactory(
    parallelChatOptions,
    (context) =>
      new ParallelChatProvider({
        model: configuredModel(context),
        configuredOptions: parallelOptions(context.options),
      }),
  ),
  'parallel-search': typedFactory(
    parallelSearchOptions,
    (context) => new ParallelSearchProvider(parallelOptions(context.options)),
  ),
  'perplexity-sonar-deep': () => new PerplexitySonarDeepProvider(),
  'perplexity-deep-research': (context) =>
    new PerplexityDeepResearchProvider({ model: configuredModel(context) }),
  'perplexity-advanced-deep': (context) =>
    new PerplexityAdvancedDeepProvider({ model: configuredModel(context) }),
  'openai-research': typedFactory(
    openAiResearchOptions,
    (context) =>
      new OpenAIResearchProvider({
        model:
          configuredModel(context) ??
          getBuiltinProviderDefinition('openai-research')?.defaultModel,
        maxToolCalls: context.options.maxToolCalls,
        reasoningEffort: context.options.reasoningEffort,
        returnTokenBudget: context.options.returnTokenBudget,
      }),
  ),
  'gemini-deep': (context) =>
    new GeminiDeepProvider({ model: model('gemini-deep', context) }),
  'perplexity-sonar-pro': () => new PerplexitySonarProProvider(),
  'gemini-grounded': (context) =>
    new GeminiGroundedProvider({ model: model('gemini-grounded', context) }),
  grok: typedFactory(
    grokWebOptionsSchema,
    (context) =>
      new GrokProvider({
        model: model('grok', context),
        searchOptions: context.options,
      }),
  ),
  'grok-x-only': typedFactory(
    grokXOnlyOptionsSchema,
    (context) =>
      new GrokXOnlyProvider({
        model: model('grok-x-only', context),
        searchOptions: context.options,
      }),
  ),
  'grok-combined': typedFactory(
    grokCombinedOptionsSchema,
    (context) =>
      new GrokCombinedProvider({
        model: model('grok-combined', context),
        searchOptions: context.options,
      }),
  ),
  'openrouter-online': typedFactory(
    openRouterGroundedOptions,
    (context) =>
      new OpenRouterOnlineProvider({
        model: model('openrouter-online', context),
        ...openRouterOptions(context),
      }),
  ),
  'brave-answers': () => new BraveAnswersProvider(),
  exa: () => new ExaProvider(),
  'exa-research': typedFactory(
    exaResearchOptions,
    (context) =>
      new ExaResearchProvider({
        effort: context.options.effort,
        systemPrompt: context.options.systemPrompt,
        outputSchema: context.options.outputSchema,
        maxCostDollars: context.options.maxCostDollars,
      }),
  ),
  'you-research': () => new YouResearchProvider(),
  'you-answer': typedFactory(
    YouAnswerOptionsSchema,
    (context) =>
      new YouAnswerProvider(context.options satisfies YouAnswerOptions),
  ),
  'you-research-background': typedFactory(
    youResearchBackgroundOptions,
    (context) =>
      new YouResearchBackgroundProvider({
        researchEffort: context.options.researchEffort,
        outputSchema: context.options.outputSchema,
        includeDomains: context.options.includeDomains,
        excludeDomains: context.options.excludeDomains,
        boostDomains: context.options.boostDomains,
        freshness: context.options.freshness,
        country: context.options.country,
      }),
  ),
  'kagi-fastgpt': () => new KagiFastGPTProvider(),
  'perplexity-search': typedFactory(
    PerplexitySearchOptionsSchema,
    (context) =>
      new PerplexitySearchProvider(
        context.options satisfies PerplexitySearchOptions,
      ),
  ),
  'brave-search': () => new BraveSearchProvider(),
  'jina-search': () => new JinaSearchProvider(),
  'firecrawl-search': typedFactory(
    firecrawlSearchOptions,
    (context) =>
      new FirecrawlSearchProvider({
        sources: context.options.sources,
        limit: context.options.limit,
        tbs: context.options.tbs,
        country: context.options.country,
        location: context.options.location,
        includeDomains: context.options.includeDomains,
        excludeDomains: context.options.excludeDomains,
        categories: context.options.categories,
        ignoreInvalidURLs: context.options.ignoreInvalidURLs,
      }),
  ),
  searchapi: typedFactory(
    searchApiOptionsSchema,
    (context) =>
      new SearchApiProvider({
        zeroRetention: searchApiZeroRetention(context.options),
      }),
  ),
  'searchapi-chatgpt': typedFactory(
    searchApiOptionsSchema,
    (context) =>
      new SearchApiChatGptProvider({
        zeroRetention: searchApiZeroRetention(context.options),
      }),
  ),
  'searchapi-gemini': typedFactory(
    searchApiOptionsSchema,
    (context) =>
      new SearchApiGeminiProvider({
        zeroRetention: searchApiZeroRetention(context.options),
      }),
  ),
  'searchapi-perplexity': typedFactory(
    searchApiOptionsSchema,
    (context) =>
      new SearchApiPerplexityProvider({
        zeroRetention: searchApiZeroRetention(context.options),
      }),
  ),
  'searchapi-google-ai-mode': typedFactory(
    searchApiOptionsSchema,
    (context) =>
      new SearchApiGoogleAiModeProvider({
        zeroRetention: searchApiZeroRetention(context.options),
      }),
  ),
  'searchapi-bing-copilot': typedFactory(
    searchApiOptionsSchema,
    (context) =>
      new SearchApiBingCopilotProvider({
        zeroRetention: searchApiZeroRetention(context.options),
      }),
  ),
  'searchapi-google-ai-overview': typedFactory(
    searchApiOptionsSchema,
    (context) =>
      new SearchApiGoogleAiOverviewProvider({
        zeroRetention: searchApiZeroRetention(context.options),
      }),
  ),
  'perplexity-pro-search': () => new PerplexityProSearchProvider(),
  serpapi: () => new SerpApiProvider(),
  tavily: () => new TavilyProvider(),
  'tavily-research': typedFactory(
    tavilyResearchOptions,
    (context) =>
      new TavilyResearchProvider({
        model: context.options.researchModel,
        outputSchema: context.options.outputSchema,
        citationFormat: context.options.citationFormat,
      }),
  ),
  'valyu-search': typedFactory(
    ValyuSearchOptionsSchema,
    (context) =>
      new ValyuSearchProvider(context.options satisfies ValyuSearchOptions),
  ),
  'valyu-research': typedFactory(
    ValyuResearchOptionsSchema,
    (context) =>
      new ValyuResearchProvider(context.options satisfies ValyuResearchOptions),
  ),
  claude: typedFactory(
    claudeOptions,
    (context) =>
      new ClaudeProvider({
        model: model('claude', context),
        webSearch: webSearch(context),
        maxTokens: context.options.maxTokens,
        thinking: context.options.thinking,
        effort: context.options.effort,
      }),
  ),
  'openai-chat': typedFactory(
    webSearchOptions,
    (context) =>
      new OpenAIChatProvider({
        model: model('openai-chat', context),
        webSearch: webSearch(context),
      }),
  ),
  'gemini-chat': typedFactory(
    webSearchOptions,
    (context) =>
      new GeminiChatProvider({
        model: model('gemini-chat', context),
        webSearch: webSearch(context),
      }),
  ),
  'openrouter-chat': typedFactory(
    openRouterOptionsSchema,
    (context) =>
      new OpenRouterChatProvider({
        model: model('openrouter-chat', context),
        webSearch: webSearch(context),
        ...openRouterOptions(context),
      }),
  ),
};

export const BUILTIN_PROVIDER_DESCRIPTORS: readonly BuiltInProviderDescriptor[] =
  BUILTIN_PROVIDER_DEFINITIONS_IN_REGISTRATION_ORDER.filter(
    (definition) => definition.internal !== true,
  ).map((definition) => {
    const factory = factories[definition.id];
    if (!factory) {
      throw new Error(`Missing built-in provider factory: ${definition.id}`);
    }
    return { ...definition, factory };
  });

const descriptorIds = new Set(BUILTIN_PROVIDER_DEFINITIONS.map(({ id }) => id));
for (const id of Object.keys(factories)) {
  if (!descriptorIds.has(id)) {
    throw new Error(`Provider factory has no descriptor: ${id}`);
  }
}

export function getBuiltInProviderDescriptor(
  id: string,
): BuiltInProviderDescriptor | undefined {
  return BUILTIN_PROVIDER_DESCRIPTORS.find(
    (descriptor) => descriptor.id === id,
  );
}

/** Private internal background strategies for canonical exact bindings. */
export function getInternalBuiltInProviderDescriptor(
  id: string,
): BuiltInProviderDescriptor | undefined {
  const definition = getBuiltinProviderDefinition(id);
  if (!definition?.internal) return undefined;
  return { ...definition, factory: factories[id] };
}
