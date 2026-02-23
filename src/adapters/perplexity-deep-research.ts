import type { ProviderTier } from '../types.js';
import { PerplexityAgentBaseProvider } from './perplexity-agent-base.js';

/**
 * Perplexity Agent API — deep-research preset.
 * Multi-step reasoning with web_search + fetch_url tools.
 * Tier: deep-research (async capable)
 */
export class PerplexityDeepResearchProvider extends PerplexityAgentBaseProvider {
  readonly id = 'perplexity-deep-research';
  readonly tier: ProviderTier = 'deep-research';
  readonly preset = 'deep-research';
}
