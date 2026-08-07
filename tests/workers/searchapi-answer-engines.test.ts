import { describe, expect, it } from 'vitest';
import { SearchApiBingCopilotProvider } from '../../src/adapters/searchapi-bing-copilot.js';
import { SearchApiGoogleAiModeProvider } from '../../src/adapters/searchapi-google-ai-mode.js';

const providers = [
  {
    id: 'searchapi-google-ai-mode',
    create: () =>
      new SearchApiGoogleAiModeProvider({
        apiKey: 'worker-google-ai-mode-synthetic-key',
      }),
  },
  {
    id: 'searchapi-bing-copilot',
    create: () =>
      new SearchApiBingCopilotProvider({
        apiKey: 'worker-bing-copilot-synthetic-key',
      }),
  },
] as const;

describe('SearchAPI answer-engine adapters in workerd', () => {
  it.each(providers)(
    '$id imports without Node-only dependencies',
    ({ create }) => {
      const provider = create();
      expect(provider.execution).toBe('inline');
      expect(provider.tier).toBe('ai-grounded');
    },
  );
});
