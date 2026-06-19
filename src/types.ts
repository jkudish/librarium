import { z } from 'zod';

// Provider tiers
export type ProviderTier =
  | 'deep-research'
  | 'ai-grounded'
  | 'raw-search'
  | 'llm';
export type ProviderSource = 'builtin' | 'npm' | 'script';

// Async task status
export type AsyncTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

// Provider options passed to execute/submit
export interface ProviderOptions {
  timeout: number;
  signal?: AbortSignal;
}

// Normalized usage/cost as reported by a provider's API. Honest data only:
// fields are set when (and only when) the API itself reported them. costUsd
// is never estimated from a pricing table — estimates live under
// ProviderMetering.estimate, never here.
export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  raw?: unknown;
}

// How a provider is metered/priced. Declared statically per provider in the
// metering registry (src/core/metering.ts); network-free.
//   native_cost      — the API returns a real per-call cost (e.g. Perplexity, Exa)
//   native_tokens    — the API returns token counts but no cost (e.g. Claude, OpenAI)
//   request_priced   — a deterministic/plan price per request (e.g. SerpAPI, Brave)
//   credit_priced    — priced in account credits per request (e.g. Tavily, Firecrawl)
//   api_unit_priced  — priced per API unit/row/token, size known only post-call (e.g. Jina)
//   manual_unmetered — no reliable per-call metering available
export type MeteringKind =
  | 'native_cost'
  | 'native_tokens'
  | 'request_priced'
  | 'credit_priced'
  | 'api_unit_priced'
  | 'manual_unmetered';

// Confidence in a cost figure.
//   reported   — taken straight from the provider API (a fact)
//   configured — computed from user-supplied pricing in provider options
//   estimated  — computed from a built-in default pricing snapshot (a guess)
//   unknown    — no basis to estimate
export type CostConfidence =
  | 'reported'
  | 'configured'
  | 'estimated'
  | 'unknown';

// Provenance of an actual (non-estimated) cost figure on normalized output.
export type ActualCostSource =
  | 'provider_reported'
  | 'computed_from_tokens'
  | 'computed_from_request'
  | 'computed_from_credits'
  | 'account_usage_delta'
  | 'unknown';

// Pre-dispatch cost estimate. Produced WITHOUT any network call so budgets can
// be reserved before a provider runs. Never folded into ProviderUsage.costUsd.
export interface MeteringEstimate {
  /** Estimated USD cost. Omitted when the price is plan-dependent/unknown. */
  estimatedCostUsd?: number;
  /** Number of billable units this call is expected to consume. */
  billableUnits?: number;
  /** Unit the estimate is denominated in: 'request' | 'credit' | 'token' | ... */
  unit?: string;
  /** Version tag for the pricing snapshot behind estimatedCostUsd. */
  pricingVersion?: string;
  /** How much to trust estimatedCostUsd (estimated/configured/unknown here). */
  costConfidence: CostConfidence;
}

// An actual (post-dispatch) cost figure with its provenance. Kept separate from
// ProviderUsage so usage.costUsd stays strictly provider-reported.
export interface MeteringActual {
  costUsd?: number;
  source: ActualCostSource;
  billableUnits?: number;
}

// Per-provider metering metadata attached to dispatch results/reports. Carries
// the static capability (kind), a pre-dispatch estimate, and — once a result is
// in hand — the actual cost lane. Additive: omit it and nothing else changes.
export interface ProviderMetering {
  kind: MeteringKind;
  /** Pricing snapshot version for this provider's defaults, when applicable. */
  pricingVersion?: string;
  /** Network-free pre-dispatch estimate (absent for native/unmetered kinds). */
  estimate?: MeteringEstimate;
  /** Actual cost lane, populated only when a real figure is known. */
  actual?: MeteringActual;
}

// Normalized citation from any provider
export interface Citation {
  url: string;
  title?: string;
  snippet?: string;
  provider: string;
}

// Result from any provider execution
export interface ProviderResult {
  provider: string;
  tier: ProviderTier;
  content: string; // Markdown content
  citations: Citation[];
  durationMs: number;
  model?: string;
  tokenUsage?: { input?: number; output?: number };
  usage?: ProviderUsage;
  metering?: ProviderMetering;
  error?: string;
}

// Structured result returned by the core dispatcher for library consumers
export interface ProviderDispatchResult {
  provider: string;
  tier: ProviderTier;
  status: 'success' | 'error' | 'timeout' | 'skipped' | 'async-pending';
  text: string;
  sourceUrls: string[];
  citations: Citation[];
  durationMs: number;
  model?: string;
  tokenUsage?: { input?: number; output?: number };
  usage?: ProviderUsage;
  metering?: ProviderMetering;
  error?: string;
  fallbackFor?: string;
}

// Handle for async deep-research tasks
export interface AsyncTaskHandle {
  provider: string;
  taskId: string;
  query: string;
  submittedAt: number;
  status: AsyncTaskStatus;
  lastPolledAt?: number;
  completedAt?: number;
  outputDir?: string;
}

// Async poll result
export interface AsyncPollResult {
  status: AsyncTaskStatus;
  progress?: number; // 0-100
  message?: string;
}

// Provider interface — each adapter implements this
export interface Provider {
  id: string;
  displayName: string;
  tier: ProviderTier;
  envVar: string;
  source?: ProviderSource;
  requiresApiKey?: boolean;

  // Sync execution (all providers)
  execute(query: string, options: ProviderOptions): Promise<ProviderResult>;

  // Async (deep-research only)
  submit?(query: string, options: ProviderOptions): Promise<AsyncTaskHandle>;
  poll?(handle: AsyncTaskHandle): Promise<AsyncPollResult>;
  retrieve?(handle: AsyncTaskHandle): Promise<ProviderResult>;

  // Health check
  test?(): Promise<{ ok: boolean; error?: string }>;
}

// Provider meta for ls/display
export interface ProviderMeta {
  id: string;
  displayName: string;
  tier: ProviderTier;
  envVar: string;
  source: ProviderSource;
  enabled: boolean;
  hasApiKey: boolean;
  credentialSource: 'env' | 'keychain' | 'literal' | 'missing';
  /** False when the provider has no entry in config (e.g. added after init). */
  configured?: boolean;
  /** How this provider is metered/priced (from the metering registry). */
  meteringKind?: MeteringKind;
}

// Config for a single provider
export const ProviderConfigSchema = z.object({
  apiKey: z.string().optional(), // "$ENV_VAR" pattern — resolved at runtime
  enabled: z.boolean().default(true),
  model: z.string().optional(),
  options: z.record(z.unknown()).optional(),
  fallback: z.string().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const ProjectProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
  enabled: z.boolean().optional(),
  model: z.string().optional(),
  options: z.record(z.unknown()).optional(),
  fallback: z.string().optional(),
});
export type ProjectProviderConfig = z.infer<typeof ProjectProviderConfigSchema>;

export const NpmProviderSourceSchema = z.object({
  type: z.literal('npm'),
  module: z.string().min(1),
  export: z.string().optional(),
  options: z.record(z.unknown()).optional(),
});
export type NpmProviderSource = z.infer<typeof NpmProviderSourceSchema>;

export const ScriptProviderSourceSchema = z.object({
  type: z.literal('script'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  options: z.record(z.unknown()).optional(),
});
export type ScriptProviderSource = z.infer<typeof ScriptProviderSourceSchema>;

export const CustomProviderSourceSchema = z.discriminatedUnion('type', [
  NpmProviderSourceSchema,
  ScriptProviderSourceSchema,
]);
export type CustomProviderSource = z.infer<typeof CustomProviderSourceSchema>;

// Defaults config
export const DefaultsSchema = z.object({
  outputDir: z.string().default('./agents/librarium'),
  maxParallel: z.number().default(6),
  timeout: z.number().default(30),
  asyncTimeout: z.number().default(1800),
  asyncPollInterval: z.number().default(10),
  mode: z.enum(['sync', 'async', 'mixed']).default('mixed'),
  llmWebSearch: z.boolean().default(true),
  // Optional runtime spend circuit breaker. Honest budget: only API-reported
  // costs count toward it (see src/core/budget.ts). Unset means no limit.
  maxCostUsd: z.number().optional(),
  // Optional pre-dispatch reservation ceiling. Reserves each provider's
  // network-free estimated cost BEFORE it runs (see src/core/budget.ts);
  // providers with no estimable cost reserve 0. Unset means no limit.
  maxEstimatedCostUsd: z.number().optional(),
});
export type Defaults = z.infer<typeof DefaultsSchema>;

// Refine (LLM query transform) settings
export const RefineConfigSchema = z.object({
  provider: z.enum(['openai', 'gemini', 'perplexity']).optional(),
  model: z.string().optional(),
});
export type RefineConfig = z.infer<typeof RefineConfigSchema>;

// Answer (LLM grounded synthesis) settings. Same shape as refine; when unset,
// the `answer` command falls back to the `refine` config, then to defaults.
export const AnswerConfigSchema = z.object({
  provider: z.enum(['openai', 'gemini', 'perplexity']).optional(),
  model: z.string().optional(),
});
export type AnswerConfig = z.infer<typeof AnswerConfigSchema>;

// Full config schema
export const ConfigSchema = z.object({
  version: z.literal(1),
  defaults: DefaultsSchema,
  providers: z.record(ProviderConfigSchema).default({}),
  customProviders: z.record(CustomProviderSourceSchema).default({}),
  trustedProviderIds: z.array(z.string()).default([]),
  groups: z.record(z.array(z.string())).default({}),
  refine: RefineConfigSchema.optional(),
  answer: AnswerConfigSchema.optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

// Project-level config (subset overrides)
export const ProjectConfigSchema = z.object({
  defaults: z
    .object({
      outputDir: z.string().optional(),
      maxParallel: z.number().optional(),
      timeout: z.number().optional(),
      asyncTimeout: z.number().optional(),
      asyncPollInterval: z.number().optional(),
      mode: z.enum(['sync', 'async', 'mixed']).optional(),
      llmWebSearch: z.boolean().optional(),
      maxCostUsd: z.number().optional(),
      maxEstimatedCostUsd: z.number().optional(),
    })
    .optional(),
  providers: z.record(ProjectProviderConfigSchema).optional(),
  customProviders: z.record(CustomProviderSourceSchema).optional(),
  trustedProviderIds: z.array(z.string()).optional(),
  groups: z.record(z.array(z.string())).optional(),
  refine: RefineConfigSchema.optional(),
  answer: AnswerConfigSchema.optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

// Run manifest — written to run.json
export interface RunManifest {
  version: 1;
  timestamp: number;
  slug: string;
  query: string;
  mode: 'sync' | 'async' | 'mixed';
  outputDir: string;
  providers: ProviderReport[];
  sources: { total: number; unique: number; file: string };
  asyncTasks: AsyncTaskHandle[];
  exitCode: number;
  /** Tier-tuned query variants used for dispatch (run --refine). */
  refinedQueries?: Partial<Record<ProviderTier, string>>;
  /**
   * Grounded synthesis metadata (librarium answer). Records which LLM client
   * produced answer.md. Absent for plain runs and when synthesis failed.
   */
  answer?: { provider: string; model: string };
}

// Per-provider report in run manifest
export interface ProviderReport {
  id: string;
  tier: ProviderTier;
  status: 'success' | 'error' | 'timeout' | 'skipped' | 'async-pending';
  durationMs: number;
  wordCount: number;
  citationCount: number;
  outputFile: string;
  metaFile: string;
  usage?: ProviderUsage;
  metering?: ProviderMetering;
  error?: string;
  fallbackFor?: string;
}

// Deduplicated source entry in sources.json
export interface DeduplicatedSource {
  url: string;
  normalizedUrl: string;
  title?: string;
  providers: string[];
  citationCount: number;
}

// Progress events from dispatcher
export interface ProgressEvent {
  providerId: string;
  event:
    | 'started'
    | 'completed'
    | 'error'
    | 'async-submitted'
    | 'fallback-started';
  // Populated on 'completed', 'error', and 'async-submitted' (the report for
  // providerId) and on 'fallback-started' (the failed primary's error report).
  report?: ProviderReport;
}
