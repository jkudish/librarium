import {
  BUILTIN_PROVIDER_DEFINITIONS,
  BUILTIN_PROVIDER_DEFINITIONS_IN_REGISTRATION_ORDER,
  getBuiltinProviderDefinition,
  type ProviderDescriptorDefinition,
} from '../core/provider-descriptor.js';
import type { Config, Provider, ProviderConfig } from '../types.js';
import { BraveAnswersProvider } from './brave-answers.js';
import { BraveSearchProvider } from './brave-search.js';
import { ClaudeProvider } from './claude.js';
import { ExaProvider } from './exa.js';
import { FirecrawlSearchProvider } from './firecrawl-search.js';
import { GeminiChatProvider } from './gemini-chat.js';
import { GeminiDeepProvider } from './gemini-deep.js';
import { GeminiGroundedProvider } from './gemini-grounded.js';
import { GrokProvider } from './grok.js';
import { JinaSearchProvider } from './jina-search.js';
import { KagiFastGPTProvider } from './kagi-fastgpt.js';
import { OpenAIChatProvider } from './openai-chat.js';
import { OpenAIResearchProvider } from './openai-research.js';
import { OpenRouterChatProvider } from './openrouter-chat.js';
import { OpenRouterOnlineProvider } from './openrouter-online.js';
import { PerplexityAdvancedDeepProvider } from './perplexity-advanced-deep.js';
import { PerplexityDeepResearchProvider } from './perplexity-deep-research.js';
import { PerplexitySearchProvider } from './perplexity-search.js';
import { PerplexitySonarDeepProvider } from './perplexity-sonar-deep.js';
import { PerplexitySonarProProvider } from './perplexity-sonar-pro.js';
import { SearchApiProvider } from './searchapi.js';
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
    context.providerConfig?.model ??
    getBuiltinProviderDefinition(id)?.defaultModel
  );
}

function webSearch(context: BuiltInProviderFactoryContext): boolean {
  const configured = option(context.providerConfig, 'webSearch');
  return typeof configured === 'boolean'
    ? configured
    : (context.defaults?.llmWebSearch ?? true);
}

const factories: Record<string, ProviderFactory> = {
  'perplexity-sonar-deep': () => new PerplexitySonarDeepProvider(),
  'perplexity-deep-research': () => new PerplexityDeepResearchProvider(),
  'perplexity-advanced-deep': () => new PerplexityAdvancedDeepProvider(),
  'openai-research': ({ providerConfig }) =>
    new OpenAIResearchProvider({
      model:
        providerConfig?.model ??
        getBuiltinProviderDefinition('openai-research')?.defaultModel,
      maxToolCalls: option(providerConfig, 'maxToolCalls'),
      reasoningEffort: option(providerConfig, 'reasoningEffort'),
      returnTokenBudget: option(providerConfig, 'returnTokenBudget'),
    }),
  'gemini-deep': (context) =>
    new GeminiDeepProvider({ model: model('gemini-deep', context) }),
  'perplexity-sonar-pro': () => new PerplexitySonarProProvider(),
  'gemini-grounded': () => new GeminiGroundedProvider(),
  grok: (context) => new GrokProvider({ model: model('grok', context) }),
  'openrouter-online': () => new OpenRouterOnlineProvider(),
  'brave-answers': () => new BraveAnswersProvider(),
  exa: () => new ExaProvider(),
  'you-research': () => new YouResearchProvider(),
  'kagi-fastgpt': () => new KagiFastGPTProvider(),
  'perplexity-search': () => new PerplexitySearchProvider(),
  'brave-search': () => new BraveSearchProvider(),
  'jina-search': () => new JinaSearchProvider(),
  'firecrawl-search': () => new FirecrawlSearchProvider(),
  searchapi: () => new SearchApiProvider(),
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
