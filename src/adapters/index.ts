import { resolveProviderId } from '../constants.js';
import {
  type CredentialContext,
  describeCredentialReference,
} from '../core/credentials.js';
import type { HttpClient } from '../core/http-client.js';
import { getMeteringKind } from '../core/metering.js';
import {
  providerCredentialRef,
  providerHasCredential,
} from '../core/provider-selection.js';
import type { Config, Provider, ProviderMeta, ProviderTier } from '../types.js';
import { ProviderBase } from './base.js';
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

const providers = new Map<string, Provider>();

export type ProviderInitConfig = Partial<
  Pick<
    Config,
    'defaults' | 'providers' | 'customProviders' | 'trustedProviderIds'
  >
> & {
  credentials?: CredentialContext;
  httpClient?: HttpClient;
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
  assertProviderExecutionContract(provider);
  provider.source ??= 'builtin';
  provider.requiresApiKey ??= true;
  providers.set(provider.id, provider);
}

function assertProviderExecutionContract(provider: Provider): void {
  const candidate = provider as Provider & {
    execution?: unknown;
    execute?: unknown;
    submit?: unknown;
    poll?: unknown;
    retrieve?: unknown;
  };
  if (
    candidate.execution !== 'inline' &&
    candidate.execution !== 'background'
  ) {
    throw new TypeError(
      `Provider "${provider.id}" must declare execution as "inline" or "background"`,
    );
  }
  if (typeof candidate.execute !== 'function') {
    throw new TypeError(`Provider "${provider.id}" must define execute`);
  }
  const lifecycle = [candidate.submit, candidate.poll, candidate.retrieve];
  if (
    candidate.execution === 'background' &&
    lifecycle.some((method) => typeof method !== 'function')
  ) {
    throw new TypeError(
      `Background provider "${provider.id}" must define submit, poll, and retrieve`,
    );
  }
  if (
    candidate.execution === 'inline' &&
    lifecycle.some((method) => method !== undefined)
  ) {
    throw new TypeError(
      `Inline provider "${provider.id}" cannot define submit, poll, or retrieve`,
    );
  }
}

/**
 * Get a provider by ID
 */
export function getProvider(id: string): Provider | undefined {
  return providers.get(resolveProviderId(id));
}

/**
 * Look up only a canonical registered id. Async task files use this stricter
 * path so retired provider handles are never reinterpreted as a new provider's
 * remote task identifier after an upgrade.
 */
export function getExactProvider(id: string): Provider | undefined {
  return providers.get(id);
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
  const httpClient = config.httpClient;
  const llmWebSearch = config.defaults?.llmWebSearch ?? true;

  const builtIns: Provider[] = [
    // Deep Research (async capable)
    new PerplexitySonarDeepProvider(),
    new PerplexityDeepResearchProvider(),
    new PerplexityAdvancedDeepProvider(),
    new OpenAIResearchProvider({
      model: providerConfig['openai-research']?.model,
      maxToolCalls: providerConfig['openai-research']?.options?.maxToolCalls,
      reasoningEffort:
        providerConfig['openai-research']?.options?.reasoningEffort,
      returnTokenBudget:
        providerConfig['openai-research']?.options?.returnTokenBudget,
      apiKey: providerConfig['openai-research']?.apiKey,
      credentials,
    }),
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
      maxTokens: providerConfig.claude?.options?.maxTokens,
      thinking: providerConfig.claude?.options?.thinking,
      effort: providerConfig.claude?.options?.effort,
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
    if (provider instanceof ProviderBase) {
      provider.configure({
        apiKey: providerConfig[provider.id]?.apiKey,
        credentials,
        httpClient,
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
