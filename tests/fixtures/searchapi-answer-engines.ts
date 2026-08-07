export const SEARCHAPI_ANSWER_ENGINES_SYNTHETIC_KEY =
  'searchapi-answer-engines-synthetic-key';

export const searchApiGoogleAiModeFixtures = {
  successful: {
    markdown: '## AI Mode answer\n\nGoogle AI Mode fixture content.',
    reference_links: [
      {
        link: 'https://google-ai-mode.example.test/source',
        title: 'Google AI Mode source',
        snippet: 'Synthetic Google AI Mode evidence.',
      },
    ],
    web_results: [
      {
        link: 'https://organic.example.test/must-not-be-used',
        title: 'Organic fallback must not be used',
      },
    ],
  },
  citationFree: {
    markdown: 'A successful Google AI Mode response may contain no citations.',
    reference_links: [],
  },
  malformed: {
    markdown: '## Incomplete [Google Markdown](https://example.test',
    text_blocks: [
      { type: 'header', answer: 'Google structured fallback' },
      {
        type: 'paragraph',
        answer: 'This came from Google AI Mode text blocks.',
      },
      {
        type: 'unordered_list',
        items: [
          {
            type: 'paragraph',
            answer: 'Recognized Google list item.',
          },
        ],
      },
      {
        type: 'code_blocks',
        language: 'text',
        code: 'Google fixture code block',
      },
      { type: 'unsupported_google_block', answer: 'Must not be rendered.' },
    ],
    reference_links: [
      { link: 'not a URL', title: 'Malformed reference' },
      { link: 'data:text/plain,unsafe', title: 'Unsafe reference' },
      {
        link: 'https://google-ai-mode.example.test/valid',
        title: 'Valid Google reference',
      },
    ],
    local_results: [
      {
        link: 'https://organic.example.test/local-must-not-be-used',
        title: 'Local fallback must not be used',
      },
    ],
  },
  providerError: {
    error: 'google_ai_mode engine is unavailable for this synthetic account',
  },
  timeout: { message: 'synthetic Google AI Mode timeout' },
  zeroRetentionDenied: {
    error: 'zero_retention is only available on the Enterprise plan',
  },
} as const;

export const searchApiBingCopilotFixtures = {
  successful: {
    markdown: '## Copilot answer\n\nBing Copilot fixture content.',
    reference_links: [
      {
        link: 'https://bing-copilot.example.test/source',
        title: 'Bing Copilot source',
        snippet: 'Synthetic Bing Copilot evidence.',
      },
    ],
  },
  citationFree: {
    markdown: 'A successful Bing Copilot response may contain no citations.',
    reference_links: [],
  },
  malformed: {
    markdown: '## Incomplete [Copilot Markdown](https://example.test',
    text_blocks: [
      { type: 'header', answer: 'Bing structured fallback' },
      {
        type: 'paragraph',
        answer: 'This came from Bing Copilot text blocks.',
      },
      {
        type: 'ordered_list',
        items: [
          {
            type: 'paragraph',
            answer: 'Recognized Bing list item.',
          },
        ],
      },
      {
        type: 'code_blocks',
        language: 'text',
        code: 'Bing fixture code block',
      },
      { type: 'unsupported_bing_block', answer: 'Must not be rendered.' },
    ],
    reference_links: [
      { link: 'javascript:alert(1)', title: 'Unsafe reference' },
      { link: '', title: 'Empty reference' },
      {
        link: 'https://bing-copilot.example.test/valid',
        title: 'Valid Bing reference',
      },
    ],
  },
  providerError: {
    error: 'bing_copilot engine is unavailable for this synthetic account',
  },
  timeout: { message: 'synthetic Bing Copilot timeout' },
  zeroRetentionDenied: {
    error: 'zero_retention is only available on the Enterprise plan',
  },
} as const;
