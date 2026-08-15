import type { ProviderTier } from '../types.js';
import { PerplexityAgentBaseProvider } from './perplexity-agent-base.js';

/** Canonical Perplexity research profile: durable Agent preset medium. */
export class PerplexityDeepResearchProvider extends PerplexityAgentBaseProvider {
  readonly id = 'perplexity-deep-research';
  readonly tier: ProviderTier = 'deep-research';
  readonly preset = 'medium';
}
