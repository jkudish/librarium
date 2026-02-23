import { hasApiKey } from '../core/config.js';
import type { Provider, ProviderMeta, ProviderTier } from '../types.js';
import { BraveAnswersProvider } from './brave-answers.js';
import { BraveSearchProvider } from './brave-search.js';
import { ExaProvider } from './exa.js';
import { GeminiDeepProvider } from './gemini-deep.js';
import { OpenAIDeepProvider } from './openai-deep.js';
// Provider imports
import { PerplexityAdvancedDeepProvider } from './perplexity-advanced-deep.js';
import { PerplexityDeepResearchProvider } from './perplexity-deep-research.js';
import { PerplexitySonarDeepProvider } from './perplexity-sonar-deep.js';
import { PerplexitySonarProProvider } from './perplexity-sonar-pro.js';
import { SearchApiProvider } from './searchapi.js';
import { SerpApiProvider } from './serpapi.js';
import { TavilyProvider } from './tavily.js';

const providers = new Map<string, Provider>();

type ProviderInitConfig = Record<string, { model?: string }>;

/**
 * Register a provider in the registry
 */
export function registerProvider(provider: Provider): void {
  providers.set(provider.id, provider);
}

/**
 * Get a provider by ID
 */
export function getProvider(id: string): Provider | undefined {
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
  config: Record<string, { apiKey: string; enabled: boolean }>,
): ProviderMeta[] {
  return getAllProviders().map((p) => {
    const providerConfig = config[p.id];
    return {
      id: p.id,
      displayName: p.displayName,
      tier: p.tier,
      envVar: p.envVar,
      enabled: providerConfig?.enabled ?? false,
      hasApiKey: providerConfig
        ? hasApiKey(providerConfig.apiKey)
        : !!process.env[p.envVar],
    };
  });
}

/**
 * Initialize all providers — called at startup.
 * Instantiates and registers all 12 provider adapters.
 */
export async function initializeProviders(
  config: ProviderInitConfig = {},
): Promise<void> {
  providers.clear();

  // Deep Research (async capable)
  registerProvider(new PerplexitySonarDeepProvider());
  registerProvider(new PerplexityDeepResearchProvider());
  registerProvider(new PerplexityAdvancedDeepProvider());
  registerProvider(new OpenAIDeepProvider());
  registerProvider(
    new GeminiDeepProvider({ model: config['gemini-deep']?.model }),
  );

  // AI-Grounded Search (sync)
  registerProvider(new PerplexitySonarProProvider());
  registerProvider(new BraveAnswersProvider());
  registerProvider(new ExaProvider());

  // Raw Search (sync)
  registerProvider(new BraveSearchProvider());
  registerProvider(new SearchApiProvider());
  registerProvider(new SerpApiProvider());
  registerProvider(new TavilyProvider());
}
