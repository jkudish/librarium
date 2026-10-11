import type {
  NormalizedBillableUnit,
  PriceDefinitionInput,
  PriceRate,
  PriceRateWindow,
  PricingCompleteness,
  PricingSnapshotInput,
} from './pricing.js';
import { validatePricingSnapshot } from './pricing.js';

/** Original review of every definition not re-checked since. */
const INITIAL_REVIEW_AT = '2026-08-27T00:00:00.000Z';
/** Re-check of the xAI and You.com definitions (#4769). */
const RECHECKED_AT = '2026-10-09T00:00:00.000Z';
/** Gemini Flash dated rate windows (#4851). */
const GEMINI_WINDOWS_AT = '2026-10-11T00:00:00.000Z';
/** New model defaults (#4855). */
const MODEL_DEFAULTS_AT = '2026-10-11T00:00:00.000Z';
/** Parallel processor and Valyu mode tiers (#4856). */
const RESEARCH_TIERS_AT = '2026-10-11T00:00:00.000Z';
/** The snapshot review time covers its most recently retrieved definition. */
const REVIEWED_AT = MODEL_DEFAULTS_AT;

interface DefinitionOptions {
  readonly target?: PriceDefinitionInput['effective_target'];
  readonly conditions?: PriceDefinitionInput['conditions'];
  readonly completeness?: PricingCompleteness;
  readonly expected: readonly NormalizedBillableUnit[];
  readonly fixed?: PriceDefinitionInput['fixed_quantities'];
  readonly rates?: readonly PriceRate[];
  readonly rateWindows?: readonly PriceRateWindow[];
  readonly missing?: readonly NormalizedBillableUnit[];
  readonly reason?: string;
  readonly reference: string;
  readonly fallback?: true;
  /** When the definition was last retrieved; defaults to the initial review. */
  readonly reviewedAt?: string;
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
    ...(options.rateWindows && { rate_windows: options.rateWindows }),
    ...(options.reason && { unknown_reason: options.reason }),
    provenance: {
      source_class: options.fallback
        ? 'frozen_reviewed_fallback'
        : 'frozen_official_snapshot',
      source_reference: options.reference,
      effective_at: options.reviewedAt ?? INITIAL_REVIEW_AT,
      retrieved_at: options.reviewedAt ?? INITIAL_REVIEW_AT,
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

// Source: https://ai.google.dev/gemini-api/docs/pricing (accessed 2026-10-11).
// Gemini 3.8 Flash, paid standard tier, per 1M tokens: introductory rates
// through 2026-12-31, doubled from 2027-01-01. Google states no timezone, so
// the boundary is 2027-01-01T00:00Z. Grounding with Google Search is $14 per 1k
// queries after a monthly free allowance, which is not modelled.
const GEMINI_FLASH_RATE_WINDOWS: readonly PriceRateWindow[] = [
  {
    effective_until: '2027-01-01T00:00:00.000Z',
    rates: [
      rate('uncached_input_tokens', '0.75', '1000000'),
      rate('output_tokens', '3.75', '1000000'),
      rate('cache_read_tokens', '0.075', '1000000'),
      rate('searches', '14', '1000'),
    ],
  },
  {
    effective_from: '2027-01-01T00:00:00.000Z',
    rates: [
      rate('uncached_input_tokens', '1.5', '1000000'),
      rate('output_tokens', '7.5', '1000000'),
      rate('cache_read_tokens', '0.15', '1000000'),
      rate('searches', '14', '1000'),
    ],
  },
];

const DEFINITIONS: readonly PriceDefinitionInput[] = [
  // Parallel
  // Source: https://docs.parallel.ai/getting-started/pricing (accessed
  // 2026-10-11). Task API price per 1k successful runs by processor; failed
  // runs are not billed. pro-fast and ultra-fast are no longer listed.
  ...(
    [
      ['lite', '5'],
      ['base', '10'],
      ['core', '25'],
      ['core2x', '50'],
      ['pro', '100'],
      ['ultra', '300'],
      ['ultra2x', '600'],
      ['ultra4x', '1200'],
      ['ultra8x', '2400'],
    ] as const
  ).map(([processor, perThousandUsd]) =>
    definition('parallel', 'research', {
      target: { kind: 'preset', target_id: processor },
      expected: ['processor_requests'],
      fixed: { processor_requests: '1' },
      rates: [rate('processor_requests', perThousandUsd, '1000')],
      reference: 'official:docs.parallel.ai/getting-started/pricing',
      reviewedAt: RESEARCH_TIERS_AT,
    }),
  ),
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
  // Source: https://developers.openai.com/api/docs/models/gpt-6.1-sol and
  // https://developers.openai.com/api/docs/pricing (accessed 2026-10-11).
  // Standard, per 1M tokens: $2 input, $0.10 cached, $2.50 cache writes, $10
  // output (reasoning bills as output). Web search is $10 per 1k calls. Prompts
  // over 272K input tokens bill at 2x input and 1.5x output.
  definition('openai-research', 'research', {
    target: { kind: 'model', target_id: 'gpt-6.1-sol' },
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
      rate('uncached_input_tokens', '2', '1000000'),
      rate('output_tokens', '10', '1000000'),
      rate('reasoning_tokens', '10', '1000000'),
      rate('cache_read_tokens', '0.1', '1000000'),
      rate('cache_write_tokens', '2.5', '1000000'),
      rate('searches', '10', '1000'),
    ],
    missing: ['openai:long_context_surcharge'],
    reason:
      'Long-context, processing-mode, and background lifecycle conditions are not bounded before completion.',
    reference: 'official:developers.openai.com/api/docs/models/gpt-6.1-sol',
    reviewedAt: MODEL_DEFAULTS_AT,
  }),
  // Source: https://developers.openai.com/api/docs/models/gpt-6-luna and
  // https://developers.openai.com/api/docs/pricing (accessed 2026-10-11).
  // Standard, per 1M tokens: $0.10 input, $0.01 cached, $0.125 cache writes,
  // $0.50 output (reasoning bills as output). Web search is $10 per 1k calls.
  // Prompts over 272K input tokens bill at 2x input and 1.5x output.
  definition('openai-chat', 'chat', {
    target: { kind: 'model', target_id: 'gpt-6-luna' },
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
      rate('uncached_input_tokens', '0.1', '1000000'),
      rate('output_tokens', '0.5', '1000000'),
      rate('reasoning_tokens', '0.5', '1000000'),
      rate('cache_read_tokens', '0.01', '1000000'),
      rate('cache_write_tokens', '0.125', '1000000'),
      rate('searches', '10', '1000'),
    ],
    missing: ['openai:long_context_surcharge'],
    reason:
      'The long-context surcharge for prompts over 272K input tokens is not bounded before completion.',
    reference: 'official:developers.openai.com/api/docs/models/gpt-6-luna',
    reviewedAt: MODEL_DEFAULTS_AT,
  }),

  // Gemini
  definition('gemini-grounded', 'grounded', {
    target: { kind: 'model', target_id: 'gemini-3.8-flash' },
    conditions: { account_plan: 'payg', billing_mode: 'standard' },
    expected: [...tokenUnits, 'cache_read_tokens', 'searches'],
    rateWindows: GEMINI_FLASH_RATE_WINDOWS,
    reference: 'official:ai.google.dev/gemini-api/docs/pricing',
    reviewedAt: MODEL_DEFAULTS_AT,
  }),
  unavailable(
    'gemini-deep',
    'research',
    [...tokenUnits, 'reasoning_tokens', 'searches'],
    quantitiesReason,
    'official:ai.google.dev/gemini-api/docs/deep-research',
  ),
  definition('gemini-chat', 'chat', {
    target: { kind: 'model', target_id: 'gemini-3.8-flash' },
    conditions: { account_plan: 'payg', billing_mode: 'standard' },
    expected: [...tokenUnits, 'cache_read_tokens', 'searches'],
    rateWindows: GEMINI_FLASH_RATE_WINDOWS,
    reference: 'official:ai.google.dev/gemini-api/docs/pricing',
    reviewedAt: GEMINI_WINDOWS_AT,
  }),

  // xAI
  // Source: https://docs.x.ai/developers/pricing and
  // https://docs.x.ai/developers/models/grok-4.7 (accessed 2026-10-11).
  // grok-4.7 below 200K context, per 1M tokens: $2 input, $0.50 cached, $6
  // output. Web search is $5 per 1k calls, so the web-only profile stays priced.
  definition('grok', 'web', {
    target: { kind: 'model', target_id: 'grok-4.7' },
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
    reviewedAt: MODEL_DEFAULTS_AT,
  }),
  // Source: https://docs.x.ai/developers/pricing (accessed 2026-10-11).
  // Since 2026-09-21 X Search bills per item fetched ($5 per 1k posts, $10 per
  // 1k profiles), including parent and quoted posts, and no request control
  // bounds that count. Any profile using x_search therefore has no bounded
  // price and must fail closed under a hard budget.
  ...[
    ['grok-x-only', 'x'],
    ['grok-combined', 'combined'],
  ].map(([providerId, profileId]) =>
    definition(providerId, profileId, {
      target: { kind: 'model', target_id: 'grok-4.7' },
      completeness: 'unavailable',
      expected: [
        ...tokenUnits,
        'cache_read_tokens',
        'reasoning_tokens',
        'xai:x_posts',
        'xai:x_profiles',
      ],
      missing: [
        ...tokenUnits,
        'cache_read_tokens',
        'reasoning_tokens',
        'xai:x_posts',
        'xai:x_profiles',
      ],
      reason:
        'X Search bills per post and profile fetched, and no request control bounds that count.',
      reference: 'official:docs.x.ai/developers/pricing',
      reviewedAt: MODEL_DEFAULTS_AT,
    }),
  ),

  // OpenRouter
  // Source: https://openrouter.ai/openai/gpt-6-luna (model listing via
  // https://openrouter.ai/api/v1/models) and
  // https://openrouter.ai/docs/guides/features/server-tools/web-search
  // (accessed 2026-10-11). openai/gpt-6-luna, per 1M tokens: $0.10 input,
  // $0.01 cache reads, $0.125 cache writes, $0.50 output; $0.20/$0.75 from
  // 272K prompt tokens. Both profiles pin the Exa engine by default: $7 per 1k
  // searches with up to 10 results each.
  ...(['grounded', 'chat'] as const).map((profileId) =>
    definition('openrouter', profileId, {
      target: { kind: 'model', target_id: 'openai/gpt-6-luna' },
      completeness: 'partial',
      expected: [
        ...tokenUnits,
        'cache_read_tokens',
        'cache_write_tokens',
        'reasoning_tokens',
        'searches',
        'openrouter:long_context_surcharge',
      ],
      rates: [
        rate('uncached_input_tokens', '0.1', '1000000'),
        rate('output_tokens', '0.5', '1000000'),
        rate('reasoning_tokens', '0.5', '1000000'),
        rate('cache_read_tokens', '0.01', '1000000'),
        rate('cache_write_tokens', '0.125', '1000000'),
        rate('searches', '7', '1000'),
      ],
      missing: ['openrouter:long_context_surcharge'],
      reason: `${routedReason} Rates are the listed price for the default model and Exa engine; prompts over 272K tokens bill higher.`,
      reference: 'official:openrouter.ai/openai/gpt-6-luna',
      reviewedAt: MODEL_DEFAULTS_AT,
    }),
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
  // Source: https://you.com/pricing (accessed 2026-10-09). Research API price
  // per 1k calls by research_effort: lite $12, standard $50, deep $100,
  // exhaustive $450, frontier $1,200 (background only).
  // The inline grounded profile always sends research_effort "standard".
  definition('you-research', 'grounded', {
    expected: ['research_requests'],
    fixed: { research_requests: '1' },
    rates: [rate('research_requests', '50', '1000')],
    reference: 'official:you.com/pricing',
    reviewedAt: RECHECKED_AT,
  }),
  ...(
    [
      ['lite', '12'],
      ['standard', '50'],
      ['deep', '100'],
      ['exhaustive', '450'],
      ['frontier', '1200'],
    ] as const
  ).map(([effort, perThousandUsd]) =>
    definition('you-research', 'research', {
      target: { kind: 'preset', target_id: effort },
      expected: ['research_requests'],
      fixed: { research_requests: '1' },
      rates: [rate('research_requests', perThousandUsd, '1000')],
      reference: 'official:you.com/pricing',
      reviewedAt: RECHECKED_AT,
    }),
  ),
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

  // SerpBase: credits are account-priced and are not USD.
  ...(['search', 'news'] as const).map((profileId) =>
    unavailable(
      'serpbase',
      profileId,
      ['credits'],
      accountReason,
      'official:serpbase.dev/docs',
      { credits: '1' },
    ),
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
  // Source: https://docs.valyu.ai/pricing (accessed 2026-10-11). DeepResearch
  // is a fixed price per task by mode. Optional tools add surcharges, but
  // Librarium never enables them, and PDF output is not a deliverable.
  ...(
    [
      ['fast', '0.1'],
      ['standard', '0.5'],
      ['heavy', '2.5'],
      ['max', '15'],
    ] as const
  ).map(([mode, usd]) =>
    definition('valyu', 'research', {
      target: { kind: 'preset', target_id: mode },
      expected: ['research_requests'],
      fixed: { research_requests: '1' },
      rates: [rate('research_requests', usd)],
      reference: 'official:docs.valyu.ai/pricing',
      reviewedAt: RESEARCH_TIERS_AT,
    }),
  ),

  // Anthropic
  // Source: https://platform.claude.com/docs/en/about-claude/pricing and
  // https://platform.claude.com/docs/en/models/sonnet-5-5/overview (accessed
  // 2026-10-11). Sonnet 5.5, per 1M tokens: $2 input, $10 output (thinking
  // bills as output), $2.50 5-minute cache writes, $0.10 cache reads. Web
  // search is $10 per 1k searches.
  definition('claude', 'chat', {
    target: { kind: 'model', target_id: 'claude-sonnet-5-5' },
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
      rate('cache_read_tokens', '0.1', '1000000'),
      rate('cache_write_tokens', '2.5', '1000000'),
    ],
    missing: ['searches'],
    reason:
      'Web search tool billing and cache lifetime must be observed explicitly.',
    reference: 'official:platform.claude.com/docs/en/about-claude/pricing',
    reviewedAt: MODEL_DEFAULTS_AT,
  }),
];

/**
 * Billing conditions Librarium's own adapter always meets, by `provider/profile`.
 * A lookup without configured conditions uses these, so a conditional
 * definition still prices the adapter's own requests. They are not part of the
 * snapshot or its fingerprint.
 *
 * Gemini: the adapters send standard (non-Batch) generateContent requests,
 * and Gemini 3 grounding requires a billing-enabled (pay-as-you-go) project.
 * The monthly free search allowance is not modelled, so a quote is an upper
 * bound for an account still inside it.
 */
const ADAPTER_PRICING_CONDITIONS: Readonly<
  Record<string, PriceDefinitionInput['conditions']>
> = {
  'gemini-grounded/grounded': {
    account_plan: 'payg',
    billing_mode: 'standard',
  },
  'gemini-chat/chat': { account_plan: 'payg', billing_mode: 'standard' },
};

export function adapterPricingConditions(identity: {
  readonly provider_id: string;
  readonly profile_id: string;
}): PriceDefinitionInput['conditions'] {
  return ADAPTER_PRICING_CONDITIONS[
    `${identity.provider_id}/${identity.profile_id}`
  ];
}

/**
 * The only runtime pricing source. It is reviewed, immutable, and network-free.
 * Update it only through the explicit local sync/review/freeze workflow.
 */
export const BUILTIN_PRICING_SNAPSHOT: PricingSnapshotInput =
  validatePricingSnapshot({
    schema_version: 1,
    version: '2026-10-11.v3',
    reviewed_at: REVIEWED_AT,
    currency: 'USD',
    fingerprint:
      'sha256:98894e5f129d8971df223e6a0778cbc2f2b9b165767fb1948df85c8bbfeddcfb',
    definitions: DEFINITIONS,
  });
