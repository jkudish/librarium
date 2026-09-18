import { resolveProviderId } from '../constants.js';
import type {
  CostConfidence,
  MeteringActual,
  MeteringEstimate,
  MeteringKind,
  ProviderMetering,
  ProviderUsage,
} from '../types.js';
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  type ProviderMeteringDescriptor,
} from './provider-descriptor.js';

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
export const PRICING_VERSION = '2026-08';

/**
 * Per-provider capability table derived from the built-in descriptors.
 *
 * Default USD figures are deliberately conservative estimates of common
 * lower-volume plan pricing as of PRICING_VERSION; they are starting points,
 * not contractual rates. Users on other plans should override via provider
 * `options` (see readPricingOverride).
 */
const REGISTRY: Record<string, ProviderMeteringDescriptor> = Object.fromEntries(
  BUILTIN_PROVIDER_DEFINITIONS.filter(({ internal }) => internal !== true).map(
    ({ id, metering }) => [id, metering],
  ),
);

/** Capability for unregistered/custom providers: no reliable per-call metering. */
const UNMETERED: ProviderMeteringDescriptor = { kind: 'manual_unmetered' };

/** Look up a provider's static metering capability (kind + pricing shape). */
function getCapability(providerId: string): ProviderMeteringDescriptor {
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
    const units =
      cap.kind === 'request_priced' ? (cap.defaultUnitsPerRequest ?? 1) : 1;
    const confidence: CostConfidence =
      override.perRequestUsd !== undefined ? 'configured' : 'estimated';
    const estimate: MeteringEstimate = {
      billableUnits: units,
      unit: cap.unit ?? 'request',
      costConfidence: perRequest !== undefined ? confidence : 'unknown',
      pricingVersion: PRICING_VERSION,
    };
    if (perRequest !== undefined) {
      estimate.estimatedCostUsd = perRequest * units;
    }
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
 * Build the actual lane from provider-reported usage. usage.costUsd and
 * billableUnits are only ever set by adapters from real API response fields.
 */
function actualFromUsage(usage?: ProviderUsage): MeteringActual | undefined {
  const costUsd =
    usage?.costUsd !== undefined &&
    Number.isFinite(usage.costUsd) &&
    usage.costUsd >= 0
      ? usage.costUsd
      : undefined;
  const billableUnits =
    usage?.billableUnits !== undefined &&
    Number.isFinite(usage.billableUnits) &&
    usage.billableUnits >= 0
      ? usage.billableUnits
      : undefined;
  if (costUsd === undefined && billableUnits === undefined) return undefined;
  const actual: MeteringActual = { source: 'provider_reported' };
  if (costUsd !== undefined) actual.costUsd = costUsd;
  if (billableUnits !== undefined) actual.billableUnits = billableUnits;
  return actual;
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
