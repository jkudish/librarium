export const SEARCHAPI_AI_SYNTHETIC_KEY = 'searchapi-ai-synthetic-key';

export const searchApiAiFixtures = {
  successful: {
    markdown:
      '## SearchAPI-observed answer\n\nGrounded in fixture-only sources.',
    reference_links: [
      {
        url: 'https://example.test/source',
        title: 'Fixture source',
        snippet: 'Synthetic evidence only.',
      },
    ],
  },
  citationFree: {
    markdown: 'A successful answer can legitimately contain no citations.',
    reference_links: [],
  },
  malformed: {
    markdown: '## Broken [markdown](https://example.test',
    text_blocks: [
      { type: 'heading', level: 2, text: 'Structured fallback' },
      { type: 'paragraph', text: 'This came from typed text blocks.' },
      {
        type: 'list',
        items: [
          {
            type: 'list_item',
            text: 'Recognized item',
            children: [{ type: 'paragraph', text: 'Nested evidence.' }],
          },
        ],
      },
      { type: 'unknown_provider_block', text: 'Must not be rendered.' },
    ],
    reference_links: [
      { url: 'not a URL', title: 'Malformed reference' },
      { url: 'data:text/plain,unsafe', title: 'Non-external reference' },
      { url: 'https://example.test/valid', title: 'Valid reference' },
    ],
  },
  providerError: {
    error: 'engine is unavailable for this synthetic account',
  },
  timeout: {
    message: 'synthetic timeout',
  },
  zeroRetentionDenied: {
    error: 'zero_retention is only available on the Enterprise plan',
  },
} as const;
