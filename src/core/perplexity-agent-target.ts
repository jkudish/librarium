const LEGACY_PERPLEXITY_TARGETS = new Set([
  'fast-search',
  'pro-search',
  'deep-research',
  'advanced-deep-research',
  'ultra',
  'sonar',
  'sonar-pro',
  'sonar-reasoning-pro',
  'sonar-deep-research',
]);

/** Legacy Sonar model names now select Agent presets, not underlying models. */
export function normalizedPerplexityAgentUnderlyingModel(
  model: string | undefined,
): string | undefined {
  const normalized = model?.trim() || undefined;
  return normalized && !LEGACY_PERPLEXITY_TARGETS.has(normalized)
    ? normalized
    : undefined;
}
