import { getBuiltinProviderDefaultModel } from '../core/provider-descriptor.js';
import {
  OpenRouterProvider,
  type OpenRouterProviderOptions,
} from './openrouter.js';

export type OpenRouterChatProviderOptions = OpenRouterProviderOptions;

/**
 * Legacy v1 adapter bridge for the canonical `openrouter/chat` profile.
 * The canonical provider/profile binding, rather than an option, selects it.
 */
export class OpenRouterChatProvider extends OpenRouterProvider {
  constructor(options: OpenRouterChatProviderOptions = {}) {
    super('chat', options, {
      id: 'openrouter-chat',
      tier: 'llm',
      model: getBuiltinProviderDefaultModel('openrouter-chat'),
    });
  }
}
