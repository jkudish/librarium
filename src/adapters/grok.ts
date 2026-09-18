import {
  GrokResponsesProvider,
  type GrokResponsesProviderOptions,
} from './grok-responses.js';

export type { GrokResponsesProviderOptions as GrokProviderOptions } from './grok-responses.js';
export {
  classifyGrokSourceKind,
  DEFAULT_GROK_MODEL,
  grokCombinedOptionsSchema,
  grokWebOptionsSchema,
  grokXOnlyOptionsSchema,
  validateGrokOptions,
} from './grok-responses.js';

/** xAI Grok web-only grounded answers (Responses API + web_search). */
export class GrokProvider extends GrokResponsesProvider {
  constructor(options: GrokResponsesProviderOptions = {}) {
    super('grok', 'web', options);
  }
}

/** xAI Grok X-corpus-only grounded answers (Responses API + x_search). */
export class GrokXOnlyProvider extends GrokResponsesProvider {
  constructor(options: GrokResponsesProviderOptions = {}) {
    super('grok-x-only', 'x', options);
  }
}

/**
 * xAI Grok combined web+X grounded answers.
 * One Responses attempt, one metering record, both tools — never two origins.
 */
export class GrokCombinedProvider extends GrokResponsesProvider {
  constructor(options: GrokResponsesProviderOptions = {}) {
    super('grok-combined', 'combined', options);
  }
}
