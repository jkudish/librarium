import { PROVIDER_DISPLAY_NAMES, PROVIDER_ENV_VARS } from '../constants.js';
import type { ProviderTier } from '../types.js';

export interface ProviderCatalogEntry {
  id: string;
  family: string;
  displayName: string;
  envVar: string;
  tier: ProviderTier;
  description: string;
  bestFor: string;
  setupUrl: string;
  recommended?: boolean;
  order: number;
}

type ProviderCatalogInput = Omit<
  ProviderCatalogEntry,
  'displayName' | 'envVar'
>;

const entries: ProviderCatalogInput[] = [
  {
    id: 'brave-search',
    family: 'Brave',
    tier: 'raw-search',
    description: 'Fast raw web search from Brave’s independent index.',
    bestFor: 'Broad source discovery and a low-friction first provider.',
    setupUrl: 'https://brave.com/search/api/',
    recommended: true,
    order: 10,
  },
  {
    id: 'perplexity-sonar-pro',
    family: 'Perplexity',
    tier: 'ai-grounded',
    description: 'Grounded AI answers with citations through Sonar.',
    bestFor: 'Quick synthesized answers with source attribution.',
    setupUrl: 'https://docs.perplexity.ai/docs/getting-started/quickstart',
    recommended: true,
    order: 20,
  },
  {
    id: 'exa',
    family: 'Exa',
    tier: 'ai-grounded',
    description: 'AI-oriented web search for finding relevant pages quickly.',
    bestFor: 'Semantic source discovery and agentic web search.',
    setupUrl: 'https://exa.ai/docs/reference/getting-started',
    recommended: true,
    order: 30,
  },
  {
    id: 'tavily',
    family: 'Tavily',
    tier: 'raw-search',
    description: 'Search and extraction APIs designed for AI agents.',
    bestFor: 'Agent workflows that need focused search results.',
    setupUrl: 'https://docs.tavily.com/documentation/quickstart',
    recommended: true,
    order: 40,
  },
  {
    id: 'openai-research',
    family: 'OpenAI',
    tier: 'deep-research',
    description: 'OpenAI async research for slower, more thorough reports.',
    bestFor: 'Important questions where depth matters more than latency.',
    setupUrl: 'https://platform.openai.com/api-keys',
    order: 110,
  },
  {
    id: 'openai-chat',
    family: 'OpenAI',
    tier: 'llm',
    description: 'OpenAI model answer with optional web search citations.',
    bestFor: 'Direct OpenAI answers; web search is on by default.',
    setupUrl: 'https://platform.openai.com/api-keys',
    order: 510,
  },
  {
    id: 'gemini-grounded',
    family: 'Gemini',
    tier: 'ai-grounded',
    description: 'Gemini answers with Google-grounded search.',
    bestFor: 'Fast grounded answers from the Gemini ecosystem.',
    setupUrl: 'https://ai.google.dev/gemini-api/docs/api-key',
    order: 120,
  },
  {
    id: 'gemini-deep',
    family: 'Gemini',
    tier: 'deep-research',
    description: 'Gemini deep research for longer-running investigations.',
    bestFor: 'Deeper Gemini-backed research.',
    setupUrl: 'https://ai.google.dev/gemini-api/docs/api-key',
    order: 121,
  },
  {
    id: 'gemini-chat',
    family: 'Gemini',
    tier: 'llm',
    description: 'Gemini model answer with optional Google Search grounding.',
    bestFor: 'Direct Gemini answers; web search is on by default.',
    setupUrl: 'https://ai.google.dev/gemini-api/docs/api-key',
    order: 520,
  },
  {
    id: 'perplexity-sonar-deep',
    family: 'Perplexity',
    tier: 'deep-research',
    description: 'Perplexity Sonar deep research for comprehensive reports.',
    bestFor: 'Longer Perplexity research runs.',
    setupUrl: 'https://docs.perplexity.ai/docs/getting-started/quickstart',
    order: 130,
  },
  {
    id: 'perplexity-deep-research',
    family: 'Perplexity',
    tier: 'deep-research',
    description: 'Perplexity deep research using the dedicated research API.',
    bestFor: 'Deep Perplexity-backed reports.',
    setupUrl: 'https://docs.perplexity.ai/docs/getting-started/quickstart',
    order: 131,
  },
  {
    id: 'perplexity-advanced-deep',
    family: 'Perplexity',
    tier: 'deep-research',
    description: 'Higher-effort Perplexity deep research.',
    bestFor: 'More exhaustive Perplexity runs.',
    setupUrl: 'https://docs.perplexity.ai/docs/getting-started/quickstart',
    order: 132,
  },
  {
    id: 'perplexity-search',
    family: 'Perplexity',
    tier: 'raw-search',
    description: 'Perplexity search results without full AI synthesis.',
    bestFor: 'Fast Perplexity source discovery.',
    setupUrl: 'https://docs.perplexity.ai/docs/getting-started/quickstart',
    order: 133,
  },
  {
    id: 'brave-answers',
    family: 'Brave',
    tier: 'ai-grounded',
    description: 'Brave AI answers with web grounding.',
    bestFor: 'A Brave-backed synthesized answer layer.',
    setupUrl: 'https://brave.com/search/api/',
    order: 140,
  },
  {
    id: 'openrouter-online',
    family: 'OpenRouter',
    tier: 'ai-grounded',
    description: 'Online search through OpenRouter-compatible models.',
    bestFor: 'Using one OpenRouter account for online model access.',
    setupUrl: 'https://openrouter.ai/docs/quickstart',
    order: 150,
  },
  {
    id: 'grok',
    family: 'xAI',
    tier: 'ai-grounded',
    description: 'Grok Responses API answers grounded with xAI web search.',
    bestFor: 'Comparing Grok’s cited web-grounded answer visibility.',
    setupUrl: 'https://console.x.ai',
    order: 155,
  },
  {
    id: 'openrouter-chat',
    family: 'OpenRouter',
    tier: 'llm',
    description: 'OpenRouter model answer with optional web search citations.',
    bestFor: 'Direct OpenRouter answers; web search is on by default.',
    setupUrl: 'https://openrouter.ai/docs/quickstart',
    order: 530,
  },
  {
    id: 'you-research',
    family: 'You.com',
    tier: 'ai-grounded',
    description: 'You.com research API for real-time web intelligence.',
    bestFor: 'Cited research through You.com APIs.',
    setupUrl: 'https://you.com/docs/administration/api-keys',
    order: 160,
  },
  {
    id: 'kagi-fastgpt',
    family: 'Kagi',
    tier: 'ai-grounded',
    description: 'Kagi FastGPT answers backed by Kagi search.',
    bestFor: 'Kagi users who want premium search-backed answers.',
    setupUrl: 'https://help.kagi.com/kagi/api/fastgpt.html',
    order: 170,
  },
  {
    id: 'jina-search',
    family: 'Jina AI',
    tier: 'raw-search',
    description: 'Jina Search Foundation APIs for search-oriented retrieval.',
    bestFor: 'Search and reader workflows in the Jina ecosystem.',
    setupUrl: 'https://jina.ai/reader/',
    order: 180,
  },
  {
    id: 'firecrawl-search',
    family: 'Firecrawl',
    tier: 'raw-search',
    description: 'Firecrawl search for web search and extraction workflows.',
    bestFor: 'Search plus downstream scraping/extraction workflows.',
    setupUrl: 'https://docs.firecrawl.dev/api-reference/v2-introduction',
    order: 190,
  },
  {
    id: 'searchapi',
    family: 'SearchAPI',
    tier: 'raw-search',
    description: 'SERP scraping API for structured search results.',
    bestFor: 'Google-style SERP data and structured search output.',
    setupUrl: 'https://www.searchapi.io/',
    order: 200,
  },
  {
    id: 'serpapi',
    family: 'SerpApi',
    tier: 'raw-search',
    description: 'Real-time SERP API with structured search results.',
    bestFor: 'Search-engine result pages with rich structured data.',
    setupUrl: 'https://serpapi.com/users/sign_up',
    order: 210,
  },
  {
    id: 'claude',
    family: 'Anthropic',
    tier: 'llm',
    description: 'Claude model answer with optional web search citations.',
    bestFor: 'Direct Claude answers; web search is on by default.',
    setupUrl: 'https://platform.claude.com/docs',
    order: 500,
  },
];

export const PROVIDER_CATALOG: Record<string, ProviderCatalogEntry> =
  Object.fromEntries(
    entries.map((entry) => [
      entry.id,
      {
        ...entry,
        displayName: PROVIDER_DISPLAY_NAMES[entry.id] ?? entry.id,
        envVar: PROVIDER_ENV_VARS[entry.id] ?? '',
      },
    ]),
  );

export function getProviderCatalogEntry(
  id: string,
): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG[id];
}

export function sortedProviderCatalogEntries(
  ids?: Iterable<string>,
): ProviderCatalogEntry[] {
  const allowed = ids ? new Set(ids) : undefined;
  return Object.values(PROVIDER_CATALOG)
    .filter((entry) => !allowed || allowed.has(entry.id))
    .sort(
      (a, b) => a.order - b.order || a.displayName.localeCompare(b.displayName),
    );
}

export function recommendedProviderCatalogEntries(): ProviderCatalogEntry[] {
  return sortedProviderCatalogEntries().filter((entry) => entry.recommended);
}

export function providerTierLabel(tier: ProviderTier): string {
  switch (tier) {
    case 'deep-research':
      return 'Deep research';
    case 'ai-grounded':
      return 'Grounded answers';
    case 'raw-search':
      return 'Raw search';
    case 'llm':
      return 'LLM answers';
  }
}
