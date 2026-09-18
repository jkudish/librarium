import { z } from 'zod';

export type GrokSearchStrategy = 'web' | 'x' | 'combined';

const MAX_WEB_DOMAINS = 5;
const MAX_X_HANDLES = 20;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const positiveNumber = z.number().positive();
const positiveInt = z.number().int().positive();

function normalizeDomainList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('Domain filters must be a non-empty string array');
  }
  const domains = value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`Domain filters[${index}] must be a non-empty string`);
    }
    const domain = item.trim().toLowerCase();
    if (
      domain.length > 253 ||
      domain.includes('://') ||
      domain.includes('/') ||
      domain.includes('@') ||
      domain.includes(':') ||
      domain.includes('?') ||
      domain.includes('#') ||
      !domain.split('.').every((label) => DOMAIN_LABEL.test(label))
    ) {
      throw new Error(`Domain filters[${index}] must be a valid hostname`);
    }
    return domain;
  });
  if (domains.length === 0) {
    throw new Error('Domain filters must be a non-empty string array');
  }
  if (domains.length > MAX_WEB_DOMAINS) {
    throw new Error(`Domain filters allow at most ${MAX_WEB_DOMAINS} entries`);
  }
  return domains;
}

function normalizeHandleList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('X handle filters must be a non-empty string array');
  }
  const handles = value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`X handle filters[${index}] must be a non-empty string`);
    }
    const normalized = item.trim().replace(/^@+/, '');
    if (!X_HANDLE.test(normalized)) {
      throw new Error(
        `X handle filters[${index}] must be a valid X handle (1-15 letters, digits, or underscore)`,
      );
    }
    return normalized;
  });
  if (handles.length === 0) {
    throw new Error('X handle filters must be a non-empty string array');
  }
  if (handles.length > MAX_X_HANDLES) {
    throw new Error(`X handle filters allow at most ${MAX_X_HANDLES} entries`);
  }
  return handles;
}

function normalizeIsoDate(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ISO_DATE.test(value.trim())) {
    throw new Error(`${field} must be an ISO8601 date (YYYY-MM-DD)`);
  }
  const normalized = value.trim();
  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
  ) {
    throw new Error(`${field} must be an ISO8601 date (YYYY-MM-DD)`);
  }
  return normalized;
}

export interface GrokValidatedOptions {
  maxTurns?: number;
  maxOutputTokens?: number;
  allowedDomains?: string[];
  excludedDomains?: string[];
  allowedXHandles?: string[];
  excludedXHandles?: string[];
  fromDate?: string;
  toDate?: string;
  enableImageUnderstanding?: boolean;
  enableImageSearch?: boolean;
  enableVideoUnderstanding?: boolean;
  perRequestUsd?: number;
  creditUsd?: number;
  creditsPerRequest?: number;
  perUnitUsd?: number;
}

function meteringFields(value: Record<string, unknown>): GrokValidatedOptions {
  const out: GrokValidatedOptions = {};
  for (const key of [
    'perRequestUsd',
    'creditUsd',
    'creditsPerRequest',
    'perUnitUsd',
  ] as const) {
    const raw = value[key];
    if (raw === undefined) continue;
    const parsed = positiveNumber.safeParse(raw);
    if (!parsed.success) throw new Error(`${key} must be a positive number`);
    out[key] = parsed.data;
  }
  return out;
}

/** Validate strategy-scoped Grok options before any network call. */
export function validateGrokOptions(
  strategy: GrokSearchStrategy,
  raw: unknown = {},
): GrokValidatedOptions {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Grok options must be an object');
  }
  const input = raw as Record<string, unknown>;
  const allowedKeys = new Set([
    'maxTurns',
    'maxOutputTokens',
    'allowedDomains',
    'excludedDomains',
    'allowedXHandles',
    'excludedXHandles',
    'fromDate',
    'toDate',
    'enableImageUnderstanding',
    'enableImageSearch',
    'enableVideoUnderstanding',
    'perRequestUsd',
    'creditUsd',
    'creditsPerRequest',
    'perUnitUsd',
  ]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) throw new Error(`Unknown Grok option: ${key}`);
  }
  const supportsWeb = strategy === 'web' || strategy === 'combined';
  const supportsX = strategy === 'x' || strategy === 'combined';
  const rejectIfPresent = (key: string, allowed: boolean): void => {
    if (!allowed && input[key] !== undefined) {
      throw new Error(
        `${key} is not supported by the ${strategy} Grok strategy`,
      );
    }
  };
  rejectIfPresent('allowedDomains', supportsWeb);
  rejectIfPresent('excludedDomains', supportsWeb);
  rejectIfPresent('enableImageSearch', supportsWeb);
  rejectIfPresent('allowedXHandles', supportsX);
  rejectIfPresent('excludedXHandles', supportsX);
  rejectIfPresent('fromDate', supportsX);
  rejectIfPresent('toDate', supportsX);
  rejectIfPresent('enableVideoUnderstanding', supportsX);

  const options: GrokValidatedOptions = { ...meteringFields(input) };
  if (input.maxTurns !== undefined) {
    const parsed = positiveInt.safeParse(input.maxTurns);
    if (!parsed.success) throw new Error('maxTurns must be a positive integer');
    options.maxTurns = parsed.data;
  }
  if (input.maxOutputTokens !== undefined) {
    const parsed = positiveInt.safeParse(input.maxOutputTokens);
    if (!parsed.success)
      throw new Error('maxOutputTokens must be a positive integer');
    options.maxOutputTokens = parsed.data;
  }
  if (supportsWeb) {
    options.allowedDomains = normalizeDomainList(input.allowedDomains);
    options.excludedDomains = normalizeDomainList(input.excludedDomains);
    if (options.allowedDomains && options.excludedDomains) {
      throw new Error(
        'allowedDomains and excludedDomains are mutually exclusive',
      );
    }
    if (input.enableImageSearch !== undefined) {
      if (typeof input.enableImageSearch !== 'boolean')
        throw new Error('enableImageSearch must be a boolean');
      options.enableImageSearch = input.enableImageSearch;
    }
  }
  if (supportsX) {
    options.allowedXHandles = normalizeHandleList(input.allowedXHandles);
    options.excludedXHandles = normalizeHandleList(input.excludedXHandles);
    if (options.allowedXHandles && options.excludedXHandles) {
      throw new Error(
        'allowedXHandles and excludedXHandles are mutually exclusive',
      );
    }
    options.fromDate = normalizeIsoDate(input.fromDate, 'fromDate');
    options.toDate = normalizeIsoDate(input.toDate, 'toDate');
    if (
      options.fromDate &&
      options.toDate &&
      options.fromDate > options.toDate
    ) {
      throw new Error('fromDate must be on or before toDate');
    }
    if (input.enableVideoUnderstanding !== undefined) {
      if (typeof input.enableVideoUnderstanding !== 'boolean')
        throw new Error('enableVideoUnderstanding must be a boolean');
      options.enableVideoUnderstanding = input.enableVideoUnderstanding;
    }
  }
  if (input.enableImageUnderstanding !== undefined) {
    if (typeof input.enableImageUnderstanding !== 'boolean')
      throw new Error('enableImageUnderstanding must be a boolean');
    options.enableImageUnderstanding = input.enableImageUnderstanding;
  }
  return options;
}

export function createGrokOptionsSchema(
  strategy: GrokSearchStrategy,
): z.ZodTypeAny {
  return z.unknown().superRefine((value, ctx) => {
    try {
      validateGrokOptions(strategy, value ?? {});
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export const grokWebOptionsSchema = createGrokOptionsSchema('web');
export const grokXOnlyOptionsSchema = createGrokOptionsSchema('x');
export const grokCombinedOptionsSchema = createGrokOptionsSchema('combined');
