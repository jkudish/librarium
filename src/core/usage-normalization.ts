import type { ProviderIdentity } from '../contracts/domain/index.js';
import type { ProviderResult, ProviderUsage } from '../types.js';
import { roundUpDecimal } from './budget.js';
import {
  PricingCatalog,
  PricingCatalogError,
  type PricingQuote,
} from './pricing.js';
import {
  adapterPricingConditions,
  BUILTIN_PRICING_SNAPSHOT,
} from './pricing-snapshot.js';

/**
 * Normalize adapter usage for canonical execution and historical readers.
 * Rich usage wins; otherwise lift the legacy token pair.
 */
export function normalizeUsage(
  result: Pick<ProviderResult, 'usage' | 'tokenUsage'>,
): ProviderUsage | undefined {
  if (result.usage) return stripUndefinedUsage(result.usage);
  const tokens = result.tokenUsage;
  if (!tokens || (tokens.input === undefined && tokens.output === undefined)) {
    return undefined;
  }
  const usage: ProviderUsage = {};
  if (tokens.input !== undefined) usage.inputTokens = tokens.input;
  if (tokens.output !== undefined) usage.outputTokens = tokens.output;
  if (tokens.input !== undefined && tokens.output !== undefined) {
    usage.totalTokens = tokens.input + tokens.output;
  }
  return usage;
}

function stripUndefinedUsage(usage: ProviderUsage): ProviderUsage {
  const clean: ProviderUsage = {};
  for (const [key, value] of Object.entries(usage)) {
    if (value !== undefined) {
      (clean as Record<string, unknown>)[key] = value;
    }
  }
  return clean;
}

let builtinCatalog: PricingCatalog | undefined;

/** Pricing every quantity the snapshot can, from what the provider reported. */
export interface ReportedUsageQuote {
  readonly status: PricingQuote['status'];
  /** The exact estimate; present only when the quote is complete. */
  readonly amount_usd?: string;
  /** What the priced quantities cost; a lower bound when partial. */
  readonly known_minimum_usd: string;
  readonly missing_units: readonly string[];
  readonly snapshot_version: string;
  readonly priced_at: string;
}

/**
 * Price provider-reported quantities with the built-in, date-aware snapshot.
 * The definition's fixed quantities fill in what the provider does not report
 * (one Parallel processor run, for example). Returns undefined when nothing
 * could be priced. A result is an estimate, never an actual cost.
 */
export function quoteProviderReportedUsage(
  identity: ProviderIdentity,
  quantities: Readonly<Record<string, number>> | undefined,
  pricedAt: string,
): ReportedUsageQuote | undefined {
  builtinCatalog ??= new PricingCatalog(BUILTIN_PRICING_SNAPSHOT);
  const conditions = adapterPricingConditions(identity);
  let quote: PricingQuote;
  try {
    quote = builtinCatalog.quote({
      requested_identity: identity,
      ...(conditions && { conditions }),
      quantities: Object.fromEntries(
        Object.entries(quantities ?? {}).map(([unit, quantity]) => [
          unit,
          String(quantity),
        ]),
      ),
      quantity_source: 'provider_reported',
      priced_at: pricedAt,
    });
  } catch (error) {
    if (error instanceof PricingCatalogError) return undefined;
    throw error;
  }
  if (
    quote.currency !== 'USD' ||
    quote.known_minimum_decimal === undefined ||
    quote.status === 'unavailable'
  ) {
    return undefined;
  }
  return {
    status: quote.status,
    ...(quote.status === 'complete' && {
      amount_usd: roundUpDecimal(quote.known_minimum_decimal, 18),
    }),
    known_minimum_usd: roundUpDecimal(quote.known_minimum_decimal, 18),
    missing_units: [...quote.missing_units],
    snapshot_version: quote.snapshot_version,
    priced_at: pricedAt,
  };
}
