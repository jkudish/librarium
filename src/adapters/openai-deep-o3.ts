import { OpenAIResearchProvider } from './openai-research.js';

/**
 * @deprecated Use OpenAIResearchProvider. This wrapper no longer dispatches
 * o3-deep-research; it behaves as the canonical openai-research provider.
 */
export class OpenAIDeepO3Provider extends OpenAIResearchProvider {}
