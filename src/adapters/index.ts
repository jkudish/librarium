import { hasApiKey } from '../core/config.js';
import type { Provider, ProviderMeta, ProviderTier } from '../types.js';
import { BraveAnswersProvider } from './brave-answers.js';
import { BraveSearchProvider } from './brave-search.js';
import { ExaProvider } from './exa.js';
import { GeminiDeepProvider } from './gemini-deep.js';
import { OpenAIDeepProvider } from './openai-deep.js';
// Provider imports
import { PerplexityDeepProvider } from './perplexity-deep.js';
import { PerplexitySonarProvider } from './perplexity-sonar.js';
import { SearchApiProvider } from './searchapi.js';
import { SerpApiProvider } from './serpapi.js';
import { SyntheticProvider } from './synthetic.js';
import { TavilyProvider } from './tavily.js';

const providers = new Map<string, Provider>();

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
 * Instantiates and registers all 10 provider adapters.
 */
export async function initializeProviders(): Promise<void> {
  // Deep Research (async capable)
  registerProvider(new PerplexityDeepProvider());
  registerProvider(new OpenAIDeepProvider());
  registerProvider(new GeminiDeepProvider());

  // AI-Grounded Search (sync)
  registerProvider(new PerplexitySonarProvider());
  registerProvider(new BraveAnswersProvider());
  registerProvider(new ExaProvider());

  // Raw Search (sync)
  registerProvider(new BraveSearchProvider());
  registerProvider(new SearchApiProvider());
  registerProvider(new SerpApiProvider());
  registerProvider(new SyntheticProvider());
  registerProvider(new TavilyProvider());
}
