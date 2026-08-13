import { z } from 'zod';
import {
  grokCombinedOptionsSchema,
  grokWebOptionsSchema,
  grokXOnlyOptionsSchema,
} from '../adapters/grok-options.js';
import { PerplexitySearchOptionsSchema } from '../adapters/perplexity-search-options.js';
import type { MeteringKind, ProviderTier } from '../types.js';
import { searchApiOptionsSchema } from './searchapi.js';

export interface ProviderMeteringDescriptor {
  kind: MeteringKind;
  defaultPerRequestUsd?: number;
  defaultUnitsPerRequest?: number;
  unit?: string;
}

export type ProviderCapabilities =
  | {
      execution: 'inline';
      healthCheck: true;
      citations: true;
      webSearch?: 'always' | 'optional';
    }
  | {
      execution: 'background';
      healthCheck: true;
      citations: true;
      taskPersistence: 'remote' | 'process-local';
      webSearch: 'always';
    };

export interface ProviderDescriptorDefinition {
  id: string;
  registrationOrder: number;
  aliases: readonly string[];
  tier: ProviderTier;
  display: {
    family: string;
    name: string;
    description: string;
    bestFor: string;
    setupUrl: string;
    recommended?: boolean;
    order: number;
  };
  credential: {
    envVar: string;
    required: boolean;
    /** Whether credential discovery may select this provider during setup. */
    autoEnable: boolean;
  };
  metering: ProviderMeteringDescriptor;
  optionsSchema: z.ZodTypeAny;
  capabilities: ProviderCapabilities;
  defaultModel?: string;
}

const positiveNumber = z.number().positive();
const commonOptions = z
  .object({
    perRequestUsd: positiveNumber.optional(),
    creditUsd: positiveNumber.optional(),
    creditsPerRequest: positiveNumber.optional(),
    perUnitUsd: positiveNumber.optional(),
  })
  .passthrough();
const webSearchOptions = commonOptions.extend({
  webSearch: z.boolean().optional(),
});
const openAiResearchOptions = commonOptions.extend({
  maxToolCalls: z.number().int().positive().optional(),
  reasoningEffort: z
    .enum(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    .optional(),
  returnTokenBudget: z.enum(['default', 'unlimited']).optional(),
});
const claudeOptions = webSearchOptions.extend({
  maxTokens: z.number().int().positive().optional(),
  thinking: z.enum(['adaptive', 'disabled']).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});
const firecrawlSearchOptions = commonOptions
  .extend({
    sources: z
      .array(z.enum(['web', 'news']))
      .nonempty()
      .optional(),
    limit: z.number().int().min(1).max(100).optional(),
    tbs: z.string().min(1).optional(),
    country: z.string().min(1).optional(),
    location: z.string().min(1).optional(),
    includeDomains: z.array(z.string().min(1)).nonempty().optional(),
    excludeDomains: z.array(z.string().min(1)).nonempty().optional(),
    categories: z
      .array(z.enum(['github', 'research', 'pdf']))
      .nonempty()
      .optional(),
    ignoreInvalidURLs: z.boolean().optional(),
  })
  .refine(
    ({ includeDomains, excludeDomains }) => !(includeDomains && excludeDomains),
    {
      message: 'includeDomains and excludeDomains are mutually exclusive',
    },
  );

const inline = (webSearch?: 'always' | 'optional'): ProviderCapabilities => ({
  execution: 'inline',
  healthCheck: true,
  citations: true,
  ...(webSearch ? { webSearch } : {}),
});
const background = (
  taskPersistence: 'remote' | 'process-local' = 'remote',
): ProviderCapabilities => ({
  execution: 'background',
  healthCheck: true,
  citations: true,
  taskPersistence,
  webSearch: 'always',
});

type DefinitionInput = Omit<
  ProviderDescriptorDefinition,
  'aliases' | 'credential' | 'optionsSchema'
> & {
  aliases?: readonly string[];
  envVar: string;
  autoEnable?: boolean;
  optionsSchema?: z.ZodTypeAny;
};

function define(input: DefinitionInput): ProviderDescriptorDefinition {
  const { autoEnable, envVar, ...definition } = input;
  return {
    aliases: [],
    optionsSchema: commonOptions,
    ...definition,
    credential: {
      envVar,
      required: true,
      autoEnable: autoEnable ?? input.tier !== 'llm',
    },
  };
}

export const BUILTIN_PROVIDER_DEFINITIONS = [
  define({
    id: 'brave-search',
    registrationOrder: 15,
    tier: 'raw-search',
    envVar: 'BRAVE_API_KEY',
    display: {
      family: 'Brave',
      name: 'Brave Web Search',
      description: 'Fast raw web search from Brave’s independent index.',
      bestFor: 'Broad source discovery and a low-friction first provider.',
      setupUrl: 'https://brave.com/search/api/',
      recommended: true,
      order: 10,
    },
    metering: {
      kind: 'request_priced',
      defaultPerRequestUsd: 0.005,
      defaultUnitsPerRequest: 1,
      unit: 'request',
    },
    capabilities: inline('always'),
  }),
  define({
    id: 'perplexity-sonar-pro',
    registrationOrder: 6,
    aliases: [],
    tier: 'ai-grounded',
    envVar: 'PERPLEXITY_API_KEY',
    defaultModel: 'sonar-pro',
    display: {
      family: 'Perplexity',
      name: 'Perplexity Sonar Pro',
      description: 'Grounded AI answers with citations through Sonar.',
      bestFor: 'Quick synthesized answers with source attribution.',
      setupUrl: 'https://docs.perplexity.ai/docs/getting-started/quickstart',
      recommended: true,
      order: 20,
    },
    metering: { kind: 'native_cost' },
    capabilities: inline('always'),
  }),
  define({
    id: 'exa',
    registrationOrder: 11,
    tier: 'ai-grounded',
    envVar: 'EXA_API_KEY',
    display: {
      family: 'Exa',
      name: 'Exa Search',
      description: 'AI-oriented web search for finding relevant pages quickly.',
      bestFor: 'Semantic source discovery and agentic web search.',
      setupUrl: 'https://exa.ai/docs/reference/getting-started',
      recommended: true,
      order: 30,
    },
    metering: { kind: 'native_cost' },
    capabilities: inline('always'),
  }),
  define({
    id: 'tavily',
    registrationOrder: 20,
    tier: 'raw-search',
    envVar: 'TAVILY_API_KEY',
    display: {
      family: 'Tavily',
      name: 'Tavily Search',
      description: 'Search and extraction APIs designed for AI agents.',
      bestFor: 'Agent workflows that need focused search results.',
      setupUrl: 'https://docs.tavily.com/documentation/quickstart',
      recommended: true,
      order: 40,
    },
    metering: {
      kind: 'credit_priced',
      defaultUnitsPerRequest: 2,
      unit: 'credit',
    },
    capabilities: inline('always'),
  }),
  define({
    id: 'openai-research',
    registrationOrder: 4,
    aliases: [],
    tier: 'deep-research',
    envVar: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5.6-sol',
    optionsSchema: openAiResearchOptions,
    display: {
      family: 'OpenAI',
      name: 'OpenAI Research',
      description:
        'OpenAI background research for slower, more thorough reports.',
      bestFor: 'Important questions where depth matters more than latency.',
      setupUrl: 'https://platform.openai.com/api-keys',
      order: 110,
    },
    metering: { kind: 'native_tokens' },
    capabilities: background(),
  }),
  define({
    id: 'gemini-grounded',
    registrationOrder: 7,
    tier: 'ai-grounded',
    envVar: 'GEMINI_API_KEY',
    defaultModel: 'gemini-2.5-flash',
    display: {
      family: 'Gemini',
      name: 'Gemini Grounded Search',
      description: 'Gemini answers with Google-grounded search.',
      bestFor: 'Fast grounded answers from the Gemini ecosystem.',
      setupUrl: 'https://ai.google.dev/gemini-api/docs/api-key',
      order: 120,
    },
    metering: { kind: 'native_tokens' },
    capabilities: inline('always'),
  }),
  define({
    id: 'gemini-deep',
    registrationOrder: 5,
    tier: 'deep-research',
    envVar: 'GEMINI_API_KEY',
    defaultModel: 'deep-research-preview-04-2026',
    display: {
      family: 'Gemini',
      name: 'Gemini Deep Research',
      description: 'Gemini deep research for longer-running investigations.',
      bestFor: 'Deeper Gemini-backed research.',
      setupUrl: 'https://ai.google.dev/gemini-api/docs/api-key',
      order: 121,
    },
    metering: { kind: 'native_tokens', defaultPerRequestUsd: 3, unit: 'task' },
    capabilities: background(),
  }),
  define({
    id: 'perplexity-sonar-deep',
    registrationOrder: 1,
    aliases: [],
    tier: 'deep-research',
    envVar: 'PERPLEXITY_API_KEY',
    defaultModel: 'sonar-deep-research',
    display: {
      family: 'Perplexity',
      name: 'Perplexity Sonar Deep Research',
      description: 'Perplexity Sonar deep research for comprehensive reports.',
      bestFor: 'Longer Perplexity research runs.',
      setupUrl: 'https://docs.perplexity.ai/docs/getting-started/quickstart',
      order: 130,
    },
    metering: { kind: 'native_cost' },
    capabilities: background(),
  }),
  define({
    id: 'perplexity-deep-research',
    registrationOrder: 2,
    tier: 'deep-research',
    envVar: 'PERPLEXITY_API_KEY',
    defaultModel: 'deep-research',
    display: {
      family: 'Perplexity',
      name: 'Perplexity Deep Research',
      description: 'Perplexity deep research using the dedicated research API.',
      bestFor: 'Deep Perplexity-backed reports.',
      setupUrl: 'https://docs.perplexity.ai/docs/getting-started/quickstart',
      order: 131,
    },
    metering: { kind: 'native_cost' },
    capabilities: background('process-local'),
  }),
  define({
    id: 'perplexity-advanced-deep',
    registrationOrder: 3,
    tier: 'deep-research',
    envVar: 'PERPLEXITY_API_KEY',
    defaultModel: 'advanced-deep-research',
    display: {
      family: 'Perplexity',
      name: 'Perplexity Advanced Deep Research',
      description: 'Higher-effort Perplexity deep research.',
      bestFor: 'More exhaustive Perplexity runs.',
      setupUrl: 'https://docs.perplexity.ai/docs/getting-started/quickstart',
      order: 132,
    },
    metering: { kind: 'native_cost' },
    capabilities: background('process-local'),
  }),
  define({
    id: 'perplexity-search',
    registrationOrder: 14,
    tier: 'raw-search',
    envVar: 'PERPLEXITY_API_KEY',
    optionsSchema: PerplexitySearchOptionsSchema,
    display: {
      family: 'Perplexity',
      name: 'Perplexity Search',
      description: 'Perplexity search results without full AI synthesis.',
      bestFor: 'Fast Perplexity source discovery.',
      setupUrl: 'https://docs.perplexity.ai/docs/getting-started/quickstart',
      order: 133,
    },
    metering: {
      kind: 'request_priced',
      defaultUnitsPerRequest: 1,
      unit: 'request',
    },
    capabilities: inline('always'),
  }),
  define({
    id: 'brave-answers',
    registrationOrder: 10,
    tier: 'ai-grounded',
    envVar: 'BRAVE_API_KEY',
    defaultModel: 'brave',
    display: {
      family: 'Brave',
      name: 'Brave AI Answers',
      description: 'Brave AI answers with web grounding.',
      bestFor: 'A Brave-backed synthesized answer layer.',
      setupUrl: 'https://brave.com/search/api/',
      order: 140,
    },
    metering: { kind: 'api_unit_priced', unit: 'search + token' },
    capabilities: inline('always'),
  }),
  define({
    id: 'openrouter-online',
    registrationOrder: 9,
    tier: 'ai-grounded',
    envVar: 'OPENROUTER_API_KEY',
    defaultModel: 'openai/gpt-4o-mini',
    display: {
      family: 'OpenRouter',
      name: 'OpenRouter Online Search',
      description: 'Online search through OpenRouter-compatible models.',
      bestFor: 'Using one OpenRouter account for online model access.',
      setupUrl: 'https://openrouter.ai/docs/quickstart',
      order: 150,
    },
    metering: { kind: 'native_cost' },
    capabilities: inline('always'),
  }),
  define({
    id: 'grok',
    registrationOrder: 8,
    tier: 'ai-grounded',
    envVar: 'XAI_API_KEY',
    defaultModel: 'grok-4.5',
    optionsSchema: grokWebOptionsSchema,
    display: {
      family: 'xAI',
      name: 'Grok (xAI)',
      description: 'Grok Responses API answers grounded with xAI web search.',
      bestFor: 'Comparing Grok’s cited web-grounded answer visibility.',
      setupUrl: 'https://console.x.ai',
      order: 155,
    },
    metering: {
      kind: 'native_tokens',
      defaultPerRequestUsd: 0.015,
      unit: 'request',
    },
    capabilities: inline('always'),
  }),
  define({
    id: 'grok-x-only',
    registrationOrder: 32,
    tier: 'ai-grounded',
    envVar: 'XAI_API_KEY',
    defaultModel: 'grok-4.5',
    autoEnable: false,
    optionsSchema: grokXOnlyOptionsSchema,
    display: {
      family: 'xAI',
      name: 'Grok X Search',
      description: 'Grok Responses API answers grounded only in the X corpus.',
      bestFor: 'Observing what the X corpus alone supports.',
      setupUrl: 'https://console.x.ai',
      order: 156,
    },
    metering: {
      kind: 'native_tokens',
      defaultPerRequestUsd: 0.015,
      unit: 'request',
    },
    capabilities: inline(),
  }),
  define({
    id: 'grok-combined',
    registrationOrder: 33,
    tier: 'ai-grounded',
    envVar: 'XAI_API_KEY',
    defaultModel: 'grok-4.5',
    autoEnable: false,
    optionsSchema: grokCombinedOptionsSchema,
    display: {
      family: 'xAI',
      name: 'Grok Combined Search',
      description:
        'One Grok Responses execution grounded in both web and X corpora.',
      bestFor: 'A single cited answer spanning web and X sources.',
      setupUrl: 'https://console.x.ai',
      order: 157,
    },
    metering: {
      kind: 'native_tokens',
      defaultPerRequestUsd: 0.025,
      unit: 'request',
    },
    capabilities: inline('always'),
  }),
  define({
    id: 'you-research',
    registrationOrder: 12,
    tier: 'ai-grounded',
    envVar: 'YOU_COM_API_KEY',
    display: {
      family: 'You.com',
      name: 'You.com Research',
      description: 'You.com research API for real-time web intelligence.',
      bestFor: 'Cited research through You.com APIs.',
      setupUrl: 'https://you.com/docs/administration/api-keys',
      order: 160,
    },
    metering: {
      kind: 'credit_priced',
      defaultUnitsPerRequest: 1,
      unit: 'query',
    },
    capabilities: inline('always'),
  }),
  define({
    id: 'kagi-fastgpt',
    registrationOrder: 13,
    tier: 'ai-grounded',
    envVar: 'KAGI_API_KEY',
    display: {
      family: 'Kagi',
      name: 'Kagi FastGPT',
      description: 'Kagi FastGPT answers backed by Kagi search.',
      bestFor: 'Kagi users who want premium search-backed answers.',
      setupUrl: 'https://help.kagi.com/kagi/api/fastgpt.html',
      order: 170,
    },
    metering: {
      kind: 'request_priced',
      defaultPerRequestUsd: 0.015,
      defaultUnitsPerRequest: 1,
      unit: 'request',
    },
    capabilities: inline('always'),
  }),
  define({
    id: 'jina-search',
    registrationOrder: 16,
    tier: 'raw-search',
    envVar: 'JINA_AI_API_KEY',
    display: {
      family: 'Jina AI',
      name: 'Jina AI Search',
      description: 'Jina Search Foundation APIs for search-oriented retrieval.',
      bestFor: 'Search and reader workflows in the Jina ecosystem.',
      setupUrl: 'https://jina.ai/reader/',
      order: 180,
    },
    metering: { kind: 'api_unit_priced', unit: 'token' },
    capabilities: inline('always'),
  }),
  define({
    id: 'firecrawl-search',
    registrationOrder: 17,
    tier: 'raw-search',
    envVar: 'FIRECRAWL_API_KEY',
    optionsSchema: firecrawlSearchOptions,
    display: {
      family: 'Firecrawl',
      name: 'Firecrawl Search',
      description: 'Firecrawl search for web search and extraction workflows.',
      bestFor: 'Search plus downstream scraping/extraction workflows.',
      setupUrl: 'https://docs.firecrawl.dev/api-reference/v2-introduction',
      order: 190,
    },
    metering: {
      kind: 'credit_priced',
      defaultUnitsPerRequest: 1,
      unit: 'credit',
    },
    capabilities: inline('always'),
  }),
  define({
    id: 'searchapi',
    registrationOrder: 18,
    tier: 'raw-search',
    envVar: 'SEARCHAPI_API_KEY',
    optionsSchema: searchApiOptionsSchema,
    display: {
      family: 'SearchAPI',
      name: 'SearchAPI',
      description: 'SERP scraping API for structured search results.',
      bestFor: 'Google-style SERP data and structured search output.',
      setupUrl: 'https://www.searchapi.io/',
      order: 200,
    },
    metering: {
      kind: 'request_priced',
      defaultPerRequestUsd: 0.004,
      defaultUnitsPerRequest: 1,
      unit: 'request',
    },
    capabilities: inline('always'),
  }),
  define({
    id: 'serpapi',
    registrationOrder: 19,
    tier: 'raw-search',
    envVar: 'SERPAPI_API_KEY',
    display: {
      family: 'SerpApi',
      name: 'SerpAPI',
      description: 'Real-time SERP API with structured search results.',
      bestFor: 'Search-engine result pages with rich structured data.',
      setupUrl: 'https://serpapi.com/users/sign_up',
      order: 210,
    },
    metering: {
      kind: 'request_priced',
      defaultPerRequestUsd: 0.015,
      defaultUnitsPerRequest: 1,
      unit: 'request',
    },
    capabilities: inline('always'),
  }),
  define({
    id: 'searchapi-chatgpt',
    registrationOrder: 25,
    tier: 'ai-grounded',
    envVar: 'SEARCHAPI_API_KEY',
    autoEnable: false,
    optionsSchema: searchApiOptionsSchema,
    display: {
      family: 'SearchAPI',
      name: 'SearchAPI ChatGPT',
      description:
        'SearchAPI-observed ChatGPT consumer answer with web search.',
      bestFor: 'Comparing the cited answer visible on the ChatGPT surface.',
      setupUrl: 'https://www.searchapi.io/',
      order: 201,
    },
    metering: {
      kind: 'request_priced',
      defaultPerRequestUsd: 0.004,
      defaultUnitsPerRequest: 1,
      unit: 'request',
    },
    capabilities: inline('always'),
  }),
  define({
    id: 'searchapi-gemini',
    registrationOrder: 26,
    tier: 'ai-grounded',
    envVar: 'SEARCHAPI_API_KEY',
    autoEnable: false,
    optionsSchema: searchApiOptionsSchema,
    display: {
      family: 'SearchAPI',
      name: 'SearchAPI Gemini',
      description: 'SearchAPI-observed Gemini consumer answer.',
      bestFor: 'Comparing the cited answer visible on the Gemini surface.',
      setupUrl: 'https://www.searchapi.io/',
      order: 202,
    },
    metering: {
      kind: 'request_priced',
      defaultPerRequestUsd: 0.004,
      defaultUnitsPerRequest: 1,
      unit: 'request',
    },
    capabilities: inline('always'),
  }),
  define({
    id: 'searchapi-perplexity',
    registrationOrder: 27,
    tier: 'ai-grounded',
    envVar: 'SEARCHAPI_API_KEY',
    autoEnable: false,
    optionsSchema: searchApiOptionsSchema,
    display: {
      family: 'SearchAPI',
      name: 'SearchAPI Perplexity',
      description: 'SearchAPI-observed Perplexity consumer answer.',
      bestFor: 'Comparing the cited answer visible on the Perplexity surface.',
      setupUrl: 'https://www.searchapi.io/',
      order: 203,
    },
    metering: {
      kind: 'request_priced',
      defaultPerRequestUsd: 0.004,
      defaultUnitsPerRequest: 1,
      unit: 'request',
    },
    capabilities: inline('always'),
  }),
  define({
    id: 'searchapi-google-ai-mode',
    registrationOrder: 28,
    tier: 'ai-grounded',
    envVar: 'SEARCHAPI_API_KEY',
    autoEnable: false,
    optionsSchema: searchApiOptionsSchema,
    display: {
      family: 'SearchAPI',
      name: 'SearchAPI Google AI Mode',
      description: 'SearchAPI-observed Google AI Mode consumer answer.',
      bestFor: 'Comparing Google AI Mode answer visibility and citations.',
      setupUrl: 'https://www.searchapi.io/',
      order: 204,
    },
    metering: {
      kind: 'request_priced',
      defaultPerRequestUsd: 0.004,
      defaultUnitsPerRequest: 1,
      unit: 'request',
    },
    capabilities: inline('always'),
  }),
  define({
    id: 'searchapi-bing-copilot',
    registrationOrder: 29,
    tier: 'ai-grounded',
    envVar: 'SEARCHAPI_API_KEY',
    autoEnable: false,
    optionsSchema: searchApiOptionsSchema,
    display: {
      family: 'SearchAPI',
      name: 'SearchAPI Bing Copilot',
      description: 'SearchAPI-observed Bing Copilot consumer answer.',
      bestFor: 'Comparing Bing Copilot answer visibility and citations.',
      setupUrl: 'https://www.searchapi.io/',
      order: 205,
    },
    metering: {
      kind: 'request_priced',
      defaultPerRequestUsd: 0.004,
      defaultUnitsPerRequest: 1,
      unit: 'request',
    },
    capabilities: inline('always'),
  }),
  define({
    id: 'searchapi-google-ai-overview',
    registrationOrder: 30,
    tier: 'ai-grounded',
    envVar: 'SEARCHAPI_API_KEY',
    autoEnable: false,
    optionsSchema: searchApiOptionsSchema,
    display: {
      family: 'SearchAPI',
      name: 'SearchAPI Google AI Overview',
      description:
        'Dedicated two-stage SearchAPI-observed Google AI Overview answer.',
      bestFor: 'Comparing the dedicated Google AI Overview and its citations.',
      setupUrl: 'https://www.searchapi.io/',
      order: 206,
    },
    metering: {
      kind: 'request_priced',
      defaultPerRequestUsd: 0.004,
      defaultUnitsPerRequest: 2,
      unit: 'request',
    },
    capabilities: inline('always'),
  }),
  define({
    id: 'perplexity-pro-search',
    registrationOrder: 31,
    tier: 'ai-grounded',
    envVar: 'PERPLEXITY_API_KEY',
    autoEnable: false,
    optionsSchema: z.object({}).strict(),
    defaultModel: 'sonar-pro',
    display: {
      family: 'Perplexity',
      name: 'Perplexity Pro Search',
      description: 'Forced streaming Pro Search through the Perplexity API.',
      bestFor: 'Higher-effort official Perplexity searches with native cost.',
      setupUrl: 'https://docs.perplexity.ai/docs/getting-started/quickstart',
      order: 21,
    },
    metering: { kind: 'native_cost' },
    capabilities: inline('always'),
  }),
  define({
    id: 'claude',
    registrationOrder: 21,
    tier: 'llm',
    envVar: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-5',
    optionsSchema: claudeOptions,
    display: {
      family: 'Anthropic',
      name: 'Claude',
      description: 'Claude model answer with optional web search citations.',
      bestFor: 'Direct Claude answers; web search is on by default.',
      setupUrl: 'https://platform.claude.com/docs',
      order: 500,
    },
    metering: { kind: 'native_tokens' },
    capabilities: inline('optional'),
  }),
  define({
    id: 'openai-chat',
    registrationOrder: 22,
    tier: 'llm',
    envVar: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5-mini',
    optionsSchema: webSearchOptions,
    display: {
      family: 'OpenAI',
      name: 'OpenAI Chat',
      description: 'OpenAI model answer with optional web search citations.',
      bestFor: 'Direct OpenAI answers; web search is on by default.',
      setupUrl: 'https://platform.openai.com/api-keys',
      order: 510,
    },
    metering: { kind: 'native_tokens' },
    capabilities: inline('optional'),
  }),
  define({
    id: 'gemini-chat',
    registrationOrder: 23,
    tier: 'llm',
    envVar: 'GEMINI_API_KEY',
    defaultModel: 'gemini-3.6-flash',
    optionsSchema: webSearchOptions,
    display: {
      family: 'Gemini',
      name: 'Gemini Chat',
      description: 'Gemini model answer with optional Google Search grounding.',
      bestFor: 'Direct Gemini answers; web search is on by default.',
      setupUrl: 'https://ai.google.dev/gemini-api/docs/api-key',
      order: 520,
    },
    metering: { kind: 'native_tokens' },
    capabilities: inline('optional'),
  }),
  define({
    id: 'openrouter-chat',
    registrationOrder: 24,
    tier: 'llm',
    envVar: 'OPENROUTER_API_KEY',
    defaultModel: 'openai/gpt-5.6-terra',
    optionsSchema: webSearchOptions,
    display: {
      family: 'OpenRouter',
      name: 'OpenRouter Chat',
      description:
        'OpenRouter model answer with optional web search citations.',
      bestFor: 'Direct OpenRouter answers; web search is on by default.',
      setupUrl: 'https://openrouter.ai/docs/quickstart',
      order: 530,
    },
    metering: { kind: 'native_cost' },
    capabilities: inline('optional'),
  }),
] as const satisfies readonly ProviderDescriptorDefinition[];

export const BUILTIN_PROVIDER_DEFINITIONS_IN_REGISTRATION_ORDER = [
  ...BUILTIN_PROVIDER_DEFINITIONS,
].sort((a, b) => a.registrationOrder - b.registrationOrder);

export const BUILTIN_PROVIDER_DEFINITION_BY_ID = new Map(
  BUILTIN_PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export function getBuiltinProviderDefinition(
  id: string,
): ProviderDescriptorDefinition | undefined {
  return BUILTIN_PROVIDER_DEFINITION_BY_ID.get(id);
}

/** Return the descriptor-owned model identifier for a model-backed adapter. */
export function getBuiltinProviderDefaultModel(id: string): string {
  const model = getBuiltinProviderDefinition(id)?.defaultModel;
  if (!model) {
    throw new Error(`Built-in provider has no declared default model: ${id}`);
  }
  return model;
}
