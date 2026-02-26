import { resolveProviderId } from '../constants.js';
import { hasApiKey } from '../core/config.js';
import type { Config, Provider, ProviderMeta, ProviderTier } from '../types.js';
import { BraveAnswersProvider } from './brave-answers.js';
import { BraveSearchProvider } from './brave-search.js';
import { loadCustomProviders } from './custom.js';
import { ExaProvider } from './exa.js';
import { GeminiDeepProvider } from './gemini-deep.js';
import { OpenAIDeepProvider } from './openai-deep.js';
// Provider imports
import { PerplexityAdvancedDeepProvider } from './perplexity-advanced-deep.js';
import { PerplexityDeepResearchProvider } from './perplexity-deep-research.js';
import { PerplexitySearchProvider } from './perplexity-search.js';
import { PerplexitySonarDeepProvider } from './perplexity-sonar-deep.js';
import { PerplexitySonarProProvider } from './perplexity-sonar-pro.js';
import { SearchApiProvider } from './searchapi.js';
import { SerpApiProvider } from './serpapi.js';
import { TavilyProvider } from './tavily.js';

const providers = new Map<string, Provider>();

type ProviderInitConfig = Partial<
  Pick<Config, 'providers' | 'customProviders' | 'trustedProviderIds'>
>;

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
): ProviderMeta[] {
  return getAllProviders().map((p) => {
    const providerConfig = config[p.id];
    const requiresApiKey = p.requiresApiKey ?? true;
    return {
      id: p.id,
      displayName: p.displayName,
      tier: p.tier,
      envVar: p.envVar,
      source: p.source ?? 'builtin',
      enabled: providerConfig?.enabled ?? false,
      hasApiKey: requiresApiKey
        ? providerConfig
          ? hasApiKey(providerConfig.apiKey)
          : !!process.env[p.envVar]
        : true,
    };
  });
}

/**
 * Initialize all providers — called at startup.
 * Instantiates and registers all 13 provider adapters.
 */
export async function initializeProviders(
  config: ProviderInitConfig = {},
): Promise<ProviderInitResult> {
  providers.clear();
  const providerConfig = config.providers ?? {};

  const builtIns: Provider[] = [
    // Deep Research (async capable)
    new PerplexitySonarDeepProvider(),
    new PerplexityDeepResearchProvider(),
    new PerplexityAdvancedDeepProvider(),
    new OpenAIDeepProvider(),
    new GeminiDeepProvider({ model: providerConfig['gemini-deep']?.model }),

    // AI-Grounded Search (sync)
    new PerplexitySonarProProvider(),
    new BraveAnswersProvider(),
    new ExaProvider(),

    // Raw Search (sync)
    new PerplexitySearchProvider(),
    new BraveSearchProvider(),
    new SearchApiProvider(),
    new SerpApiProvider(),
    new TavilyProvider(),
  ];

  const reservedProviderIds = new Set<string>();
  for (const provider of builtIns) {
    provider.source = 'builtin';
    provider.requiresApiKey = true;
    registerProvider(provider);
    reservedProviderIds.add(provider.id);
  }

  const customResult = await loadCustomProviders({
    customProviders: config.customProviders ?? {},
    trustedProviderIds: config.trustedProviderIds ?? [],
    providerConfigs: providerConfig,
    reservedProviderIds,
  });

  for (const provider of customResult.providers) {
    registerProvider(provider);
  }

  return {
    warnings: customResult.warnings,
    loadedCustomProviders: customResult.loadedIds,
    skippedCustomProviders: customResult.skippedIds,
  };
}
