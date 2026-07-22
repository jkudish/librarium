import { resolveProviderId } from '../constants.js';
import {
  type CredentialContext,
  describeCredentialReference,
} from '../core/credentials.js';
import { getMeteringKind } from '../core/metering.js';
import {
  providerCredentialRef,
  providerHasCredential,
} from '../core/provider-selection.js';
import type { Config, Provider, ProviderMeta, ProviderTier } from '../types.js';
import { BaseProvider } from './base.js';
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
import { OpenAIDeepProvider } from './openai-deep.js';
import { OpenAIDeepO3Provider } from './openai-deep-o3.js';
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

const providers = new Map<string, Provider>();

export type ProviderInitConfig = Partial<
  Pick<
    Config,
    'defaults' | 'providers' | 'customProviders' | 'trustedProviderIds'
  >
> & {
  credentials?: CredentialContext;
};

export interface ProviderInitResult {
  warnings: string[];
  loadedCustomProviders: string[];
  skippedCustomProviders: string[];
}

/**
 * Register a provider in the registry
 */
export function registerProvider(provider: Provider): void {
  provider.source ??= 'builtin';
  provider.requiresApiKey ??= true;
  providers.set(provider.id, provider);
}

/**
 * Get a provider by ID
 */
export function getProvider(id: string): Provider | undefined {
  return providers.get(resolveProviderId(id));
}

/**
 * Get all registered providers
 */
export function getAllProviders(): Provider[] {
  return Array.from(providers.values());
}

/**
 * Get providers by tier
 */
export function getProvidersByTier(tier: ProviderTier): Provider[] {
  return getAllProviders().filter((p) => p.tier === tier);
}

/**
 * Get provider metadata for display (ls command)
 */
export function getProviderMeta(
  config: Record<string, { apiKey?: string; enabled?: boolean }>,
  credentials: CredentialContext = {},
): ProviderMeta[] {
  return getAllProviders().map((p) => {
    const providerConfig = config[p.id];
    const requiresApiKey = p.requiresApiKey ?? true;
    const credentialRef = providerCredentialRef(p, providerConfig);
    const credentialInfo = describeCredentialReference(
      requiresApiKey ? credentialRef : undefined,
    );
    const hasApiKey = requiresApiKey
      ? providerHasCredential(p, providerConfig, credentials)
      : true;
    return {
      id: p.id,
      displayName: p.displayName,
      tier: p.tier,
      envVar: p.envVar,
      source: p.source ?? 'builtin',
      enabled: providerConfig?.enabled ?? false,
      configured: providerConfig !== undefined,
      meteringKind: getMeteringKind(p.id),
      hasApiKey,
      credentialSource: requiresApiKey
        ? hasApiKey
          ? credentialInfo.source
          : 'missing'
        : 'literal',
    };
  });
}

/**
 * Initialize all providers — called at startup.
 * Instantiates and registers all built-in provider adapters.
 */
export async function initializeProviders(
  config: ProviderInitConfig = {},
): Promise<ProviderInitResult> {
  providers.clear();
  const providerConfig = config.providers ?? {};
  const credentials = config.credentials ?? {};
  const llmWebSearch = config.defaults?.llmWebSearch ?? true;

  const builtIns: Provider[] = [
    // Deep Research (async capable)
    new PerplexitySonarDeepProvider(),
    new PerplexityDeepResearchProvider(),
    new PerplexityAdvancedDeepProvider(),
    new OpenAIDeepProvider(),
    new OpenAIDeepO3Provider(),
    new GeminiDeepProvider({ model: providerConfig['gemini-deep']?.model }),

    // AI-Grounded Search (sync)
    new PerplexitySonarProProvider(),
    new GeminiGroundedProvider(),
    new GrokProvider({ model: providerConfig.grok?.model }),
    new OpenRouterOnlineProvider(),
    new BraveAnswersProvider(),
    new ExaProvider(),
    new YouResearchProvider(),
    new KagiFastGPTProvider(),

    // Raw Search (sync)
    new PerplexitySearchProvider(),
    new BraveSearchProvider(),
    new JinaSearchProvider(),
    new FirecrawlSearchProvider(),
    new SearchApiProvider(),
    new SerpApiProvider(),
    new TavilyProvider(),

    // LLM (sync). Providers are opt-in, and web search/citations are on by
    // default unless disabled globally or per-provider via options.webSearch.
    new ClaudeProvider({
      model: providerConfig.claude?.model,
      webSearch: providerWebSearch('claude', providerConfig, llmWebSearch),
    }),
    new OpenAIChatProvider({
      model: providerConfig['openai-chat']?.model,
      webSearch: providerWebSearch('openai-chat', providerConfig, llmWebSearch),
    }),
    new GeminiChatProvider({
      model: providerConfig['gemini-chat']?.model,
      webSearch: providerWebSearch('gemini-chat', providerConfig, llmWebSearch),
    }),
    new OpenRouterChatProvider({
      model: providerConfig['openrouter-chat']?.model,
      webSearch: providerWebSearch(
        'openrouter-chat',
        providerConfig,
        llmWebSearch,
      ),
    }),
  ];

  for (const provider of builtIns) {
    if (provider instanceof BaseProvider) {
      provider.configure({
        apiKey: providerConfig[provider.id]?.apiKey,
        credentials,
      });
    }
    provider.source = 'builtin';
    provider.requiresApiKey = true;
    registerProvider(provider);
  }

  return {
    warnings: [],
    loadedCustomProviders: [],
    skippedCustomProviders: [],
  };
}

function providerWebSearch(
  id: string,
  providers: NonNullable<Config['providers']>,
  fallback: boolean,
): boolean {
  const configured = providers[id]?.options?.webSearch;
  return typeof configured === 'boolean' ? configured : fallback;
}
