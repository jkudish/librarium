/** Private execution strategies. These are never valid public provider tokens. */
export const INTERNAL_ADAPTER_IDS = [
  'exa-research',
  'tavily-research',
  'you-research-background',
] as const;

export const INTERNAL_ADAPTER_ID_SET: ReadonlySet<string> = new Set(
  INTERNAL_ADAPTER_IDS,
);

export const INTERNAL_ADAPTER_PUBLIC_PROVIDER_IDS: Readonly<
  Record<(typeof INTERNAL_ADAPTER_IDS)[number], string>
> = {
  'exa-research': 'exa',
  'tavily-research': 'tavily',
  'you-research-background': 'you-research',
};
