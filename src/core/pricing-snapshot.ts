import type {
  NormalizedBillableUnit,
  PriceDefinitionInput,
  PriceRate,
  PricingCompleteness,
  PricingSnapshotInput,
} from './pricing.js';
import { validatePricingSnapshot } from './pricing.js';

const REVIEWED_AT = '2026-08-27T00:00:00.000Z';

interface DefinitionOptions {
  readonly target?: PriceDefinitionInput['effective_target'];
  readonly conditions?: PriceDefinitionInput['conditions'];
  readonly completeness?: PricingCompleteness;
  readonly expected: readonly NormalizedBillableUnit[];
  readonly fixed?: PriceDefinitionInput['fixed_quantities'];
  readonly rates?: readonly PriceRate[];
  readonly missing?: readonly NormalizedBillableUnit[];
  readonly reason?: string;
  readonly reference: string;
  readonly fallback?: true;
}

function definition(
  providerId: string,
  profileId: string,
  options: DefinitionOptions,
): PriceDefinitionInput {
  return {
    id: `${providerId}.${profileId}.${options.target?.target_id ?? 'profile'}`,
    provider_id: providerId,
    profile_id: profileId,
    ...(options.target && { effective_target: options.target }),
    ...(options.conditions && { conditions: options.conditions }),
    currency: 'USD',
    completeness: options.completeness ?? 'complete',
    confidence:
      (options.completeness ?? 'complete') === 'unavailable'
        ? 'unknown'
        : options.fallback
          ? 'medium'
          : 'confirmed',
    expected_units: options.expected,
    ...(options.fixed && { fixed_quantities: options.fixed }),
    missing_units: options.missing ?? [],
    rates: options.rates ?? [],
    ...(options.reason && { unknown_reason: options.reason }),
    provenance: {
      source_class: options.fallback
        ? 'frozen_reviewed_fallback'
        : 'frozen_official_snapshot',
      source_reference: options.reference,
      effective_at: REVIEWED_AT,
      retrieved_at: REVIEWED_AT,
    },
  };
}

function unavailable(
  providerId: string,
  profileId: string,
  expected: readonly NormalizedBillableUnit[],
  reason: string,
  reference: string,
  fixed?: PriceDefinitionInput['fixed_quantities'],
): PriceDefinitionInput {
  return definition(providerId, profileId, {
    completeness: 'unavailable',
    expected,
    ...(fixed && { fixed }),
    missing: expected,
    reason,
    reference,
  });
}

function rate(
  unit: NormalizedBillableUnit,
  amountDecimal: string,
  perDecimal = '1',
): PriceRate {
  return {
    unit,
    amount_decimal: amountDecimal,
    per_decimal: perDecimal,
  };
}

const tokenUnits = [
  'uncached_input_tokens',
  'output_tokens',
] as const satisfies readonly NormalizedBillableUnit[];
const routedReason =
  'The effective routed model or provider endpoint determines the price.';
const accountReason =
  'The account plan or negotiated contract determines the USD rate.';
const quantitiesReason =
  'The provider controls one or more billable quantities before completion.';

const DEFINITIONS: readonly PriceDefinitionInput[] = [
  // Parallel
  definition('parallel', 'research', {
    target: { kind: 'preset', target_id: 'pro' },
    expected: ['processor_requests'],
    fixed: { processor_requests: '1' },
    rates: [rate('processor_requests', '0.1')],
    reference: 'official:docs.parallel.ai/getting-started/pricing',
  }),
  definition('parallel', 'chat', {
    target: { kind: 'model', target_id: 'base' },
    expected: ['requests'],
    fixed: { requests: '1' },
    rates: [rate('requests', '0.01')],
    reference: 'official:docs.parallel.ai/getting-started/pricing',
  }),
  unavailable(
    'parallel',
    'search',
    ['requests', 'results'],
    'Search mode and additional-result count change the price.',
    'official:docs.parallel.ai/getting-started/pricing',
    { requests: '1' },
  ),
  unavailable(
    'parallel',
    'turbo',
    ['requests', 'results'],
    'Additional-result count changes the turbo Search price.',
    'official:docs.parallel.ai/getting-started/pricing',
    { requests: '1' },
  ),

  // Perplexity
  unavailable(
    'perplexity-sonar-deep',
    'research',
    ['research_requests'],
    'Agent presets are dynamic and the completed request quantities are provider-controlled.',
    'official:docs.perplexity.ai/docs/getting-started/pricing',
  ),
  unavailable(
    'perplexity-deep-research',
    'research',
    ['research_requests'],
    'Agent presets are dynamic and the completed request quantities are provider-controlled.',
    'official:docs.perplexity.ai/docs/getting-started/pricing',
  ),
  unavailable(
    'perplexity-sonar-pro',
    'grounded',
    ['requests'],
    'Agent presets are dynamic and the completed request quantities are provider-controlled.',
    'official:docs.perplexity.ai/docs/getting-started/pricing',
  ),
  definition('perplexity-search', 'search', {
    expected: ['requests'],
    fixed: { requests: '1' },
    rates: [rate('requests', '5', '1000')],
    reference: 'official:docs.perplexity.ai/docs/getting-started/pricing',
  }),

  // OpenAI
  definition('openai-research', 'research', {
    target: { kind: 'model', target_id: 'gpt-5.6-sol' },
    completeness: 'partial',
    expected: [
      ...tokenUnits,
      'cache_read_tokens',
      'cache_write_tokens',
      'reasoning_tokens',
      'searches',
      'openai:long_context_surcharge',
    ],
    rates: [
      rate('uncached_input_tokens', '5', '1000000'),
      rate('output_tokens', '30', '1000000'),
      rate('reasoning_tokens', '30', '1000000'),
      rate('cache_read_tokens', '0.5', '1000000'),
      rate('cache_write_tokens', '6.25', '1000000'),
      rate('searches', '10', '1000'),
    ],
    missing: ['openai:long_context_surcharge'],
    reason:
      'Long-context, processing-mode, and background lifecycle conditions are not bounded before completion.',
    reference: 'official:developers.openai.com/api/docs/models/gpt-5.6-sol',
  }),
  unavailable(
    'openai-chat',
    'chat',
    [...tokenUnits, 'searches'],
    'The reviewed evidence did not freeze the exact current gpt-5-mini rate and tool conditions.',
    'official:openai.com/api/pricing',
  ),

  // Gemini
  definition('gemini-grounded', 'grounded', {
    target: { kind: 'model', target_id: 'gemini-2.5-flash' },
    conditions: { account_plan: 'payg', billing_mode: 'standard' },
    expected: [...tokenUnits, 'cache_read_tokens', 'searches'],
    rates: [
      rate('uncached_input_tokens', '0.3', '1000000'),
      rate('output_tokens', '2.5', '1000000'),
      rate('cache_read_tokens', '0.03', '1000000'),
      rate('searches', '35', '1000'),
    ],
    reference: 'official:ai.google.dev/gemini-api/docs/pricing',
  }),
  unavailable(
    'gemini-deep',
    'research',
    [...tokenUnits, 'reasoning_tokens', 'searches'],
    quantitiesReason,
    'official:ai.google.dev/gemini-api/docs/deep-research',
  ),
  definition('gemini-chat', 'chat', {
    target: { kind: 'model', target_id: 'gemini-3.6-flash' },
    conditions: { account_plan: 'payg', billing_mode: 'standard' },
    expected: [...tokenUnits, 'cache_read_tokens', 'searches'],
    rates: [
      rate('uncached_input_tokens', '1.5', '1000000'),
      rate('output_tokens', '9', '1000000'),
      rate('cache_read_tokens', '0.15', '1000000'),
      rate('searches', '14', '1000'),
    ],
    reference: 'official:ai.google.dev/gemini-api/docs/pricing',
  }),

  // xAI
  ...[
    ['grok', 'web'],
    ['grok-x-only', 'x'],
    ['grok-combined', 'combined'],
  ].map(([providerId, profileId]) =>
    definition(providerId, profileId, {
      target: { kind: 'model', target_id: 'grok-4.6' },
      expected: [
        ...tokenUnits,
        'cache_read_tokens',
        'reasoning_tokens',
        'searches',
      ],
      rates: [
        rate('uncached_input_tokens', '2', '1000000'),
        rate('output_tokens', '6', '1000000'),
        rate('reasoning_tokens', '6', '1000000'),
        rate('cache_read_tokens', '0.5', '1000000'),
        rate('searches', '5', '1000'),
      ],
      reference: 'official:docs.x.ai/developers/pricing',
    }),
  ),

  // OpenRouter
  unavailable(
    'openrouter',
    'grounded',
    [...tokenUnits, 'tool_calls'],
    routedReason,
    'official:openrouter.ai/docs/guides/routing/provider-selection',
  ),
  unavailable(
    'openrouter',
    'chat',
    [...tokenUnits, 'tool_calls'],
    routedReason,
    'official:openrouter.ai/docs/guides/routing/provider-selection',
  ),

  // Brave
  definition('brave-search', 'search', {
    expected: ['requests'],
    fixed: { requests: '1' },
    rates: [rate('requests', '5', '1000')],
    reference: 'official:brave.com/search/api',
  }),
  definition('brave-answers', 'grounded', {
    expected: [...tokenUnits, 'searches'],
    rates: [
      rate('uncached_input_tokens', '5', '1000000'),
      rate('output_tokens', '5', '1000000'),
      rate('searches', '4', '1000'),
    ],
    reference: 'official:brave.com/search/api',
  }),

  // You.com
  definition('you-research', 'grounded', {
    expected: ['research_requests'],
    fixed: { research_requests: '1' },
    rates: [rate('research_requests', '50', '1000')],
    reference: 'official:you.com/docs/administration/billing',
  }),
  definition('you-research', 'research', {
    expected: ['research_requests'],
    fixed: { research_requests: '1' },
    rates: [rate('research_requests', '50', '1000')],
    reference: 'official:you.com/docs/guides/research',
  }),
  unavailable(
    'you-answer',
    'grounded',
    ['requests'],
    'The current official inventory does not publish a stable Answer API rate matching this adapter.',
    'official:you.com/pricing',
    { requests: '1' },
  ),

  // Kagi
  definition('kagi-fastgpt', 'grounded', {
    expected: ['requests'],
    fixed: { requests: '1' },
    rates: [rate('requests', '0.015')],
    reference: 'official:help.kagi.com/kagi/api/fastgpt.html',
  }),

  // Exa
  definition('exa', 'search', {
    expected: ['requests', 'exa:content_pages'],
    fixed: { requests: '1', 'exa:content_pages': '10' },
    rates: [
      rate('requests', '7', '1000'),
      rate('exa:content_pages', '1', '1000'),
    ],
    reference: 'official:exa.ai/pricing',
  }),
  definition('exa', 'research', {
    expected: ['exa:agent_compute_units', 'searches'],
    rates: [rate('exa:agent_compute_units', '0.1'), rate('searches', '0.005')],
    reference: 'official:exa.ai/pricing',
  }),

  // Jina
  unavailable(
    'jina-search',
    'search',
    ['jina:tokens'],
    'Jina publishes token consumption but no stable public USD conversion.',
    'official:jina.ai/reader',
  ),

  // Firecrawl
  unavailable(
    'firecrawl-search',
    'search',
    ['credits'],
    accountReason,
    'official:firecrawl.dev/pricing',
    { credits: '2' },
  ),

  // SearchAPI: all prices are account-plan dependent.
  ...[
    ['searchapi', 'search', '1'],
    ['searchapi-chatgpt', 'surface', '1'],
    ['searchapi-gemini', 'surface', '1'],
    ['searchapi-perplexity', 'surface', '1'],
    ['searchapi-google-ai-mode', 'surface', '1'],
    ['searchapi-bing-copilot', 'surface', '1'],
    ['searchapi-google-ai-overview', 'surface', '2'],
  ].map(([providerId, profileId, requests]) =>
    unavailable(
      providerId,
      profileId,
      ['requests'],
      accountReason,
      'official:searchapi.io/pricing',
      { requests },
    ),
  ),

  // SerpApi
  unavailable(
    'serpapi',
    'search',
    ['requests'],
    accountReason,
    'official:serpapi.com/pricing',
    { requests: '1' },
  ),

  // Tavily
  definition('tavily', 'search', {
    conditions: { account_plan: 'payg' },
    expected: ['credits'],
    fixed: { credits: '2' },
    rates: [rate('credits', '0.008')],
    reference: 'official:tavily.com/pricing',
    fallback: true,
  }),

  // Valyu
  unavailable(
    'valyu',
    'search',
    ['results'],
    'Each returned result can have a different source-class price.',
    'official:docs.valyu.ai/pricing',
  ),
  definition('valyu', 'research', {
    target: { kind: 'preset', target_id: 'standard' },
    expected: ['research_requests'],
    fixed: { research_requests: '1' },
    rates: [rate('research_requests', '0.5')],
    reference: 'official:docs.valyu.ai/pricing',
  }),

  // Anthropic
  definition('claude', 'chat', {
    target: { kind: 'model', target_id: 'claude-sonnet-5' },
    completeness: 'partial',
    expected: [
      ...tokenUnits,
      'cache_read_tokens',
      'cache_write_tokens',
      'searches',
    ],
    rates: [
      rate('uncached_input_tokens', '2', '1000000'),
      rate('output_tokens', '10', '1000000'),
      rate('cache_read_tokens', '0.2', '1000000'),
      rate('cache_write_tokens', '2.5', '1000000'),
    ],
    missing: ['searches'],
    reason:
      'Web search tool billing and cache lifetime must be observed explicitly.',
    reference: 'official:platform.claude.com/docs/en/about-claude/pricing',
  }),
];

/**
 * The only runtime pricing source. It is reviewed, immutable, and network-free.
 * Update it only through the explicit local sync/review/freeze workflow.
 */
export const BUILTIN_PRICING_SNAPSHOT: PricingSnapshotInput =
  validatePricingSnapshot({
    schema_version: 1,
    version: '2026-08-27.v1',
    reviewed_at: REVIEWED_AT,
    currency: 'USD',
    fingerprint:
      'sha256:7d0bb6bf5049bb68bdf3c5836fd57eb2f6d73b262911e736f5d36cfb48019d5a',
    definitions: DEFINITIONS,
  });
