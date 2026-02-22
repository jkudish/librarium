import { z } from 'zod';

// Provider tiers
export type ProviderTier = 'deep-research' | 'ai-grounded' | 'raw-search';

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
  error?: string;
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
  enabled: boolean;
  hasApiKey: boolean;
}

// Config for a single provider
export const ProviderConfigSchema = z.object({
  apiKey: z.string(), // "$ENV_VAR" pattern — resolved at runtime
  enabled: z.boolean().default(true),
  model: z.string().optional(),
  options: z.record(z.unknown()).optional(),
  fallback: z.string().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

// Defaults config
export const DefaultsSchema = z.object({
  outputDir: z.string().default('./agents/librarium'),
  maxParallel: z.number().default(6),
  timeout: z.number().default(30),
  asyncTimeout: z.number().default(1800),
  asyncPollInterval: z.number().default(10),
  mode: z.enum(['sync', 'async', 'mixed']).default('mixed'),
});
export type Defaults = z.infer<typeof DefaultsSchema>;

// Full config schema
export const ConfigSchema = z.object({
  version: z.literal(1),
  defaults: DefaultsSchema,
  providers: z.record(ProviderConfigSchema).default({}),
  groups: z.record(z.array(z.string())).default({}),
});
export type Config = z.infer<typeof ConfigSchema>;

// Project-level config (subset — no providers allowed)
export const ProjectConfigSchema = z.object({
  defaults: z
    .object({
      outputDir: z.string().optional(),
      maxParallel: z.number().optional(),
      timeout: z.number().optional(),
      asyncTimeout: z.number().optional(),
      asyncPollInterval: z.number().optional(),
      mode: z.enum(['sync', 'async', 'mixed']).optional(),
    })
    .optional(),
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
  report?: ProviderReport;
}
