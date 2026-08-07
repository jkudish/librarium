import { z } from 'zod';
import type { HttpRequestOptions, HttpRetryPolicy } from './http-client.js';

export const SEARCHAPI_ENDPOINT = 'https://www.searchapi.io/api/v1/search';

export const searchApiOptionsSchema = z
  .object({
    perRequestUsd: z.number().positive().optional(),
    zeroRetention: z.boolean().default(false),
  })
  .strict();

export type SearchApiOptions = z.infer<typeof searchApiOptionsSchema>;

type SearchApiParameter = string | number | boolean | undefined;

export interface SearchApiRequestInput {
  apiKey: string;
  engine: string;
  parameters?: Record<string, SearchApiParameter>;
  zeroRetention?: boolean;
  timeout: number;
  signal?: AbortSignal;
  retry?: HttpRetryPolicy;
}

export interface SearchApiRequest {
  url: string;
  options: HttpRequestOptions;
}

/**
 * Build a SearchAPI request without placing credential material in the URL.
 * Privacy is controlled only by zeroRetention so callers cannot accidentally
 * send false or override a requested true value through raw parameters.
 */
export function createSearchApiRequest(
  input: SearchApiRequestInput,
): SearchApiRequest {
  const url = new URL(SEARCHAPI_ENDPOINT);
  url.searchParams.set('engine', input.engine);

  for (const [name, value] of Object.entries(input.parameters ?? {})) {
    if (name === 'api_key') {
      throw new TypeError(
        'SearchAPI credentials must use bearer authentication',
      );
    }
    if (name === 'zero_retention') {
      throw new TypeError(
        'SearchAPI zero retention must use the zeroRetention option',
      );
    }
    if (value !== undefined) url.searchParams.set(name, String(value));
  }

  if (input.zeroRetention === true) {
    url.searchParams.set('zero_retention', 'true');
  }

  return {
    url: url.toString(),
    options: {
      method: 'GET',
      headers: { Authorization: `Bearer ${input.apiKey}` },
      timeout: input.timeout,
      signal: input.signal,
      ...(input.retry ? { retry: input.retry } : {}),
    },
  };
}

export const SEARCHAPI_ZERO_RETENTION_REMEDIATION =
  'SearchAPI zero-retention capability unavailable — rerun without zeroRetention or upgrade the SearchAPI account';

interface SearchApiErrorInput {
  status: number;
  data: unknown;
  apiKey: string;
  zeroRetention: boolean;
  credentialEnvVar: string;
}

/**
 * Format HTTP failures through the normal provider error field. Retention
 * remediation is intentionally narrower than a generic 403 classification.
 */
export function formatSearchApiError(input: SearchApiErrorInput): string {
  if (
    input.zeroRetention &&
    isZeroRetentionCapabilityDenial(input.status, input.data)
  ) {
    return `API returned ${input.status}: ${SEARCHAPI_ZERO_RETENTION_REMEDIATION}`;
  }

  const body = redactSearchApiErrorText(input.data, input.apiKey).slice(0, 200);
  const base = `API returned ${input.status}: ${body}`;
  if (input.status === 401) {
    return `${base} — check that ${input.credentialEnvVar} is set and valid`;
  }
  if (input.status === 403) {
    return `${base} — API key may lack required permissions`;
  }
  return base;
}

export function formatSearchApiPayloadError(
  data: unknown,
  apiKey: string,
): string {
  return `SearchAPI error: ${redactSearchApiErrorText(data, apiKey).slice(0, 200)}`;
}

export function redactSearchApiErrorText(
  data: unknown,
  apiKey?: string,
): string {
  let body = serializeErrorData(data);
  if (apiKey) body = body.split(apiKey).join('[REDACTED]');
  return body
    .replace(/([?&]api_key=)[^&\s"'\\]+/gi, '$1[REDACTED]')
    .replace(/("api_key"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"')
    .replace(/(Bearer\s+)[^\s"'\\]+/gi, '$1[REDACTED]');
}

function isZeroRetentionCapabilityDenial(
  status: number,
  data: unknown,
): boolean {
  if (![400, 402, 403, 422].includes(status)) return false;

  const body = serializeErrorData(data);
  const namesZeroRetention = /\bzero[_ -](?:data[_ -])?retention\b/i.test(body);
  if (!namesZeroRetention) return false;

  return /\b(?:enterprise|entitlement|upgrade|unsupported|unavailable)\b|\bnot (?:supported|available|enabled)\b|\bonly available\b|\brequires? (?:an? )?(?:enterprise|eligible|paid) (?:plan|account)\b|\bcurrent (?:plan|account) (?:does not|doesn't|cannot|can't)\b/i.test(
    body,
  );
}

function serializeErrorData(data: unknown): string {
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data) ?? String(data);
  } catch {
    return String(data);
  }
}
