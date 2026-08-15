import type { ProviderTier } from '../types.js';
import { PerplexityAgentInlineProvider } from './perplexity-agent-base.js';

/** Canonical Perplexity grounded profile: Agent preset low. */
export class PerplexitySonarProProvider extends PerplexityAgentInlineProvider {
  readonly id = 'perplexity-sonar-pro';
  readonly tier: ProviderTier = 'ai-grounded';
  readonly preset = 'low';
}
