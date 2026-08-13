import { InvalidArgumentError } from 'commander';
import {
  RESEARCH_REQUEST_LIMITS,
  ResearchQuerySchema,
} from './core/research-request.js';
import { INTERNAL_ADAPTER_ID_SET } from './internal-adapter-ids.js';
import { type Defaults, LegacyExecutionModeSchema } from './types.js';

const MICRO_USD_PER_USD = 1_000_000n;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

export const CLI_LIMITS = {
  providers: RESEARCH_REQUEST_LIMITS.profiles,
  parallel: {
    min: RESEARCH_REQUEST_LIMITS.minConcurrency,
    max: RESEARCH_REQUEST_LIMITS.maxConcurrency,
  },
  timeoutSeconds: {
    min: RESEARCH_REQUEST_LIMITS.minDeadlineMs / 1_000,
    max: RESEARCH_REQUEST_LIMITS.maxDeadlineMs / 1_000,
  },
  queryLength: RESEARCH_REQUEST_LIMITS.queryLength,
} as const;

export type CliMode = Defaults['mode'];
export type CompletionShell = 'zsh' | 'bash' | 'fish';
export type ConfigAction = 'menu';

function invalid(message: string): never {
  throw new InvalidArgumentError(message);
}

export function parseResearchQuery(value: string): string {
  const result = ResearchQuerySchema.safeParse(value);
  if (result.success) return result.data;
  return invalid(result.error.issues[0]?.message ?? 'is not a valid query.');
}

export function parseProviders(value: string): string[] {
  const providers = value.split(',').map((provider) => provider.trim());
  if (providers.some((provider) => provider.length === 0)) {
    return invalid('must be a comma-separated list of non-empty provider IDs.');
  }
  if (providers.some((provider) => INTERNAL_ADAPTER_ID_SET.has(provider))) {
    return invalid(
      'contains a private internal adapter id; use provider/profile.',
    );
  }
  if (providers.length > CLI_LIMITS.providers) {
    return invalid(`must contain at most ${CLI_LIMITS.providers} providers.`);
  }
  return providers;
}

export function parseMode(value: string): CliMode {
  const result = LegacyExecutionModeSchema.safeParse(value);
  if (result.success) return result.data;
  return invalid('must be one of: sync, async, mixed.');
}

export function parseParallel(value: string): number {
  return parseBoundedInteger(
    value,
    CLI_LIMITS.parallel.min,
    CLI_LIMITS.parallel.max,
  );
}

export function parseTimeoutSeconds(value: string): number {
  return parseBoundedInteger(
    value,
    CLI_LIMITS.timeoutSeconds.min,
    CLI_LIMITS.timeoutSeconds.max,
  );
}

export function parsePositiveDays(value: string): number {
  return parseBoundedInteger(value, 1, Number.MAX_SAFE_INTEGER);
}

export function parseCompletionShell(value: string): CompletionShell {
  if (value === 'zsh' || value === 'bash' || value === 'fish') {
    return value;
  }
  return invalid('must be one of: zsh, bash, fish.');
}

export function parseConfigAction(value: string): ConfigAction {
  if (value === 'menu') return value;
  return invalid('must be "menu" when supplied.');
}

/**
 * Parse a positive USD budget through an exact micro-USD integer. Decimal and
 * exponent spellings are normalized; sub-micro precision is never rounded.
 */
export function parseUsdBudget(value: string): number {
  const normalized = value.trim();
  if (normalized.length > RESEARCH_REQUEST_LIMITS.exactIntegerLength * 2) {
    return invalid('is too large to represent safely.');
  }
  const match = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(
    normalized,
  );
  if (!match) {
    return invalid('must be a positive decimal or exponent-form USD amount.');
  }

  const fraction = match[2] ?? match[3] ?? '';
  const coefficientDigits = `${match[1] ?? '0'}${fraction}`;
  const coefficient = BigInt(coefficientDigits);
  if (coefficient === 0n) {
    return invalid('must be at least 0.000001 USD.');
  }

  const exponent = BigInt(match[4] ?? '0');
  const microPower = 6n - BigInt(fraction.length) + exponent;
  let microUsd: bigint;
  if (microPower >= 0n) {
    if (microPower > 20n) {
      return invalid('is too large to represent safely.');
    }
    microUsd = coefficient * 10n ** microPower;
  } else {
    const divisorPower = -microPower;
    if (divisorPower > BigInt(coefficientDigits.length)) {
      return invalid('must not use precision smaller than one micro-USD.');
    }
    const divisor = 10n ** divisorPower;
    if (coefficient % divisor !== 0n) {
      return invalid('must not use precision smaller than one micro-USD.');
    }
    microUsd = coefficient / divisor;
  }

  if (microUsd <= 0n) {
    return invalid('must be at least 0.000001 USD.');
  }
  if (microUsd > MAX_SAFE_INTEGER) {
    return invalid('is too large to represent safely.');
  }

  const parsed = Number(microUsd) / Number(MICRO_USD_PER_USD);
  if (Math.round(parsed * Number(MICRO_USD_PER_USD)) !== Number(microUsd)) {
    return invalid('is too large to preserve exact micro-USD precision.');
  }
  return parsed;
}

function parseBoundedInteger(
  value: string,
  minimum: number,
  maximum: number,
): number {
  const normalized = value.trim();
  if (!/^\+?\d+$/.test(normalized)) {
    return invalid(
      'must be a base-10 integer without a minus sign or decimals.',
    );
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    return invalid('must be a safe integer.');
  }
  if (parsed < minimum || parsed > maximum) {
    return invalid(`must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}
