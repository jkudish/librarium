import { getBuiltinProviderDefaultModel } from '../core/provider-descriptor.js';
import type { ProviderTier } from '../types.js';
import { PerplexityAgentBaseProvider } from './perplexity-agent-base.js';

/**
 * Perplexity Agent API — advanced-deep-research preset.
 * Institutional-grade research with enhanced tool access and extended reasoning.
 * Tier: deep-research (async capable)
 */
export class PerplexityAdvancedDeepProvider extends PerplexityAgentBaseProvider {
  readonly id = 'perplexity-advanced-deep';
  readonly tier: ProviderTier = 'deep-research';
  readonly preset = getBuiltinProviderDefaultModel('perplexity-advanced-deep');
}
