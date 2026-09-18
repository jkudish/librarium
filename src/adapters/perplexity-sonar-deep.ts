import type { ProviderTier } from '../types.js';
import { PerplexityAgentBaseProvider } from './perplexity-agent-base.js';

/** Canonical Perplexity research profile: durable Agent preset high. */
export class PerplexitySonarDeepProvider extends PerplexityAgentBaseProvider {
  readonly id = 'perplexity-sonar-deep';
  readonly tier: ProviderTier = 'deep-research';
  readonly preset = 'high';
}
