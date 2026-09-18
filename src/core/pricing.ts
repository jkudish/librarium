import type {
  ProviderIdentity,
  TargetKind,
} from '../contracts/domain/index.js';
import {
  canonicalJson,
  compareCanonicalStrings,
} from './catalog-fingerprint.js';

export const PRICING_SNAPSHOT_SCHEMA_VERSION = 1;
export const PRICING_SNAPSHOT_FINGERPRINT_ALGORITHM = 'sha256';

const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PROVIDER_UNIT_PATTERN = /^[a-z][a-z0-9-]{0,62}:[a-z][a-z0-9_]{0,62}$/;
const SOURCE_REFERENCE_PATTERN =
  /^(?:official|reviewed|configured|provider):[a-z0-9.-]+(?:\/[a-z0-9._~/-]+)*$/;
const UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const MAX_PRICE_DEFINITIONS = 4096;
const MAX_DEFINITION_UNITS = 64;
const COMPLETENESS_VALUES = new Set(['complete', 'partial', 'unavailable']);
const CONFIDENCE_VALUES = new Set(['confirmed', 'high', 'medium', 'unknown']);
const SOURCE_CLASS_VALUES = new Set([
  'configured_account_rate',
  'frozen_official_snapshot',
  'frozen_reviewed_fallback',
]);
const TARGET_KIND_VALUES = new Set(['model', 'agent', 'preset']);

export const NORMALIZED_BILLABLE_UNITS = [
  'uncached_input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'requests',
  'searches',
  'tool_calls',
  'images',
  'audio_seconds',
  'rows',
  'results',
  'credits',
  'processor_requests',
  'research_requests',
] as const;

export type NormalizedBillableUnit =
  | (typeof NORMALIZED_BILLABLE_UNITS)[number]
  | `${string}:${string}`;
export type PricingCompleteness = 'complete' | 'partial' | 'unavailable';
export type PricingConfidence = 'confirmed' | 'high' | 'medium' | 'unknown';
export type PricingSourceClass =
  | 'provider_reported_actual'
  | 'configured_account_rate'
  | 'frozen_official_snapshot'
  | 'frozen_reviewed_fallback'
  | 'unknown';
export type ComputedActualSource =
  | 'computed_from_tokens'
  | 'computed_from_request'
  | 'computed_from_credits';

export interface PricingConditions {
  readonly account_plan?: string;
  readonly region?: string;
  readonly billing_mode?: string;
  readonly tool_mode?: string;
  readonly research_mode?: string;
  readonly [condition: string]: string | undefined;
}

export interface EffectivePricingIdentity {
  readonly provider_id: string;
  readonly kind?: TargetKind;
  readonly target_id?: string;
}

export interface PriceRate {
  readonly unit: NormalizedBillableUnit;
  readonly amount_decimal: string;
  readonly per_decimal: string;
}

export interface PricingProvenanceInput {
  readonly source_class:
    | 'configured_account_rate'
    | 'frozen_official_snapshot'
    | 'frozen_reviewed_fallback';
  readonly source_reference: string;
  readonly effective_at: string;
  readonly retrieved_at: string;
}

export interface PriceDefinitionInput {
  readonly id: string;
  readonly provider_id: string;
  readonly profile_id: string;
  readonly effective_target?: {
    readonly provider_id?: string;
    readonly kind: TargetKind;
    readonly target_id: string;
  };
  readonly conditions?: PricingConditions;
  readonly currency: string;
  readonly completeness: PricingCompleteness;
  readonly confidence: PricingConfidence;
  readonly expected_units: readonly NormalizedBillableUnit[];
  readonly fixed_quantities?: Readonly<
    Partial<Record<NormalizedBillableUnit, string>>
  >;
  readonly missing_units: readonly NormalizedBillableUnit[];
  readonly rates: readonly PriceRate[];
  readonly unknown_reason?: string;
  readonly provenance: PricingProvenanceInput;
}

export interface PricingSnapshotInput {
  readonly schema_version: number;
  readonly version: string;
  readonly reviewed_at: string;
  readonly currency: string;
  readonly fingerprint: string;
  readonly definitions: readonly PriceDefinitionInput[];
}

export interface PricingProvenance extends PricingProvenanceInput {
  readonly currency: string;
  readonly definition_fingerprint: string;
  readonly snapshot_version: string;
  readonly snapshot_fingerprint: string;
  readonly conditions: PricingConditions;
}

export interface PricingQuote {
  readonly status: PricingCompleteness;
  readonly amount_decimal?: string;
  readonly known_minimum_decimal?: string;
  readonly known_maximum_decimal?: string;
  readonly currency: string;
  readonly expected_units: readonly NormalizedBillableUnit[];
  readonly billable_quantities: Readonly<
    Partial<Record<NormalizedBillableUnit, string>>
  >;
  readonly missing_units: readonly NormalizedBillableUnit[];
  readonly unknown_reason?: string;
  readonly confidence: PricingConfidence;
  readonly requested_identity: ProviderIdentity;
  readonly effective_identity?: EffectivePricingIdentity;
  readonly snapshot_version: string;
  readonly snapshot_fingerprint: string;
  readonly provenance?: PricingProvenance;
}

export interface PricingLookup {
  readonly requested_identity: ProviderIdentity;
  readonly effective_identity?: EffectivePricingIdentity;
  readonly conditions?: PricingConditions;
  readonly quantities?: Readonly<
    Partial<Record<NormalizedBillableUnit, string>>
  >;
  /** Provider evidence may replace a fixed preflight quantity after execution. */
  readonly quantity_source?: 'estimate' | 'provider_reported';
}

export interface ProviderReportedActual {
  readonly amount_decimal: string;
  readonly currency: string;
  readonly observed_at: string;
  readonly source_reference: string;
}

export interface ResolvedActualCost {
  readonly amount_decimal: string;
  readonly currency: string;
  readonly source: 'provider_reported' | ComputedActualSource;
  readonly source_class: PricingSourceClass;
  readonly requested_identity: ProviderIdentity;
  readonly effective_identity?: EffectivePricingIdentity;
  readonly provenance:
    | PricingProvenance
    | {
        readonly currency: string;
        readonly source_class: 'provider_reported_actual';
        readonly observed_at: string;
        readonly source_reference?: string;
        readonly snapshot_version: string;
        readonly snapshot_fingerprint: string;
        readonly conditions: PricingConditions;
      };
  readonly quote?: PricingQuote;
}

export interface ActualCostInput extends PricingLookup {
  readonly provider_reported_actual?: ProviderReportedActual;
  readonly provider_reported_units?: Readonly<
    Partial<Record<NormalizedBillableUnit, string>>
  >;
}

interface Decimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

export class PricingCatalogError extends Error {}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function ownFrozen<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function jsonRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PricingCatalogError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactObjectKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected !== undefined) {
    throw new PricingCatalogError(
      `${field} contains an unexpected field: ${unexpected}`,
    );
  }
}

function boundedString(value: unknown, field: string, maximum = 1024): void {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new PricingCatalogError(`${field} must be a bounded string.`);
  }
}

function boundedArray(
  value: unknown,
  field: string,
  maximum = MAX_DEFINITION_UNITS,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new PricingCatalogError(
      `${field} must be an array with at most ${maximum} entries.`,
    );
  }
  return value;
}

function assertPriceDefinitionShape(
  value: unknown,
): asserts value is PriceDefinitionInput {
  const definition = jsonRecord(value, 'definition');
  exactObjectKeys(
    definition,
    [
      'id',
      'provider_id',
      'profile_id',
      'effective_target',
      'conditions',
      'currency',
      'completeness',
      'confidence',
      'expected_units',
      'fixed_quantities',
      'missing_units',
      'rates',
      'unknown_reason',
      'provenance',
    ],
    'definition',
  );
  for (const field of [
    'id',
    'provider_id',
    'profile_id',
    'currency',
  ] as const) {
    boundedString(definition[field], `definition.${field}`, 256);
  }
  if (!COMPLETENESS_VALUES.has(definition.completeness as string)) {
    throw new PricingCatalogError('definition.completeness is invalid.');
  }
  if (!CONFIDENCE_VALUES.has(definition.confidence as string)) {
    throw new PricingCatalogError('definition.confidence is invalid.');
  }
  const expected = boundedArray(definition.expected_units, 'expected_units');
  const missing = boundedArray(definition.missing_units, 'missing_units');
  for (const [index, unit] of [...expected, ...missing].entries()) {
    boundedString(unit, `definition unit ${index}`, 128);
  }
  const rates = boundedArray(definition.rates, 'rates');
  for (const [index, value_] of rates.entries()) {
    const rate = jsonRecord(value_, `rates[${index}]`);
    exactObjectKeys(
      rate,
      ['unit', 'amount_decimal', 'per_decimal'],
      `rates[${index}]`,
    );
    boundedString(rate.unit, `rates[${index}].unit`, 128);
    boundedString(rate.amount_decimal, `rates[${index}].amount_decimal`, 128);
    boundedString(rate.per_decimal, `rates[${index}].per_decimal`, 128);
  }
  const fixed = jsonRecord(
    definition.fixed_quantities ?? {},
    'fixed_quantities',
  );
  if (Object.keys(fixed).length > MAX_DEFINITION_UNITS) {
    throw new PricingCatalogError(
      'fixed_quantities contains too many entries.',
    );
  }
  for (const [unit, quantity] of Object.entries(fixed)) {
    boundedString(unit, 'fixed quantity unit', 128);
    boundedString(quantity, `fixed_quantities.${unit}`, 128);
  }
  const conditions = jsonRecord(definition.conditions ?? {}, 'conditions');
  if (Object.keys(conditions).length > 32) {
    throw new PricingCatalogError('conditions contains too many entries.');
  }
  for (const [condition, conditionValue] of Object.entries(conditions)) {
    boundedString(condition, 'condition name', 64);
    boundedString(conditionValue, `conditions.${condition}`, 128);
  }
  if (definition.effective_target !== undefined) {
    const target = jsonRecord(definition.effective_target, 'effective_target');
    exactObjectKeys(
      target,
      ['provider_id', 'kind', 'target_id'],
      'effective_target',
    );
    if (target.provider_id !== undefined) {
      boundedString(target.provider_id, 'effective_target.provider_id', 256);
    }
    if (!TARGET_KIND_VALUES.has(target.kind as string)) {
      throw new PricingCatalogError('effective_target.kind is invalid.');
    }
    boundedString(target.target_id, 'effective_target.target_id', 256);
  }
  if (definition.unknown_reason !== undefined) {
    boundedString(definition.unknown_reason, 'unknown_reason', 1024);
  }
  const provenance = jsonRecord(definition.provenance, 'provenance');
  exactObjectKeys(
    provenance,
    ['source_class', 'source_reference', 'effective_at', 'retrieved_at'],
    'provenance',
  );
  if (!SOURCE_CLASS_VALUES.has(provenance.source_class as string)) {
    throw new PricingCatalogError('provenance.source_class is invalid.');
  }
  for (const field of [
    'source_reference',
    'effective_at',
    'retrieved_at',
  ] as const) {
    boundedString(provenance[field], `provenance.${field}`, 512);
  }
}

function assertPricingSnapshotShape(
  value: unknown,
): asserts value is PricingSnapshotInput {
  const snapshot = jsonRecord(value, 'snapshot');
  exactObjectKeys(
    snapshot,
    [
      'schema_version',
      'version',
      'reviewed_at',
      'currency',
      'fingerprint',
      'definitions',
    ],
    'snapshot',
  );
  boundedString(snapshot.version, 'snapshot.version', 256);
  boundedString(snapshot.reviewed_at, 'snapshot.reviewed_at', 64);
  boundedString(snapshot.currency, 'snapshot.currency', 3);
  boundedString(snapshot.fingerprint, 'snapshot.fingerprint', 71);
  const definitions = boundedArray(
    snapshot.definitions,
    'snapshot.definitions',
    MAX_PRICE_DEFINITIONS,
  );
  for (const definition of definitions) assertPriceDefinitionShape(definition);
}

function nonempty(value: string, field: string): string {
  const containsControl = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (value.length === 0 || value.trim() !== value || containsControl) {
    throw new PricingCatalogError(
      `${field} must be non-empty, trimmed, and control-free.`,
    );
  }
  return value;
}

function parseDecimal(value: string, field: string): Decimal {
  if (value.length > 128 || !DECIMAL_PATTERN.test(value)) {
    throw new PricingCatalogError(
      `${field} must be a bounded non-negative base-10 decimal string.`,
    );
  }
  const [whole, fraction = ''] = value.split('.');
  return normalizeDecimal({
    coefficient: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  });
}

function positiveDecimal(value: string, field: string): Decimal {
  const parsed = parseDecimal(value, field);
  if (parsed.coefficient === 0n) {
    throw new PricingCatalogError(`${field} must be greater than zero.`);
  }
  return parsed;
}

function normalizeDecimal(value: Decimal): Decimal {
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function decimalText(value: Decimal): string {
  const normalized = normalizeDecimal(value);
  if (normalized.coefficient === 0n) return '0';
  const digits = normalized.coefficient.toString();
  if (normalized.scale === 0) return digits;
  const padded = digits.padStart(normalized.scale + 1, '0');
  const boundary = padded.length - normalized.scale;
  return `${padded.slice(0, boundary)}.${padded.slice(boundary)}`;
}

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

/** Dependency-free, synchronous SHA-256 for the sync Worker-safe catalog. */
function sha256Hex(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15] ?? 0;
      const right = words[index - 2] ?? 0;
      const sigma0 =
        rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 =
        rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] =
        ((words[index - 16] ?? 0) +
          sigma0 +
          (words[index - 7] ?? 0) +
          sigma1) >>>
        0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 =
        (h +
          sum1 +
          choice +
          (SHA256_ROUND_CONSTANTS[index] ?? 0) +
          (words[index] ?? 0)) >>>
        0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = ((hash[0] ?? 0) + a) >>> 0;
    hash[1] = ((hash[1] ?? 0) + b) >>> 0;
    hash[2] = ((hash[2] ?? 0) + c) >>> 0;
    hash[3] = ((hash[3] ?? 0) + d) >>> 0;
    hash[4] = ((hash[4] ?? 0) + e) >>> 0;
    hash[5] = ((hash[5] ?? 0) + f) >>> 0;
    hash[6] = ((hash[6] ?? 0) + g) >>> 0;
    hash[7] = ((hash[7] ?? 0) + h) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, '0')).join('');
}

function decimalAdd(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return normalizeDecimal({
    coefficient:
      left.coefficient * 10n ** BigInt(scale - left.scale) +
      right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  });
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function exactRateCost(
  quantity: Decimal,
  amount: Decimal,
  per: Decimal,
): Decimal {
  let numerator =
    quantity.coefficient * amount.coefficient * 10n ** BigInt(per.scale);
  let denominator =
    per.coefficient * 10n ** BigInt(quantity.scale + amount.scale);
  const divisor = greatestCommonDivisor(numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;

  let twos = 0;
  let fives = 0;
  while (denominator % 2n === 0n) {
    denominator /= 2n;
    twos += 1;
  }
  while (denominator % 5n === 0n) {
    denominator /= 5n;
    fives += 1;
  }
  if (denominator !== 1n) {
    throw new PricingCatalogError(
      'A price calculation produced a non-terminating decimal.',
    );
  }
  const scale = Math.max(twos, fives);
  numerator *= 2n ** BigInt(scale - twos) * 5n ** BigInt(scale - fives);
  return normalizeDecimal({ coefficient: numerator, scale });
}

function canonicalUnit(value: string, field: string): NormalizedBillableUnit {
  if (
    !(NORMALIZED_BILLABLE_UNITS as readonly string[]).includes(value) &&
    !PROVIDER_UNIT_PATTERN.test(value)
  ) {
    throw new PricingCatalogError(
      `${field} must be a normalized unit or a safe provider-namespaced unit.`,
    );
  }
  return value as NormalizedBillableUnit;
}

function canonicalConditions(
  conditions: PricingConditions | undefined,
  field: string,
): PricingConditions {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(conditions ?? {}).sort(
    ([left], [right]) => compareCanonicalStrings(left, right),
  )) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || value === undefined) {
      throw new PricingCatalogError(`${field} contains an invalid condition.`);
    }
    output[key] = nonempty(value, `${field}.${key}`).toLowerCase();
  }
  return output;
}

function canonicalTimestamp(value: string, field: string): string {
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  const milliseconds = Date.parse(value);
  if (!match || !Number.isFinite(milliseconds)) {
    throw new PricingCatalogError(
      `${field} must be an RFC 3339 UTC timestamp.`,
    );
  }
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const date = new Date(milliseconds);
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Number(second) ||
    date.getUTCMilliseconds() !== Number(fraction.padEnd(3, '0'))
  ) {
    throw new PricingCatalogError(
      `${field} must be a real RFC 3339 UTC timestamp.`,
    );
  }
  return value;
}

function definitionKey(definition: PriceDefinitionInput): string {
  return canonicalJson({
    provider_id: definition.provider_id.trim().toLowerCase(),
    profile_id: definition.profile_id.trim().toLowerCase(),
    effective_target: definition.effective_target
      ? {
          provider_id: (
            definition.effective_target.provider_id ?? definition.provider_id
          )
            .trim()
            .toLowerCase(),
          kind: definition.effective_target.kind,
          target_id: definition.effective_target.target_id.trim().toLowerCase(),
        }
      : undefined,
    conditions: canonicalConditions(definition.conditions, 'conditions'),
    source_class: definition.provenance.source_class,
  });
}

function validateDefinition(
  input: PriceDefinitionInput,
  snapshotCurrency: string,
): PriceDefinitionInput {
  assertPriceDefinitionShape(input);
  nonempty(input.id, 'definition.id');
  nonempty(input.provider_id, 'definition.provider_id');
  nonempty(input.profile_id, 'definition.profile_id');
  if (
    !CURRENCY_PATTERN.test(input.currency) ||
    input.currency !== snapshotCurrency
  ) {
    throw new PricingCatalogError(
      'Every price definition must use the snapshot currency.',
    );
  }
  if (input.effective_target) {
    if (input.effective_target.provider_id !== undefined) {
      nonempty(
        input.effective_target.provider_id,
        'effective_target.provider_id',
      );
    }
    nonempty(input.effective_target.target_id, 'effective_target.target_id');
  }
  const expected = input.expected_units.map((unit, index) =>
    canonicalUnit(unit, `expected_units[${index}]`),
  );
  const missing = input.missing_units.map((unit, index) =>
    canonicalUnit(unit, `missing_units[${index}]`),
  );
  if (
    new Set(expected).size !== expected.length ||
    new Set(missing).size !== missing.length
  ) {
    throw new PricingCatalogError('Expected and missing units must be unique.');
  }
  if (missing.some((unit) => !expected.includes(unit))) {
    throw new PricingCatalogError('Missing units must also be expected units.');
  }

  const rateUnits = new Set<NormalizedBillableUnit>();
  for (const [index, rate] of input.rates.entries()) {
    const unit = canonicalUnit(rate.unit, `rates[${index}].unit`);
    if (rateUnits.has(unit)) {
      throw new PricingCatalogError(`Duplicate rate unit: ${unit}`);
    }
    rateUnits.add(unit);
    const amount = positiveDecimal(
      rate.amount_decimal,
      `rates[${index}].amount_decimal`,
    );
    const per = positiveDecimal(
      rate.per_decimal,
      `rates[${index}].per_decimal`,
    );
    exactRateCost({ coefficient: 1n, scale: 0 }, amount, per);
    if (!expected.includes(unit)) {
      throw new PricingCatalogError('Rate units must also be expected units.');
    }
  }
  for (const [unit, quantity] of Object.entries(input.fixed_quantities ?? {})) {
    if (quantity === undefined) continue;
    canonicalUnit(unit, 'fixed_quantities unit');
    positiveDecimal(quantity, `fixed_quantities.${unit}`);
    if (!expected.includes(unit as NormalizedBillableUnit)) {
      throw new PricingCatalogError(
        'Fixed quantities must use expected units.',
      );
    }
  }
  const uncovered = expected.filter((unit) => !rateUnits.has(unit));
  if (
    canonicalJson([...uncovered].sort()) !== canonicalJson([...missing].sort())
  ) {
    throw new PricingCatalogError(
      'missing_units must exactly identify expected units without a rate.',
    );
  }
  if (input.completeness === 'complete' && missing.length > 0) {
    throw new PricingCatalogError(
      'Complete definitions cannot have missing units.',
    );
  }
  if (
    expected.length === 0 ||
    (input.completeness !== 'unavailable' && input.rates.length === 0)
  ) {
    throw new PricingCatalogError(
      'Price definitions require expected units and priced definitions require rates.',
    );
  }
  if (
    input.completeness === 'partial' &&
    (missing.length === 0 || input.rates.length === 0)
  ) {
    throw new PricingCatalogError(
      'Partial definitions require at least one rate and one missing unit.',
    );
  }
  if (input.completeness === 'unavailable' && input.rates.length > 0) {
    throw new PricingCatalogError(
      'Unavailable definitions cannot contain rates.',
    );
  }
  if (input.completeness !== 'complete' && !input.unknown_reason) {
    throw new PricingCatalogError(
      'Partial and unavailable definitions require an unknown reason.',
    );
  }
  if (!SOURCE_REFERENCE_PATTERN.test(input.provenance.source_reference)) {
    throw new PricingCatalogError(
      'Pricing source references must be redacted public identifiers.',
    );
  }
  canonicalTimestamp(input.provenance.effective_at, 'provenance.effective_at');
  canonicalTimestamp(input.provenance.retrieved_at, 'provenance.retrieved_at');
  canonicalConditions(input.conditions, 'conditions');
  return ownFrozen(input);
}

export function validatePricingSnapshot(
  input: PricingSnapshotInput,
): PricingSnapshotInput {
  assertPricingSnapshotShape(input);
  if (input.schema_version !== PRICING_SNAPSHOT_SCHEMA_VERSION) {
    throw new PricingCatalogError(
      'Unsupported pricing snapshot schema version.',
    );
  }
  nonempty(input.version, 'snapshot.version');
  canonicalTimestamp(input.reviewed_at, 'snapshot.reviewed_at');
  if (!CURRENCY_PATTERN.test(input.currency)) {
    throw new PricingCatalogError(
      'Snapshot currency must be an ISO 4217 code.',
    );
  }
  if (!FINGERPRINT_PATTERN.test(input.fingerprint)) {
    throw new PricingCatalogError('Snapshot fingerprint must be SHA-256.');
  }
  if (input.definitions.length === 0) {
    throw new PricingCatalogError('Pricing snapshots cannot be empty.');
  }
  const keys = new Set<string>();
  const ids = new Set<string>();
  const definitions = input.definitions.map((definition) => {
    const validated = validateDefinition(definition, input.currency);
    const key = definitionKey(validated);
    if (keys.has(key)) {
      throw new PricingCatalogError(
        'Pricing snapshot contains a normalized identity collision.',
      );
    }
    if (ids.has(validated.id.toLowerCase())) {
      throw new PricingCatalogError('Pricing definition ids must be unique.');
    }
    keys.add(key);
    ids.add(validated.id.toLowerCase());
    if (
      Date.parse(validated.provenance.retrieved_at) >
      Date.parse(input.reviewed_at)
    ) {
      throw new PricingCatalogError(
        'Pricing definitions cannot be retrieved after the snapshot review.',
      );
    }
    return validated;
  });
  return ownFrozen({ ...input, definitions });
}

export function pricingSnapshotPayload(input: PricingSnapshotInput): unknown {
  const { fingerprint: _fingerprint, ...payload } = input;
  return {
    ...payload,
    definitions: [...payload.definitions]
      .sort((left, right) => compareCanonicalStrings(left.id, right.id))
      .map((definition) => ({
        ...definition,
        expected_units: [...definition.expected_units].sort(
          compareCanonicalStrings,
        ),
        missing_units: [...definition.missing_units].sort(
          compareCanonicalStrings,
        ),
        rates: [...definition.rates].sort((left, right) =>
          compareCanonicalStrings(left.unit, right.unit),
        ),
      })),
  };
}

export function pricingSnapshotFingerprint(
  input: PricingSnapshotInput,
): string {
  const bytes = new TextEncoder().encode(
    canonicalJson(pricingSnapshotPayload(input)),
  );
  return `sha256:${sha256Hex(bytes)}`;
}

export function priceDefinitionFingerprint(
  input: PriceDefinitionInput,
): string {
  const bytes = new TextEncoder().encode(
    canonicalJson({
      ...input,
      expected_units: [...input.expected_units].sort(compareCanonicalStrings),
      missing_units: [...input.missing_units].sort(compareCanonicalStrings),
      rates: [...input.rates].sort((left, right) =>
        compareCanonicalStrings(left.unit, right.unit),
      ),
    }),
  );
  return `sha256:${sha256Hex(bytes)}`;
}

export function verifyPricingSnapshotFingerprint(
  input: PricingSnapshotInput,
): void {
  const actual = pricingSnapshotFingerprint(input);
  if (actual !== input.fingerprint) {
    throw new PricingCatalogError(
      'Pricing snapshot fingerprint does not match its content.',
    );
  }
}

export function assertPricingSnapshotFresh(
  input: PricingSnapshotInput,
  now: string,
  maximumAgeMs: number,
): void {
  const reviewedAt = Date.parse(input.reviewed_at);
  const nowAt = Date.parse(now);
  if (
    !Number.isFinite(nowAt) ||
    !now.endsWith('Z') ||
    !Number.isSafeInteger(maximumAgeMs) ||
    maximumAgeMs < 0
  ) {
    throw new PricingCatalogError('Invalid pricing freshness boundary.');
  }
  if (reviewedAt > nowAt) {
    throw new PricingCatalogError(
      'Pricing snapshot review time is in the future.',
    );
  }
  if (nowAt - reviewedAt > maximumAgeMs) {
    throw new PricingCatalogError(
      'Pricing snapshot is stale for this freeze review.',
    );
  }
}

function requestedTarget(
  identity: ProviderIdentity,
): EffectivePricingIdentity | undefined {
  const target = identity.target.underlying ?? identity.target.primary;
  return target.target_id && target.kind
    ? {
        provider_id: identity.provider_id,
        kind: target.kind,
        target_id: target.target_id,
      }
    : undefined;
}

function matchesDefinition(
  definition: PriceDefinitionInput,
  lookup: PricingLookup,
): boolean {
  if (
    definition.provider_id.toLowerCase() !==
      lookup.requested_identity.provider_id.toLowerCase() ||
    definition.profile_id.toLowerCase() !==
      lookup.requested_identity.profile_id.toLowerCase()
  ) {
    return false;
  }
  const effective =
    lookup.effective_identity ?? requestedTarget(lookup.requested_identity);
  if (definition.effective_target) {
    if (
      !effective ||
      effective.provider_id.toLowerCase() !==
        (
          definition.effective_target.provider_id ?? definition.provider_id
        ).toLowerCase() ||
      effective.kind !== definition.effective_target.kind ||
      effective.target_id?.toLowerCase() !==
        definition.effective_target.target_id.toLowerCase()
    ) {
      return false;
    }
  }
  return (
    canonicalJson(canonicalConditions(definition.conditions, 'conditions')) ===
    canonicalJson(canonicalConditions(lookup.conditions, 'conditions'))
  );
}

function sourcePriority(
  source: PricingProvenanceInput['source_class'],
): number {
  return source === 'configured_account_rate'
    ? 2
    : source === 'frozen_official_snapshot'
      ? 3
      : 4;
}

export class PricingCatalog {
  readonly snapshot: PricingSnapshotInput;
  readonly configured_definitions: readonly PriceDefinitionInput[];

  constructor(
    snapshot: PricingSnapshotInput,
    configuredDefinitions: readonly PriceDefinitionInput[] = [],
  ) {
    this.snapshot = validatePricingSnapshot(snapshot);
    verifyPricingSnapshotFingerprint(this.snapshot);
    const configuredKeys = new Set<string>();
    this.configured_definitions = ownFrozen(
      configuredDefinitions.map((definition) => {
        if (definition.provenance.source_class !== 'configured_account_rate') {
          throw new PricingCatalogError(
            'Runtime pricing overrides must be explicit configured account rates.',
          );
        }
        const validated = validateDefinition(definition, snapshot.currency);
        const key = definitionKey(validated);
        if (configuredKeys.has(key)) {
          throw new PricingCatalogError(
            'Configured pricing contains a normalized identity collision.',
          );
        }
        configuredKeys.add(key);
        return validated;
      }),
    );
  }

  definition(lookup: PricingLookup): PriceDefinitionInput | undefined {
    return [...this.configured_definitions, ...this.snapshot.definitions]
      .filter((definition) => matchesDefinition(definition, lookup))
      .sort((left, right) => {
        const priority =
          sourcePriority(left.provenance.source_class) -
          sourcePriority(right.provenance.source_class);
        return priority || compareCanonicalStrings(left.id, right.id);
      })[0];
  }

  quote(lookup: PricingLookup): PricingQuote {
    const resolvedEffective =
      lookup.effective_identity ?? requestedTarget(lookup.requested_identity);
    const definition = this.definition(lookup);
    if (!definition) {
      return ownFrozen({
        status: 'unavailable',
        currency: this.snapshot.currency,
        expected_units: [],
        billable_quantities: {},
        missing_units: [],
        unknown_reason:
          'No frozen price definition matches the exact profile, effective target, and billing conditions.',
        confidence: 'unknown',
        requested_identity: lookup.requested_identity,
        ...(resolvedEffective && {
          effective_identity: resolvedEffective,
        }),
        snapshot_version: this.snapshot.version,
        snapshot_fingerprint: this.snapshot.fingerprint,
      });
    }

    const quantities = new Map<NormalizedBillableUnit, Decimal>();
    const quantityInputs =
      lookup.quantity_source === 'provider_reported'
        ? {
            ...(definition.fixed_quantities ?? {}),
            ...(lookup.quantities ?? {}),
          }
        : {
            ...(lookup.quantities ?? {}),
            ...(definition.fixed_quantities ?? {}),
          };
    for (const [unit, value] of Object.entries(quantityInputs)) {
      if (value === undefined) continue;
      quantities.set(
        canonicalUnit(unit, 'quantity unit'),
        parseDecimal(value, `quantities.${unit}`),
      );
    }
    const rates = new Map(definition.rates.map((rate) => [rate.unit, rate]));
    let total: Decimal = { coefficient: 0n, scale: 0 };
    let priced = false;
    const missing = new Set<NormalizedBillableUnit>(definition.missing_units);
    for (const [unit, quantity] of quantities) {
      if (
        quantity.coefficient > 0n &&
        !definition.expected_units.includes(unit)
      ) {
        missing.add(unit);
      }
    }
    for (const unit of definition.expected_units) {
      const quantity = quantities.get(unit);
      const rate = rates.get(unit);
      if (!quantity || !rate) {
        missing.add(unit);
        continue;
      }
      if (quantity.coefficient === 0n) continue;
      total = decimalAdd(
        total,
        exactRateCost(
          quantity,
          positiveDecimal(rate.amount_decimal, `${rate.unit}.amount_decimal`),
          positiveDecimal(rate.per_decimal, `${rate.unit}.per_decimal`),
        ),
      );
      priced = true;
    }
    const missingUnits = [...missing].sort(compareCanonicalStrings);
    const complete =
      definition.completeness === 'complete' && missingUnits.length === 0;
    const amount = decimalText(total);
    const provenance: PricingProvenance = {
      ...definition.provenance,
      currency: definition.currency,
      definition_fingerprint: priceDefinitionFingerprint(definition),
      snapshot_version: this.snapshot.version,
      snapshot_fingerprint: this.snapshot.fingerprint,
      conditions: canonicalConditions(definition.conditions, 'conditions'),
    };
    return ownFrozen({
      status: complete
        ? 'complete'
        : definition.completeness === 'unavailable'
          ? 'unavailable'
          : 'partial',
      ...((priced || complete) && {
        amount_decimal: amount,
        known_minimum_decimal: amount,
      }),
      ...(complete && { known_maximum_decimal: amount }),
      currency: definition.currency,
      expected_units: [
        ...new Set([...definition.expected_units, ...missingUnits]),
      ].sort(compareCanonicalStrings),
      billable_quantities: Object.fromEntries(
        [...quantities.entries()].map(([unit, quantity]) => [
          unit,
          decimalText(quantity),
        ]),
      ),
      missing_units: missingUnits,
      ...(!complete && {
        unknown_reason:
          definition.unknown_reason ??
          'One or more expected billable quantities are unknown.',
      }),
      confidence: definition.confidence,
      requested_identity: lookup.requested_identity,
      ...(resolvedEffective && {
        effective_identity: resolvedEffective,
      }),
      snapshot_version: this.snapshot.version,
      snapshot_fingerprint: this.snapshot.fingerprint,
      provenance,
    });
  }

  actual(input: ActualCostInput): ResolvedActualCost | undefined {
    const reported = input.provider_reported_actual;
    if (reported) {
      const amount = decimalText(
        parseDecimal(
          reported.amount_decimal,
          'provider_reported_actual.amount_decimal',
        ),
      );
      if (reported.currency !== this.snapshot.currency) {
        throw new PricingCatalogError(
          'Provider-reported cost currency does not match the catalog.',
        );
      }
      canonicalTimestamp(
        reported.observed_at,
        'provider_reported_actual.observed_at',
      );
      if (!SOURCE_REFERENCE_PATTERN.test(reported.source_reference)) {
        throw new PricingCatalogError(
          'Provider actual source reference is not redacted.',
        );
      }
      return ownFrozen({
        amount_decimal: amount,
        currency: reported.currency,
        source: 'provider_reported',
        source_class: 'provider_reported_actual',
        requested_identity: input.requested_identity,
        ...((input.effective_identity ??
          requestedTarget(input.requested_identity)) && {
          effective_identity:
            input.effective_identity ??
            requestedTarget(input.requested_identity),
        }),
        provenance: {
          currency: reported.currency,
          source_class: 'provider_reported_actual',
          observed_at: reported.observed_at,
          ...(reported.source_reference && {
            source_reference: reported.source_reference,
          }),
          snapshot_version: this.snapshot.version,
          snapshot_fingerprint: this.snapshot.fingerprint,
          conditions: canonicalConditions(input.conditions, 'conditions'),
        },
      });
    }
    if (!input.provider_reported_units) return undefined;
    const quote = this.quote({
      requested_identity: input.requested_identity,
      effective_identity: input.effective_identity,
      conditions: input.conditions,
      quantities: input.provider_reported_units,
      quantity_source: 'provider_reported',
    });
    if (quote.status !== 'complete' || quote.amount_decimal === undefined) {
      return undefined;
    }
    const units = Object.keys(input.provider_reported_units);
    const source: ComputedActualSource = units.every(
      (unit) => unit === 'credits',
    )
      ? 'computed_from_credits'
      : units.some((unit) => unit.endsWith('_tokens'))
        ? 'computed_from_tokens'
        : 'computed_from_request';
    return ownFrozen({
      amount_decimal: quote.amount_decimal,
      currency: quote.currency,
      source,
      source_class: quote.provenance?.source_class ?? 'unknown',
      requested_identity: quote.requested_identity,
      ...(quote.effective_identity && {
        effective_identity: quote.effective_identity,
      }),
      provenance: quote.provenance as PricingProvenance,
      quote,
    });
  }
}

/** Explicit USD-to-canonical-budget boundary. No other pricing path rounds. */
export function usdDecimalToMicrousd(
  amountDecimal: string,
  rounding: 'ceil' | 'floor' | 'reject' = 'reject',
): string {
  const amount = parseDecimal(amountDecimal, 'amount_decimal');
  if (amount.scale <= 6) {
    return (amount.coefficient * 10n ** BigInt(6 - amount.scale)).toString();
  }
  const divisor = 10n ** BigInt(amount.scale - 6);
  const quotient = amount.coefficient / divisor;
  const remainder = amount.coefficient % divisor;
  if (remainder === 0n || rounding === 'floor') return quotient.toString();
  if (rounding === 'ceil') return (quotient + 1n).toString();
  throw new PricingCatalogError(
    'USD amount requires explicit rounding at the microusd budget boundary.',
  );
}

export function budgetEstimateFromQuote(quote: PricingQuote):
  | {
      readonly estimated_cost_microusd: string;
      readonly billable_units: readonly { unit: string; quantity: string }[];
    }
  | undefined {
  if (
    quote.status !== 'complete' ||
    quote.currency !== 'USD' ||
    quote.known_maximum_decimal === undefined
  ) {
    return undefined;
  }
  const definitionQuantities = Object.entries(quote.billable_quantities)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([unit, quantity]) => ({ unit, quantity }));
  // The accepted terminal contract permits snake-case units only. Keep
  // namespaced provider units private and fail closed instead of widening the
  // shared TypeScript/PHP interchange contract for pricing.
  if (
    definitionQuantities.some(
      ({ unit }) => !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(unit),
    )
  ) {
    return undefined;
  }
  return ownFrozen({
    estimated_cost_microusd: usdDecimalToMicrousd(
      quote.known_maximum_decimal,
      'ceil',
    ),
    billable_units: definitionQuantities,
  });
}
