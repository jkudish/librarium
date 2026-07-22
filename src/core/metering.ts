import { resolveProviderId } from '../constants.js';
import type {
  CostConfidence,
  MeteringActual,
  MeteringEstimate,
  MeteringKind,
  ProviderMetering,
  ProviderUsage,
} from '../types.js';

/**
 * Provider metering capability registry.
 *
 * A single source of truth for HOW each provider is priced, so consumers can
 * tell — before a call runs and without any network request — whether a
 * provider reports native cost, reports tokens only, is priced per request, per
 * credit, per API unit, or is simply unmetered.
 *
 * Honesty contract (mirrors src/types.ts ProviderUsage):
 *  - Estimates here are NEVER facts. They are stamped with a `costConfidence`
 *    of 'estimated' (built-in default snapshot) or 'configured' (user-supplied
 *    pricing in provider options) and a `pricingVersion`, and they never touch
 *    ProviderUsage.costUsd.
 *  - Plan-dependent providers (credits, API units) do NOT emit a default USD
 *    figure — only unit metadata — so we never invent precision the user's plan
 *    doesn't support. A USD estimate appears only once the user configures a
 *    price.
 */

/** Pricing snapshot tag for the built-in default estimates below. */
export const PRICING_VERSION = '2026-07';

interface MeteringCapability {
  kind: MeteringKind;
  /**
   * Built-in per-request estimate (USD) for request-priced providers, or a
   * documented baseline for native-token providers with extra tool-call fees.
   * Plan-dependent rates are omitted so the estimate carries unit metadata
   * without a misleading dollar figure.
   */
  defaultPerRequestUsd?: number;
  /** Default billable units consumed per request (credit_priced/api_unit). */
  defaultUnitsPerRequest?: number;
  /** Unit the estimate is denominated in: 'request' | 'credit' | 'token'. */
  unit?: string;
}

/**
 * Per-provider capability table. Keys are canonical provider ids.
 *
 * Default USD figures are deliberately conservative estimates of common
 * lower-volume plan pricing as of PRICING_VERSION; they are starting points,
 * not contractual rates. Users on other plans should override via provider
 * `options` (see readPricingOverride).
 */
const REGISTRY: Record<string, MeteringCapability> = {
  // Deep research — Perplexity returns native cost in the usage block.
  'perplexity-sonar-deep': { kind: 'native_cost' },
  'perplexity-deep-research': { kind: 'native_cost' },
  'perplexity-advanced-deep': { kind: 'native_cost' },
  // Token-metered deep research (no cost in the API response).
  'openai-deep': { kind: 'native_tokens' },
  'openai-deep-o3': { kind: 'native_tokens' },
  'gemini-deep': { kind: 'native_tokens' },

  // AI-grounded.
  'perplexity-sonar-pro': { kind: 'native_cost' },
  'gemini-grounded': { kind: 'native_tokens' },
  // xAI reports tokens plus an actual dollar total (cost_in_usd_ticks), which
  // the adapter surfaces as reported costUsd. Kind stays native_tokens so the
  // pre-dispatch estimate (a baseline Grok 4.5 request with one web search)
  // keeps powering --max-estimated-cost reservations.
  grok: {
    kind: 'native_tokens',
    defaultPerRequestUsd: 0.015,
    unit: 'request',
  },
  'openrouter-online': { kind: 'native_cost' },
  exa: { kind: 'native_cost' },
  // Brave AI Answers — billed for searches and input/output tokens. The
  // billable mix is only known after the API returns its usage headers, so no
  // pre-dispatch USD estimate would be honest.
  'brave-answers': {
    kind: 'api_unit_priced',
    unit: 'search + token',
  },
  // You.com — priced per query, plan-dependent: units only, no default USD.
  'you-research': {
    kind: 'credit_priced',
    defaultUnitsPerRequest: 1,
    unit: 'query',
  },
  // Kagi FastGPT — published flat $0.015 per call.
  'kagi-fastgpt': {
    kind: 'request_priced',
    defaultPerRequestUsd: 0.015,
    unit: 'request',
  },

  // Raw search.
  // Perplexity search — request-priced but plan-dependent: no default USD.
  'perplexity-search': { kind: 'request_priced', unit: 'request' },
  'brave-search': {
    kind: 'request_priced',
    defaultPerRequestUsd: 0.005,
    unit: 'request',
  },
  // Jina — token/API-unit priced; billable size known only post-call.
  'jina-search': { kind: 'api_unit_priced', unit: 'token' },
  // Firecrawl — credit-priced, plan-dependent: units only, no default USD.
  'firecrawl-search': {
    kind: 'credit_priced',
    defaultUnitsPerRequest: 1,
    unit: 'credit',
  },
  searchapi: {
    kind: 'request_priced',
    defaultPerRequestUsd: 0.004,
    unit: 'request',
  },
  serpapi: {
    kind: 'request_priced',
    defaultPerRequestUsd: 0.015,
    unit: 'request',
  },
  // Tavily — credit-priced; advanced search consumes 2 credits.
  tavily: { kind: 'credit_priced', defaultUnitsPerRequest: 2, unit: 'credit' },

  // Ungrounded LLMs — token-metered, no cost in the response.
  claude: { kind: 'native_tokens' },
  'openai-chat': { kind: 'native_tokens' },
  'gemini-chat': { kind: 'native_tokens' },
  // OpenRouter returns native cost in its usage block.
  'openrouter-chat': { kind: 'native_cost' },
};

/** Capability for unregistered/custom providers: no reliable per-call metering. */
const UNMETERED: MeteringCapability = { kind: 'manual_unmetered' };

/** Look up a provider's static metering capability (kind + pricing shape). */
function getCapability(providerId: string): MeteringCapability {
  return REGISTRY[resolveProviderId(providerId)] ?? UNMETERED;
}

/** Public: the metering kind for a provider id (manual_unmetered if unknown). */
export function getMeteringKind(providerId: string): MeteringKind {
  return getCapability(providerId).kind;
}

/** Canonical provider ids that have a registry entry. */
export function meteredProviderIds(): string[] {
  return Object.keys(REGISTRY);
}

/** Coerce an unknown options value to a finite positive number, else undefined. */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

interface ProviderPricingConfig {
  options?: Record<string, unknown>;
}

/**
 * User-supplied pricing overrides from provider config `options`:
 *  - perRequestUsd: flat USD per request (request_priced)
 *  - creditUsd + (creditsPerRequest | capability default): USD per credit
 */
function readPricingOverride(config?: ProviderPricingConfig): {
  perRequestUsd?: number;
  creditUsd?: number;
  unitsPerRequest?: number;
} {
  const options = config?.options ?? {};
  return {
    perRequestUsd: positiveNumber(options.perRequestUsd),
    creditUsd: positiveNumber(options.creditUsd),
    unitsPerRequest: positiveNumber(options.creditsPerRequest),
  };
}

/**
 * Network-free pre-dispatch cost estimate for a provider. Returns undefined for
 * kinds whose cost is only known from the API response (native_cost), native
 * token providers without a documented baseline, and manual_unmetered providers.
 */
export function estimateMetering(
  providerId: string,
  config?: ProviderPricingConfig,
): MeteringEstimate | undefined {
  const cap = getCapability(providerId);
  const override = readPricingOverride(config);

  if (
    cap.kind === 'request_priced' ||
    (cap.kind === 'native_tokens' && cap.defaultPerRequestUsd !== undefined)
  ) {
    const perRequest = override.perRequestUsd ?? cap.defaultPerRequestUsd;
    const confidence: CostConfidence =
      override.perRequestUsd !== undefined ? 'configured' : 'estimated';
    const estimate: MeteringEstimate = {
      billableUnits: 1,
      unit: cap.unit ?? 'request',
      costConfidence: perRequest !== undefined ? confidence : 'unknown',
      pricingVersion: PRICING_VERSION,
    };
    if (perRequest !== undefined) estimate.estimatedCostUsd = perRequest;
    return estimate;
  }

  if (cap.kind === 'credit_priced') {
    const units = override.unitsPerRequest ?? cap.defaultUnitsPerRequest;
    const estimate: MeteringEstimate = {
      unit: cap.unit ?? 'credit',
      costConfidence: 'estimated',
      pricingVersion: PRICING_VERSION,
    };
    if (units !== undefined) estimate.billableUnits = units;
    // A USD figure appears only when the user configures a per-credit price;
    // plan-dependent credits never get an invented default dollar amount.
    if (override.creditUsd !== undefined && units !== undefined) {
      estimate.estimatedCostUsd = override.creditUsd * units;
      estimate.costConfidence = 'configured';
    }
    return estimate;
  }

  if (cap.kind === 'api_unit_priced') {
    // Billable size (tokens/rows) is unknown before the call. Surface the unit
    // and confidence without a fabricated dollar amount.
    const perUnit = positiveNumber(config?.options?.perUnitUsd);
    const estimate: MeteringEstimate = {
      unit: cap.unit ?? 'unit',
      costConfidence: perUnit !== undefined ? 'configured' : 'estimated',
      pricingVersion: PRICING_VERSION,
    };
    return estimate;
  }

  // native_cost, native_tokens without a baseline, manual_unmetered: no estimate.
  return undefined;
}

/**
 * Build the actual-cost lane from reported usage. usage.costUsd is only ever set
 * by an adapter from a real API figure, so its presence means provider_reported.
 */
function actualFromUsage(usage?: ProviderUsage): MeteringActual | undefined {
  if (
    usage?.costUsd !== undefined &&
    Number.isFinite(usage.costUsd) &&
    usage.costUsd >= 0
  ) {
    return { costUsd: usage.costUsd, source: 'provider_reported' };
  }
  return undefined;
}

/**
 * Assemble the full ProviderMetering for a provider: static kind, a network-free
 * estimate, and (when a result is in hand) the actual cost lane. This is the
 * single normalization path shared by sync dispatch, fallback, and async
 * retrieval so every surface attaches metering identically.
 */
export function buildProviderMetering(
  providerId: string,
  config?: ProviderPricingConfig,
  usage?: ProviderUsage,
): ProviderMetering {
  const cap = getCapability(providerId);
  const metering: ProviderMetering = { kind: cap.kind };
  const estimate = estimateMetering(providerId, config);
  if (estimate) {
    metering.estimate = estimate;
    if (estimate.pricingVersion)
      metering.pricingVersion = estimate.pricingVersion;
  }
  const actual = actualFromUsage(usage);
  if (actual) metering.actual = actual;
  return metering;
}
