import { z } from 'zod';
import { OpaqueIdSchema } from './contracts/common.js';
import {
  type ExecutionProfile,
  ExecutionProfileSchema,
  type ProfileTarget,
} from './contracts/domain/index.js';

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
  /** Relative operation timeout in seconds. */
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
  /** Provider-reported billable units, such as credits. Never estimated. */
  billableUnits?: number;
  /** Unit for billableUnits, such as 'credit', 'request', or 'token'. */
  unit?: string;
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
  /** Fail closed when this result must not trigger a configured fallback. */
  preventFallback?: true;
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
  /** Propagated provider policy that prevents fallback dispatch. */
  preventFallback?: true;
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
  /** Raw provider state from the most recent successful poll. */
  providerStatus?: string;
  /** Safe diagnostic from the most recent poll; never credentials or headers. */
  lastPollError?: string;
  outputDir?: string;
}

// Async poll result
export interface AsyncPollResult {
  status: AsyncTaskStatus;
  progress?: number; // 0-100
  message?: string;
  /** Provider-native state, persisted separately from Librarium's mapped state. */
  rawStatus?: string;
}

// Fields shared by every provider implementation.
export interface ProviderCommon {
  id: string;
  displayName: string;
  tier: ProviderTier;
  envVar: string;
  source?: ProviderSource;
  requiresApiKey?: boolean;
  /** Safe validation diagnostic; blocks new work but not background retrieval. */
  configurationError?: string;

  // All providers support direct execution. Background providers use this for
  // synchronous callers that choose to wait for their remote task.
  execute(query: string, options: ProviderOptions): Promise<ProviderResult>;

  // Health check
  test?(): Promise<{ ok: boolean; error?: string }>;
}

/** A provider whose work is complete when execute() resolves. */
export interface InlineProvider extends ProviderCommon {
  execution: 'inline';
}

/**
 * A provider that can submit work to a remote background service.
 *
 * All lifecycle hooks are required together: a task handle without polling or
 * retrieval support cannot be safely persisted or resumed.
 */
export interface BackgroundProvider extends ProviderCommon {
  execution: 'background';

  submit(query: string, options: ProviderOptions): Promise<AsyncTaskHandle>;
  poll(handle: AsyncTaskHandle): Promise<AsyncPollResult>;
  retrieve(handle: AsyncTaskHandle): Promise<ProviderResult>;
}

// Provider interface — each adapter implements one execution contract.
export type Provider = InlineProvider | BackgroundProvider;

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
  /** Configured execution target, not a provider-reported runtime observation. */
  target?: ProfileTarget;
}

// Config for a single provider
export const ProviderConfigSchema = z.object({
  apiKey: z.string().optional(), // "$ENV_VAR" pattern — resolved at runtime
  enabled: z.boolean().default(true),
  model: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  fallback: z.string().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const ProjectProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
  enabled: z.boolean().optional(),
  model: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  fallback: z.string().optional(),
});
export type ProjectProviderConfig = z.infer<typeof ProjectProviderConfigSchema>;

export interface CustomProviderExecutionProfile {
  bindingId: string;
  profile: ExecutionProfile;
  credential?: { envVar: string };
}

export const CustomProviderExecutionProfileSchema: z.ZodType<CustomProviderExecutionProfile> =
  z.strictObject({
    bindingId: z.custom<string>(
      (value) => OpaqueIdSchema.safeParse(value).success,
      'Custom-provider bindingId must be a canonical opaque identifier',
    ),
    // Validate with the canonical schema at this boundary and retain its exact
    // inferred type without weakening or duplicating the contract.
    profile: z.custom<ExecutionProfile>(
      (value) => ExecutionProfileSchema.safeParse(value).success,
      'Invalid canonical execution profile',
    ),
    credential: z
      .strictObject({
        envVar: z
          .string()
          .trim()
          .regex(
            /^[A-Za-z_][A-Za-z0-9_]*$/,
            'Custom-provider credential envVar must be a valid environment variable name',
          ),
      })
      .optional(),
  });

export const NpmProviderSourceSchema = z.object({
  type: z.literal('npm'),
  module: z.string().min(1),
  export: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  executionProfile: CustomProviderExecutionProfileSchema.optional(),
});
export type NpmProviderSource = z.infer<typeof NpmProviderSourceSchema>;

export const ScriptProviderSourceSchema = z.object({
  type: z.literal('script'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  executionProfile: CustomProviderExecutionProfileSchema.optional(),
});
export type ScriptProviderSource = z.infer<typeof ScriptProviderSourceSchema>;

export const CustomProviderSourceSchema = z.discriminatedUnion('type', [
  NpmProviderSourceSchema,
  ScriptProviderSourceSchema,
]);
export type CustomProviderSource = z.infer<typeof CustomProviderSourceSchema>;

// Defaults config
export const LegacyExecutionModeSchema = z.enum(['sync', 'async', 'mixed']);

export const DefaultsSchema = z.object({
  outputDir: z.string().default('./agents/librarium'),
  maxParallel: z.number().default(6),
  timeout: z.number().default(30),
  asyncTimeout: z.number().default(1800),
  asyncPollInterval: z.number().default(30),
  mode: LegacyExecutionModeSchema.default('mixed'),
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
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  customProviders: z.record(z.string(), CustomProviderSourceSchema).default({}),
  trustedProviderIds: z.array(z.string()).default([]),
  groups: z.record(z.string(), z.array(z.string())).default({}),
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
      mode: LegacyExecutionModeSchema.optional(),
      llmWebSearch: z.boolean().optional(),
      maxCostUsd: z.number().optional(),
      maxEstimatedCostUsd: z.number().optional(),
    })
    .optional(),
  providers: z.record(z.string(), ProjectProviderConfigSchema).optional(),
  customProviders: z.record(z.string(), CustomProviderSourceSchema).optional(),
  trustedProviderIds: z.array(z.string()).optional(),
  groups: z.record(z.string(), z.array(z.string())).optional(),
  refine: RefineConfigSchema.optional(),
  answer: AnswerConfigSchema.optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export type RunStatus =
  | 'running'
  | 'awaiting_async'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

/**
 * Durable background-task state embedded in its provider record. Provider,
 * query, and output directory are inherited from the surrounding manifest so
 * completed tasks retain a compact audit trail without duplicating run data.
 */
export interface RunTaskState {
  taskId: string;
  submittedAt: number;
  status: AsyncTaskStatus;
  lastPolledAt?: number;
  completedAt?: number;
  retrievedAt?: number;
  /** Raw provider state from the most recent successful poll. */
  providerStatus?: string;
  /** Safe diagnostic from the most recent poll; never credentials or headers. */
  lastPollError?: string;
}

// Live run manifest — written to run.json before dispatch and mutated atomically.
export interface RunManifest {
  schemaVersion: 2;
  /** Monotonic persisted-mutation counter used for compare-and-swap writes. */
  revision: number;
  status: RunStatus;
  timestamp: number;
  completedAt?: number;
  slug: string;
  query: string;
  mode: 'sync' | 'async' | 'mixed';
  outputDir: string;
  providers: ProviderReport[];
  sources: { total: number; unique: number; file: string };
  exitCode: number | null;
  /** Safe top-level diagnostic when orchestration fails after creation. */
  error?: string;
  /** Tier-tuned query variants used for dispatch (run --refine). */
  refinedQueries?: Partial<Record<ProviderTier, string>>;
  /**
   * Grounded synthesis metadata (librarium answer). Records which LLM client
   * produced answer.md. Absent for plain runs and when synthesis failed.
   */
  answer?: { provider: string; model: string };
  /**
   * Additive, opt-in claim verification data produced by `answer --verify`.
   * Kept separate from the initial provider fan-out so consumers can account
   * for verification evidence and spend independently.
   */
  verification?: VerificationMetadata;
}

export type ClaimSupportStatus = 'supported' | 'conflicting' | 'insufficient';

export interface ClaimSupport {
  id: string;
  claim: string;
  category:
    | 'date'
    | 'number'
    | 'quotation'
    | 'compatibility'
    | 'causal'
    | 'comparison';
  status: ClaimSupportStatus;
  /** URLs of independent source evidence, never a list of provider names. */
  sourceUrls: string[];
  reason?: string;
}

export interface VerificationAttempt {
  provider: string;
  tier: 'ai-grounded' | 'raw-search';
  status: 'success' | 'error' | 'skipped';
  durationMs: number;
  error?: string;
  /** Source URLs returned by this specific attempt, when any. */
  sourceUrls?: string[];
  usage?: ProviderUsage;
  metering?: ProviderMetering;
}

export interface VerificationFollowUp {
  claimId: string;
  query: string;
  attempts: VerificationAttempt[];
  sourceUrls: string[];
}

export interface VerificationLlmCall {
  stage: 'claims' | 'initial-assessment' | 'follow-up-assessment' | 'revision';
  provider: string;
  model: string;
  /** Additive fields are optional so older persisted manifests remain readable. */
  status?: 'success' | 'error';
  durationMs?: number;
  error?: string;
  usage?: ProviderUsage;
  metering?: ProviderMetering;
}

/** Verification-only aggregate for one paid-call lane. */
export interface VerificationUsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** True when at least one dispatched call did not report complete token data. */
  tokenCountsAreLowerBound: boolean;
  /** Sum of costs explicitly reported by APIs. */
  reportedCostUsd: number;
  /** True when at least one dispatched call did not report cost. */
  reportedCostIsLowerBound: boolean;
  /** Sum of network-free estimates reserved before dispatch. */
  estimatedCostUsd: number;
  /** True when at least one dispatched call had no USD estimate. */
  estimatedCostIsLowerBound: boolean;
}

export interface VerificationMetadata {
  status: 'complete' | 'partial' | 'incomplete';
  matrixFile: string;
  matrix: ClaimSupport[];
  followUps: VerificationFollowUp[];
  reasons: string[];
  usage: {
    providerAttempts: number;
    successfulProviderAttempts: number;
    /** Total verification-only reported spend: provider follow-ups plus LLMs. */
    reportedCostUsd: number;
    reportedCostIsLowerBound?: boolean;
    /** Total verification-only estimated spend: provider follow-ups plus LLMs. */
    estimatedCostUsd: number;
    estimatedCostIsLowerBound?: boolean;
    llmCalls: number;
    successfulLlmCalls?: number;
    /** Separate provider and LLM lanes; absent only on older persisted runs. */
    provider?: VerificationUsageSummary;
    llm?: VerificationUsageSummary;
  };
  llm: VerificationLlmCall[];
  revised: boolean;
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
  /** Propagated provider policy that prevents fallback dispatch. */
  preventFallback?: true;
  /** Present only for providers submitted through a background lifecycle. */
  task?: RunTaskState;
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
  /** Present on `async-submitted` so callers can persist the handle first. */
  task?: AsyncTaskHandle;
}
