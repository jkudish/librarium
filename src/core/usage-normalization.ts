import type { ProviderResult, ProviderUsage } from '../types.js';

/**
 * Normalize adapter usage without importing the retired v1 dispatcher.
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
