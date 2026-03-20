import { OpenAIDeepBaseProvider } from './openai-deep-base.js';

/**
 * OpenAI Deep Research provider (o3).
 * Higher-quality deep research model.
 * Tier: deep-research (async)
 */
export class OpenAIDeepO3Provider extends OpenAIDeepBaseProvider {
  readonly id = 'openai-deep-o3';
  readonly model = 'o3-deep-research';
}
