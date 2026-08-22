import { z } from 'zod';
import {
  grokCombinedOptionsSchema,
  grokWebOptionsSchema,
  grokXOnlyOptionsSchema,
} from '../adapters/grok-options.js';
import {
  ParallelChatOptionsSchema,
  ParallelResearchOptionsSchema,
  ParallelSearchOptionsSchema,
  ParallelTurboOptionsSchema,
} from '../adapters/parallel-options.js';
import { PerplexitySearchOptionsSchema } from '../adapters/perplexity-search-options.js';
import {
  ValyuResearchOptionsSchema,
  ValyuSearchOptionsSchema,
} from '../adapters/valyu-options.js';
import { YouAnswerOptionsSchema } from '../adapters/you-answer-options.js';
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
  /** Internal adapter ids bind public catalog profiles but are never selectors. */
  internal?: true;
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
export const commonOptions = z
  .object({
    perRequestUsd: positiveNumber.optional(),
    creditUsd: positiveNumber.optional(),
    creditsPerRequest: positiveNumber.optional(),
    perUnitUsd: positiveNumber.optional(),
  })
  .passthrough();
export const webSearchOptions = commonOptions.extend({
  webSearch: z.boolean().optional(),
});
export const openRouterOptions = webSearchOptions
  .extend({
    providerOrder: z.array(z.string().trim().min(1)).nonempty().optional(),
    allowFallbacks: z.boolean().optional(),
    requireParameters: z.boolean().optional(),
    dataCollection: z.enum(['allow', 'deny']).optional(),
    zdr: z.boolean().optional(),
    reasoningEffort: z
      .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
      .optional(),
    reasoningMaxTokens: z.number().int().positive().optional(),
    reasoningExclude: z.boolean().optional(),
  })
  .superRefine((options, ctx) => {
    if (
      options.reasoningEffort !== undefined &&
      options.reasoningMaxTokens !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['reasoningMaxTokens'],
        message:
          'reasoningEffort and reasoningMaxTokens are mutually exclusive',
      });
    }
    if (options.zdr === true && options.webSearch !== false) {
      ctx.addIssue({
        code: 'custom',
        path: ['zdr'],
        message:
          'zdr requires webSearch: false because OpenRouter ZDR does not apply to the web plugin',
      });
    }
  })
  .strict();
export const openRouterGroundedOptions = openRouterOptions.safeExtend({
  webSearch: z.literal(true).optional(),
});
export const openAiResearchOptions = commonOptions.extend({
  maxToolCalls: z.number().int().positive().optional(),
  reasoningEffort: z
    .enum(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    .optional(),
  returnTokenBudget: z.enum(['default', 'unlimited']).optional(),
});
export const claudeOptions = webSearchOptions.extend({
  maxTokens: z.number().int().positive().optional(),
  thinking: z.enum(['adaptive', 'disabled']).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});
export const firecrawlSearchOptions = commonOptions
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
export const parallelSearchOptions = commonOptions.merge(
  ParallelSearchOptionsSchema,
);
export const parallelTurboOptions = commonOptions.merge(
  ParallelTurboOptionsSchema,
);
export const parallelChatOptions = commonOptions.merge(
  ParallelChatOptionsSchema,
);
export const parallelResearchOptions = commonOptions.merge(
  ParallelResearchOptionsSchema,
);

const domain = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/,
  );
const nonEmptyDomains = z.array(domain).min(1).max(500);
const jsonObject = z.record(z.string(), z.unknown());
export const tavilyResearchOptions = commonOptions
  .extend({
    // `model` is reserved for the v1 target-selection field. This provider's
    // documented Research API model stays inside its strict option bag.
    researchModel: z.enum(['mini', 'pro', 'auto']).optional(),
    outputSchema: jsonObject
      .refine(
        (schema) => isPlainObject(schema.properties),
        'outputSchema must include a properties object',
      )
      .optional(),
    citationFormat: z.enum(['numbered', 'mla', 'apa', 'chicago']).optional(),
  })
  .strict();
export const exaResearchOptions = commonOptions
  .extend({
    effort: z
      .enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'auto', 'max'])
      .optional(),
    systemPrompt: z.string().trim().min(1).optional(),
    outputSchema: jsonObject
      .refine(
        (schema) => Object.keys(schema).length > 0,
        'outputSchema must be a non-empty object',
      )
      .optional(),
    maxCostDollars: z.number().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.maxCostDollars &&
      !['auto', 'max'].includes(value.effort ?? 'auto')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'maxCostDollars is supported only with effort "auto" or "max"',
      });
    }
  });
export const youResearchBackgroundOptions = commonOptions
  .extend({
    researchEffort: z
      .enum(['lite', 'standard', 'deep', 'exhaustive', 'frontier'])
      .optional(),
    outputSchema: jsonObject
      .refine(
        isValidYouOutputSchema,
        'outputSchema exceeds You.com structured output constraints',
      )
      .optional(),
    includeDomains: nonEmptyDomains.optional(),
    excludeDomains: nonEmptyDomains.optional(),
    boostDomains: nonEmptyDomains.optional(),
    freshness: z
      .string()
      .trim()
      .regex(/^(?:day|week|month|year|\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2})$/)
      .optional(),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.outputSchema && value.researchEffort === 'lite') {
      ctx.addIssue({
        code: 'custom',
        message: 'outputSchema is not supported with researchEffort "lite"',
      });
    }
    if (value.includeDomains && (value.excludeDomains || value.boostDomains)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'includeDomains cannot be combined with excludeDomains or boostDomains',
      });
    }
  });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidYouOutputSchema(root: Record<string, unknown>): boolean {
  let properties = 0;
  let enumValues = 0;
  let largeEnumStrings = 0;
  let schemaStrings = 0;
  const seen = new Set<object>();

  const visit = (value: unknown, depth: number): boolean => {
    if (!isPlainObject(value) || depth > 5 || seen.has(value)) return false;
    seen.add(value);
    if ('$ref' in value) return false;
    if (depth === 1 && ('anyOf' in value || value.type !== 'object'))
      return false;

    const objectSchema = value.type === 'object';
    if (objectSchema) {
      if (
        !isPlainObject(value.properties) ||
        value.additionalProperties !== false
      )
        return false;
      const keys = Object.keys(value.properties);
      const required = value.required;
      if (
        !Array.isArray(required) ||
        required.some((item) => typeof item !== 'string') ||
        required.length !== keys.length ||
        !keys.every((key) => required.includes(key))
      )
        return false;
      properties += keys.length;
      schemaStrings += keys.reduce((total, key) => total + key.length, 0);
      if (properties > 100) return false;
      for (const child of Object.values(value.properties)) {
        if (!visit(child, depth + 1)) return false;
      }
    }

    if (Array.isArray(value.enum)) {
      enumValues += value.enum.length;
      if (enumValues > 500) return false;
      const strings = value.enum.filter(
        (item): item is string => typeof item === 'string',
      );
      schemaStrings += strings.reduce((total, item) => total + item.length, 0);
      if (value.enum.length > 250)
        largeEnumStrings += strings.reduce(
          (total, item) => total + item.length,
          0,
        );
    }
    if (typeof value.const === 'string') schemaStrings += value.const.length;
    if (schemaStrings > 25_000 || largeEnumStrings > 7_500) return false;

    if (value.type === 'null') return false;
    if (value.items !== undefined && !visit(value.items, depth + 1))
      return false;
    if (Array.isArray(value.anyOf)) {
      for (const branch of value.anyOf)
        if (!visit(branch, depth + 1)) return false;
    }
    return true;
  };

  return visit(root, 1);
}

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
    id: 'parallel-research',
    registrationOrder: 5.5,
    tier: 'deep-research',
    envVar: 'PARALLEL_API_KEY',
    defaultModel: 'pro',
    optionsSchema: parallelResearchOptions,
    display: {
      family: 'Parallel',
      name: 'Parallel Research',
      description: 'Durable Parallel Task API research with research basis.',
      bestFor: 'First-party long-running Parallel research tasks.',
      setupUrl: 'https://docs.parallel.ai/',
      order: 145,
    },
    metering: { kind: 'api_unit_priced', unit: 'processor request' },
    capabilities: background(),
    autoEnable: false,
  }),
  define({
    id: 'parallel-chat',
    registrationOrder: 20.5,
    tier: 'ai-grounded',
    envVar: 'PARALLEL_API_KEY',
    defaultModel: 'base',
    optionsSchema: parallelChatOptions,
    display: {
      family: 'Parallel',
      name: 'Parallel Chat',
      description:
        'Parallel Chat API answers with model-dependent research basis.',
      bestFor: 'First-party Parallel chat and structured output.',
      setupUrl: 'https://docs.parallel.ai/chat-api/chat-quickstart',
      order: 285,
    },
    metering: { kind: 'api_unit_priced', unit: 'request' },
    capabilities: inline('always'),
    autoEnable: false,
  }),
  define({
    id: 'parallel-search',
    registrationOrder: 24.5,
    tier: 'raw-search',
    envVar: 'PARALLEL_API_KEY',
    optionsSchema: parallelSearchOptions,
    display: {
      family: 'Parallel',
      name: 'Parallel Search',
      description: 'Ranked Parallel web results and LLM-optimized excerpts.',
      bestFor: 'First-party ranked web evidence without answer synthesis.',
      setupUrl: 'https://docs.parallel.ai/search/search-quickstart',
      order: 295,
    },
    metering: { kind: 'api_unit_priced', unit: 'request' },
    capabilities: inline('always'),
    autoEnable: false,
  }),
  define({
    id: 'parallel-turbo',
    registrationOrder: 24.6,
    tier: 'raw-search',
    envVar: 'PARALLEL_API_KEY',
    optionsSchema: parallelTurboOptions,
    display: {
      family: 'Parallel',
      name: 'Parallel Turbo',
      description:
        'Parallel Search API turbo mode for lowest-latency ranked excerpts.',
      bestFor: 'High-volume grounding where latency and cost matter most.',
      setupUrl: 'https://docs.parallel.ai/search/modes',
      order: 296,
    },
    metering: { kind: 'api_unit_priced', unit: 'request' },
    capabilities: inline('always'),
    autoEnable: false,
  }),
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
    defaultModel: 'low',
    display: {
      family: 'Perplexity',
      name: 'Perplexity Sonar Pro',
      description: 'Grounded AI answers with citations through the Agent API.',
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
    id: 'exa-research',
    internal: true,
    registrationOrder: 32,
    tier: 'deep-research',
    envVar: 'EXA_API_KEY',
    optionsSchema: exaResearchOptions,
    display: {
      family: 'Exa',
      name: 'Exa Research Adapter',
      description:
        'Internal durable Exa Agent adapter for the Exa research profile.',
      bestFor: 'Canonical Exa research profile execution.',
      setupUrl: 'https://exa.ai/docs/reference/agent-api/create-a-run',
      order: 30,
    },
    metering: { kind: 'native_cost' },
    capabilities: background(),
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
    id: 'tavily-research',
    internal: true,
    registrationOrder: 33,
    tier: 'deep-research',
    envVar: 'TAVILY_API_KEY',
    optionsSchema: tavilyResearchOptions,
    display: {
      family: 'Tavily',
      name: 'Tavily Research Adapter',
      description:
        'Internal durable Tavily Research adapter for the Tavily research profile.',
      bestFor: 'Canonical Tavily research profile execution.',
      setupUrl:
        'https://docs.tavily.com/documentation/api-reference/endpoint/research',
      order: 40,
    },
    metering: { kind: 'credit_priced', unit: 'credit' },
    capabilities: background(),
  }),
  define({
    id: 'valyu-search',
    registrationOrder: 35,
    tier: 'raw-search',
    envVar: 'VALYU_API_KEY',
    optionsSchema: ValyuSearchOptionsSchema,
    display: {
      family: 'Valyu',
      name: 'Valyu Search',
      description: 'First-party web and specialized-data search from Valyu.',
      bestFor: 'Source discovery across web, news, and specialized datasets.',
      setupUrl: 'https://platform.valyu.ai',
      order: 41,
    },
    metering: { kind: 'native_cost' },
    capabilities: inline('always'),
  }),
  define({
    id: 'valyu-research',
    registrationOrder: 36,
    tier: 'deep-research',
    envVar: 'VALYU_API_KEY',
    optionsSchema: ValyuResearchOptionsSchema,
    display: {
      family: 'Valyu',
      name: 'Valyu DeepResearch',
      description: 'Durable first-party Valyu multi-source research reports.',
      bestFor: 'Long-running cited research across web and specialized data.',
      setupUrl: 'https://platform.valyu.ai',
      order: 111,
    },
    metering: { kind: 'native_cost' },
    capabilities: background(),
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
    defaultModel: 'high',
    display: {
      family: 'Perplexity',
      name: 'Perplexity Sonar Deep Research',
      description: 'Durable high-effort Perplexity Agent research.',
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
    defaultModel: 'medium',
    display: {
      family: 'Perplexity',
      name: 'Perplexity Deep Research',
      description: 'Durable medium-effort Perplexity Agent research.',
      bestFor: 'Deep Perplexity-backed reports.',
      setupUrl: 'https://docs.perplexity.ai/docs/getting-started/quickstart',
      order: 131,
    },
    metering: { kind: 'native_cost' },
    capabilities: background(),
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
    envVar: 'BRAVE_ANSWERS_API_KEY',
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
    optionsSchema: openRouterGroundedOptions,
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
    id: 'you-answer',
    registrationOrder: 12.5,
    tier: 'ai-grounded',
    envVar: 'YOU_COM_API_KEY',
    autoEnable: false,
    optionsSchema: YouAnswerOptionsSchema,
    display: {
      family: 'You.com',
      name: 'You.com Answer',
      description:
        'One-request You.com web-grounded answers with provider citations.',
      bestFor: 'Explicit, focused web-grounded answers with cited evidence.',
      setupUrl: 'https://you.com/docs/guides/answer',
      order: 165,
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
    id: 'you-research-background',
    internal: true,
    registrationOrder: 34,
    tier: 'deep-research',
    envVar: 'YOU_COM_API_KEY',
    optionsSchema: youResearchBackgroundOptions,
    display: {
      family: 'You.com',
      name: 'You.com Research Background Adapter',
      description:
        'Internal durable You.com Research adapter for the You.com research profile.',
      bestFor: 'Canonical You.com research profile execution.',
      setupUrl: 'https://you.com/docs/api-reference/research/v1-research',
      order: 160,
    },
    metering: { kind: 'manual_unmetered' },
    capabilities: background(),
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
    optionsSchema: openRouterOptions,
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
