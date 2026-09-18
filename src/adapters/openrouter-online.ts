import { getBuiltinProviderDefaultModel } from '../core/provider-descriptor.js';
import type { BaseProviderOptions } from './base.js';
import {
  OpenRouterProvider,
  type OpenRouterProviderOptions,
} from './openrouter.js';

export type OpenRouterOnlineProviderOptions = OpenRouterProviderOptions;

/**
 * Legacy v1 adapter bridge for the canonical `openrouter/grounded` profile.
 * The canonical provider/profile binding, rather than an option, selects it.
 */
export class OpenRouterOnlineProvider extends OpenRouterProvider {
  constructor(
    options: OpenRouterOnlineProviderOptions & BaseProviderOptions = {},
  ) {
    super('grounded', options, {
      id: 'openrouter-online',
      tier: 'ai-grounded',
      model: getBuiltinProviderDefaultModel('openrouter-online'),
    });
  }
}
