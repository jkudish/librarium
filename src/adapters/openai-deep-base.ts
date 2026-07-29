import { OpenAIResearchProvider } from './openai-research.js';

/**
 * @deprecated Extend OpenAIResearchProvider instead. This compatibility class
 * uses the canonical openai-research id and current model behavior.
 */
export abstract class OpenAIDeepBaseProvider extends OpenAIResearchProvider {}
