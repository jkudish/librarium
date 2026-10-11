import type { ProviderUsage } from '../types.js';

/** generateContent `usageMetadata` counts that affect the bill. */
export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Normalize Gemini usage. The API omits zero counts, so an absent cached or
 * thinking count is zero. `promptTokenCount` includes cached tokens, and
 * thinking tokens bill as output. Gemini 3 grounding bills each unique
 * non-empty search query the model ran; retrieved web content is not billed
 * as input, so `toolUsePromptTokenCount` is not a billable quantity.
 */
export function geminiUsage(
  metadata: GeminiUsageMetadata | undefined,
  webSearchQueries: unknown,
): ProviderUsage | undefined {
  if (!metadata) return undefined;
  const cached = isCount(metadata.cachedContentTokenCount)
    ? metadata.cachedContentTokenCount
    : 0;
  const thoughts = isCount(metadata.thoughtsTokenCount)
    ? metadata.thoughtsTokenCount
    : 0;
  const searches = Array.isArray(webSearchQueries)
    ? new Set(
        webSearchQueries.filter(
          (query): query is string =>
            typeof query === 'string' && query.trim() !== '',
        ),
      ).size
    : 0;
  const prompt = metadata.promptTokenCount;
  const candidates = metadata.candidatesTokenCount;
  return {
    inputTokens: prompt,
    outputTokens: candidates,
    totalTokens: metadata.totalTokenCount,
    ...(cached > 0 && { cacheReadInputTokens: cached }),
    ...(thoughts > 0 && { reasoningTokens: thoughts }),
    searchRequests: searches,
    ...(isCount(prompt) &&
      isCount(candidates) &&
      prompt >= cached && {
        billableQuantities: {
          uncached_input_tokens: prompt - cached,
          cache_read_tokens: cached,
          output_tokens: candidates + thoughts,
          searches,
        },
      }),
    raw: metadata,
  };
}
