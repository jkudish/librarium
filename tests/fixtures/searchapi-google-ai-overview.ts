export const SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY =
  'searchapi-google-ai-overview-synthetic-key';
export const SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_TOKEN =
  'synthetic-short-lived-page-token';

export const searchApiGoogleAiOverviewFixtures = {
  stageOneWithToken: {
    organic_results: [
      {
        title: 'Organic content must not render',
        link: 'https://organic.example.test/never-render',
        snippet: 'This belongs only to stage one.',
      },
    ],
    ai_overview: {
      page_token: SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_TOKEN,
    },
  },
  missingToken: {
    organic_results: [
      {
        title: 'No organic fallback',
        link: 'https://organic.example.test/no-fallback',
      },
    ],
    ai_overview: {},
  },
  invalidToken: {
    ai_overview: { page_token: '   ' },
  },
  successfulOverview: {
    markdown: '## Dedicated AI Overview\n\nSynthetic overview content.',
    reference_links: [
      {
        link: 'https://evidence.example.test/overview',
        title: 'Synthetic overview evidence',
        snippet: 'Dedicated stage-two citation.',
      },
      { link: 'javascript:alert(1)', title: 'Invalid citation' },
    ],
  },
  expiredToken: {
    error: `page_token expired for ${SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY}`,
  },
  secondStageFailure: {
    error: 'synthetic upstream failure',
  },
  noResult: {
    markdown: '',
    text_blocks: [],
    reference_links: [],
  },
} as const;
