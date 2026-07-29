import { OpenAIResearchProvider } from './openai-research.js';

/**
 * @deprecated Use OpenAIResearchProvider. This wrapper no longer dispatches
 * o4-mini-deep-research; it behaves as the canonical openai-research provider.
 */
export class OpenAIDeepProvider extends OpenAIResearchProvider {}
