import {
  BUILTIN_PROVIDER_DEFINITIONS,
  BUILTIN_PROVIDER_DEFINITIONS_IN_REGISTRATION_ORDER,
  getBuiltinProviderDefinition,
  type ProviderDescriptorDefinition,
} from '../core/provider-descriptor.js';
import { searchApiOptionsSchema } from '../core/searchapi.js';
import type { Config, Provider, ProviderConfig } from '../types.js';
import { BraveAnswersProvider } from './brave-answers.js';
import { BraveSearchProvider } from './brave-search.js';
import { ClaudeProvider } from './claude.js';
import { ExaProvider } from './exa.js';
import { FirecrawlSearchProvider } from './firecrawl-search.js';
import { GeminiChatProvider } from './gemini-chat.js';
import { GeminiDeepProvider } from './gemini-deep.js';
import { GeminiGroundedProvider } from './gemini-grounded.js';
import {
  GrokCombinedProvider,
  GrokProvider,
  GrokXOnlyProvider,
} from './grok.js';
import { JinaSearchProvider } from './jina-search.js';
import { KagiFastGPTProvider } from './kagi-fastgpt.js';
import { OpenAIChatProvider } from './openai-chat.js';
import { OpenAIResearchProvider } from './openai-research.js';
import type {
  OpenRouterDataCollection,
  OpenRouterProviderOptions,
  OpenRouterReasoningEffort,
} from './openrouter.js';
import { OpenRouterChatProvider } from './openrouter-chat.js';
import { OpenRouterOnlineProvider } from './openrouter-online.js';
import { PerplexityAdvancedDeepProvider } from './perplexity-advanced-deep.js';
import { PerplexityDeepResearchProvider } from './perplexity-deep-research.js';
import { PerplexityProSearchProvider } from './perplexity-pro-search.js';
import {
  PerplexitySearchProvider,
  type PerplexitySearchProviderOptions,
} from './perplexity-search.js';
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
import { YouResearchProvider } from './you-research.js';

export interface BuiltInProviderFactoryContext {
  providerConfig?: ProviderConfig;
  defaults?: Config['defaults'];
}

export interface BuiltInProviderDescriptor
  extends ProviderDescriptorDefinition {
  factory(context: BuiltInProviderFactoryContext): Provider;
}

type ProviderFactory = BuiltInProviderDescriptor['factory'];

function option(config: ProviderConfig | undefined, key: string): unknown {
  return config?.options?.[key];
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

function webSearch(context: BuiltInProviderFactoryContext): boolean {
  const configured = option(context.providerConfig, 'webSearch');
  return typeof configured === 'boolean'
    ? configured
    : (context.defaults?.llmWebSearch ?? true);
}

function openRouterOptions(
  context: BuiltInProviderFactoryContext,
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
  const options = context.providerConfig?.options ?? {};
  return {
    ...(Array.isArray(options.providerOrder) && {
      providerOrder: options.providerOrder as string[],
    }),
    ...(typeof options.allowFallbacks === 'boolean' && {
      allowFallbacks: options.allowFallbacks,
    }),
    ...(typeof options.requireParameters === 'boolean' && {
      requireParameters: options.requireParameters,
    }),
    ...(options.dataCollection === 'allow' || options.dataCollection === 'deny'
      ? { dataCollection: options.dataCollection as OpenRouterDataCollection }
      : {}),
    ...(typeof options.zdr === 'boolean' && { zdr: options.zdr }),
    ...(typeof options.reasoningEffort === 'string' && {
      reasoningEffort: options.reasoningEffort as OpenRouterReasoningEffort,
    }),
    ...(typeof options.reasoningMaxTokens === 'number' && {
      reasoningMaxTokens: options.reasoningMaxTokens,
    }),
    ...(typeof options.reasoningExclude === 'boolean' && {
      reasoningExclude: options.reasoningExclude,
    }),
  };
}

function searchApiZeroRetention(
  providerConfig: ProviderConfig | undefined,
): boolean {
  return searchApiOptionsSchema.parse(providerConfig?.options ?? {})
    .zeroRetention;
}

function perplexitySearchOptions(
  providerConfig: ProviderConfig | undefined,
): PerplexitySearchProviderOptions {
  const configured = providerConfig?.options ?? {};
  const options: PerplexitySearchProviderOptions = {};
  const documentedKeys = [
    'perRequestUsd',
    'maxResults',
    'country',
    'searchLanguageFilter',
    'searchDomainAllowlist',
    'searchDomainDenylist',
    'searchContextSize',
    'maxTokens',
    'maxTokensPerPage',
    'additionalQueries',
  ] as const;

  for (const key of documentedKeys) {
    if (configured[key] !== undefined) {
      options[key] = configured[key];
    }
  }
  return options;
}

const factories: Record<string, ProviderFactory> = {
  'perplexity-sonar-deep': () => new PerplexitySonarDeepProvider(),
  'perplexity-deep-research': (context) =>
    new PerplexityDeepResearchProvider({ model: configuredModel(context) }),
  'perplexity-advanced-deep': (context) =>
    new PerplexityAdvancedDeepProvider({ model: configuredModel(context) }),
  'openai-research': ({ providerConfig }) =>
    new OpenAIResearchProvider({
      model:
        configuredModel({ providerConfig }) ??
        getBuiltinProviderDefinition('openai-research')?.defaultModel,
      maxToolCalls: option(providerConfig, 'maxToolCalls'),
      reasoningEffort: option(providerConfig, 'reasoningEffort'),
      returnTokenBudget: option(providerConfig, 'returnTokenBudget'),
    }),
  'gemini-deep': (context) =>
    new GeminiDeepProvider({ model: model('gemini-deep', context) }),
  'perplexity-sonar-pro': () => new PerplexitySonarProProvider(),
  'gemini-grounded': (context) =>
    new GeminiGroundedProvider({ model: model('gemini-grounded', context) }),
  grok: (context) =>
    new GrokProvider({
      model: model('grok', context),
      searchOptions: context.providerConfig?.options,
    }),
  'grok-x-only': (context) =>
    new GrokXOnlyProvider({
      model: model('grok-x-only', context),
      searchOptions: context.providerConfig?.options,
    }),
  'grok-combined': (context) =>
    new GrokCombinedProvider({
      model: model('grok-combined', context),
      searchOptions: context.providerConfig?.options,
    }),
  'openrouter-online': (context) =>
    new OpenRouterOnlineProvider({
      model: model('openrouter-online', context),
      ...openRouterOptions(context),
    }),
  'brave-answers': () => new BraveAnswersProvider(),
  exa: () => new ExaProvider(),
  'you-research': () => new YouResearchProvider(),
  'kagi-fastgpt': () => new KagiFastGPTProvider(),
  'perplexity-search': ({ providerConfig }) =>
    new PerplexitySearchProvider(perplexitySearchOptions(providerConfig)),
  'brave-search': () => new BraveSearchProvider(),
  'jina-search': () => new JinaSearchProvider(),
  'firecrawl-search': ({ providerConfig }) =>
    new FirecrawlSearchProvider({
      sources: option(providerConfig, 'sources'),
      limit: option(providerConfig, 'limit'),
      tbs: option(providerConfig, 'tbs'),
      country: option(providerConfig, 'country'),
      location: option(providerConfig, 'location'),
      includeDomains: option(providerConfig, 'includeDomains'),
      excludeDomains: option(providerConfig, 'excludeDomains'),
      categories: option(providerConfig, 'categories'),
      ignoreInvalidURLs: option(providerConfig, 'ignoreInvalidURLs'),
    }),
  searchapi: ({ providerConfig }) =>
    new SearchApiProvider({
      zeroRetention: searchApiZeroRetention(providerConfig),
    }),
  'searchapi-chatgpt': ({ providerConfig }) =>
    new SearchApiChatGptProvider({
      zeroRetention: searchApiZeroRetention(providerConfig),
    }),
  'searchapi-gemini': ({ providerConfig }) =>
    new SearchApiGeminiProvider({
      zeroRetention: searchApiZeroRetention(providerConfig),
    }),
  'searchapi-perplexity': ({ providerConfig }) =>
    new SearchApiPerplexityProvider({
      zeroRetention: searchApiZeroRetention(providerConfig),
    }),
  'searchapi-google-ai-mode': ({ providerConfig }) =>
    new SearchApiGoogleAiModeProvider({
      zeroRetention: searchApiZeroRetention(providerConfig),
    }),
  'searchapi-bing-copilot': ({ providerConfig }) =>
    new SearchApiBingCopilotProvider({
      zeroRetention: searchApiZeroRetention(providerConfig),
    }),
  'searchapi-google-ai-overview': ({ providerConfig }) =>
    new SearchApiGoogleAiOverviewProvider({
      zeroRetention: searchApiZeroRetention(providerConfig),
    }),
  'perplexity-pro-search': () => new PerplexityProSearchProvider(),
  serpapi: () => new SerpApiProvider(),
  tavily: () => new TavilyProvider(),
  claude: (context) =>
    new ClaudeProvider({
      model: model('claude', context),
      webSearch: webSearch(context),
      maxTokens: option(context.providerConfig, 'maxTokens'),
      thinking: option(context.providerConfig, 'thinking'),
      effort: option(context.providerConfig, 'effort'),
    }),
  'openai-chat': (context) =>
    new OpenAIChatProvider({
      model: model('openai-chat', context),
      webSearch: webSearch(context),
    }),
  'gemini-chat': (context) =>
    new GeminiChatProvider({
      model: model('gemini-chat', context),
      webSearch: webSearch(context),
    }),
  'openrouter-chat': (context) =>
    new OpenRouterChatProvider({
      model: model('openrouter-chat', context),
      webSearch: webSearch(context),
      ...openRouterOptions(context),
    }),
};

export const BUILTIN_PROVIDER_DESCRIPTORS: readonly BuiltInProviderDescriptor[] =
  BUILTIN_PROVIDER_DEFINITIONS_IN_REGISTRATION_ORDER.map((definition) => {
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
