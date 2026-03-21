import { OpenAIDeepBaseProvider } from './openai-deep-base.js';

/**
 * OpenAI Deep Research provider (o4-mini).
 * Faster, cheaper deep research model.
 * Tier: deep-research (async)
 */
export class OpenAIDeepProvider extends OpenAIDeepBaseProvider {
  readonly id = 'openai-deep';
  readonly model = 'o4-mini-deep-research';
}
