export type ProviderConformanceLane =
  | 'options'
  | 'credentials'
  | 'normalization'
  | 'safe_failure'
  | 'citations'
  | 'provenance'
  | 'metering'
  | 'lifecycle';

export interface ProviderConformanceEvidence {
  readonly evidence: readonly string[];
  readonly lanes: readonly ProviderConformanceLane[];
}

const base = [
  'credentials',
  'normalization',
  'safe_failure',
  'provenance',
  'metering',
] as const;
const grounded = [...base, 'citations'] as const;
const background = [...grounded, 'lifecycle'] as const;
const configurable = [...grounded, 'options'] as const;
const configurableBackground = [...background, 'options'] as const;

/**
 * Review evidence for every implemented public profile. This is deliberately
 * explicit: adding a catalog profile must also name the contract tests that
 * prove its provider boundary.
 */
export const PROVIDER_CONFORMANCE_EVIDENCE: Readonly<
  Record<string, ProviderConformanceEvidence>
> = {
  'perplexity-sonar-deep/research': {
    evidence: ['tests/adapters/perplexity-agent.test.ts'],
    lanes: background,
  },
  'perplexity-deep-research/research': {
    evidence: ['tests/adapters/perplexity-agent.test.ts'],
    lanes: background,
  },
  'openai-research/research': {
    evidence: ['tests/adapters/openai-research.test.ts'],
    lanes: configurableBackground,
  },
  'gemini-deep/research': {
    evidence: ['tests/adapters/gemini-deep-async.test.ts'],
    lanes: configurableBackground,
  },
  'parallel/research': {
    evidence: ['tests/adapters/parallel.test.ts'],
    lanes: configurableBackground,
  },
  'valyu/research': {
    evidence: ['tests/adapters/valyu.test.ts'],
    lanes: configurableBackground,
  },
  'exa/research': {
    evidence: ['tests/research-provider-adapters.test.ts'],
    lanes: configurableBackground,
  },
  'you-research/research': {
    evidence: ['tests/research-provider-adapters.test.ts'],
    lanes: configurableBackground,
  },
  'perplexity-sonar-pro/grounded': {
    evidence: ['tests/adapters/perplexity-agent.test.ts'],
    lanes: grounded,
  },
  'gemini-grounded/grounded': {
    evidence: ['tests/adapters/grounded-providers.test.ts'],
    lanes: configurable,
  },
  'grok/web': {
    evidence: ['tests/adapters/grok.test.ts'],
    lanes: configurable,
  },
  'grok-x-only/x': {
    evidence: ['tests/adapters/grok.test.ts'],
    lanes: configurable,
  },
  'grok-combined/combined': {
    evidence: ['tests/adapters/grok.test.ts'],
    lanes: configurable,
  },
  'openrouter/grounded': {
    evidence: ['tests/adapters/grounded-providers.test.ts'],
    lanes: configurable,
  },
  'brave-answers/grounded': {
    evidence: ['tests/adapters/brave-answers.test.ts'],
    lanes: grounded,
  },
  'you-research/grounded': {
    evidence: ['tests/adapters/grounded-providers.test.ts'],
    lanes: grounded,
  },
  'you-answer/grounded': {
    evidence: ['tests/adapters/you-answer.test.ts'],
    lanes: configurable,
  },
  'kagi-fastgpt/grounded': {
    evidence: ['tests/adapters/grounded-providers.test.ts'],
    lanes: grounded,
  },
  'exa/search': {
    evidence: ['tests/adapters/grounded-providers.test.ts'],
    lanes: base,
  },
  'perplexity-search/search': {
    evidence: ['tests/adapters/perplexity-search.test.ts'],
    lanes: configurable,
  },
  'brave-search/search': {
    evidence: ['tests/provider-descriptors.test.ts'],
    lanes: base,
  },
  'jina-search/search': {
    evidence: ['tests/provider-descriptors.test.ts'],
    lanes: base,
  },
  'firecrawl-search/search': {
    evidence: ['tests/adapters/firecrawl-search.test.ts'],
    lanes: [...base, 'options'],
  },
  'searchapi/search': {
    evidence: ['tests/adapters/searchapi.test.ts'],
    lanes: [...base, 'options'],
  },
  'serpapi/search': {
    evidence: ['tests/provider-descriptors.test.ts'],
    lanes: base,
  },
  'tavily/search': {
    evidence: ['tests/adapters/grounded-providers.test.ts'],
    lanes: base,
  },
  'parallel/search': {
    evidence: ['tests/adapters/parallel.test.ts'],
    lanes: [...base, 'options'],
  },
  'parallel/turbo': {
    evidence: ['tests/adapters/parallel.test.ts'],
    lanes: [...base, 'options'],
  },
  'valyu/search': {
    evidence: ['tests/adapters/valyu.test.ts'],
    lanes: [...base, 'options'],
  },
  'searchapi-chatgpt/surface': {
    evidence: ['tests/adapters/searchapi-answer-engines.test.ts'],
    lanes: [...grounded, 'options'],
  },
  'searchapi-gemini/surface': {
    evidence: ['tests/adapters/searchapi-answer-engines.test.ts'],
    lanes: [...grounded, 'options'],
  },
  'searchapi-perplexity/surface': {
    evidence: ['tests/adapters/searchapi-answer-engines.test.ts'],
    lanes: [...grounded, 'options'],
  },
  'searchapi-google-ai-mode/surface': {
    evidence: ['tests/adapters/searchapi-ai.test.ts'],
    lanes: [...grounded, 'options'],
  },
  'searchapi-bing-copilot/surface': {
    evidence: ['tests/adapters/searchapi-ai.test.ts'],
    lanes: [...grounded, 'options'],
  },
  'searchapi-google-ai-overview/surface': {
    evidence: ['tests/adapters/searchapi-google-ai-overview.test.ts'],
    lanes: [...grounded, 'options'],
  },
  'claude/chat': {
    evidence: ['tests/adapters/llm-providers.test.ts'],
    lanes: [...base, 'options'],
  },
  'openai-chat/chat': {
    evidence: ['tests/adapters/llm-providers.test.ts'],
    lanes: [...base, 'options'],
  },
  'gemini-chat/chat': {
    evidence: ['tests/adapters/llm-providers.test.ts'],
    lanes: [...base, 'options'],
  },
  'openrouter/chat': {
    evidence: ['tests/adapters/llm-providers.test.ts'],
    lanes: [...base, 'options'],
  },
};
