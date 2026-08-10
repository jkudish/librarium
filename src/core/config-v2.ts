import { z } from 'zod/v4';
import { OpaqueIdSchema } from '../contracts/common.js';
import type { ExecutionProfile } from '../contracts/domain/index.js';
import { ExecutionProfileSchema } from '../contracts/domain/index.js';
import { fallbackCompatibilityIssues } from '../contracts/interchange/compatibility.js';
import type { RequestSlot } from '../contracts/interchange/request.js';
import {
  adapterProfileBinding,
  adapterProfileBindings,
  buildProfileBindings,
} from './profile-bindings.js';
import { BUILTIN_PROVIDER_CATALOG } from './provider-profiles.js';
import {
  comparePreparationDiagnostics,
  ExactMicrousdSchema,
  type PreparationIssue,
  type PreparationNotice,
  RESEARCH_REQUEST_LIMITS,
} from './research-request.js';
import { RESERVED_BUILTIN_PROVIDER_IDS } from './reserved-provider-ids.js';
import { exactUsdBudgets } from './transport-normalization.js';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
const EnvironmentSchema = z.record(z.string(), z.string());
const ConfigIdSchema = OpaqueIdSchema.refine((value) => !value.includes('/'), {
  message: 'Configuration adapter ids cannot contain "/"',
});
const EnvNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Expected an environment variable name');

export const ConfigProviderV2Schema = z.strictObject({
  enabled: z.boolean(),
  api_key: z.string().optional(),
  model: z.string().optional(),
  options: JsonObjectSchema.optional(),
  fallback: ConfigIdSchema.optional(),
});

const ProjectProviderV2Schema = z.strictObject({
  enabled: z.boolean().optional(),
  api_key: z.string().optional(),
  model: z.string().optional(),
  options: JsonObjectSchema.optional(),
  fallback: ConfigIdSchema.optional(),
});

export const CustomProviderExecutionProfileV2Schema = z.strictObject({
  binding_id: OpaqueIdSchema,
  profile: ExecutionProfileSchema,
  credential: z.strictObject({ env_var: EnvNameSchema }).optional(),
});

export const NpmCustomProviderSourceV2Schema = z.strictObject({
  type: z.literal('npm'),
  module: z.string().trim().min(1),
  export: z.string().trim().min(1).optional(),
  options: JsonObjectSchema.optional(),
  execution_profile: CustomProviderExecutionProfileV2Schema.optional(),
});

export const ScriptCustomProviderSourceV2Schema = z.strictObject({
  type: z.literal('script'),
  command: z.string().trim().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: EnvironmentSchema.optional(),
  options: JsonObjectSchema.optional(),
  execution_profile: CustomProviderExecutionProfileV2Schema.optional(),
});

export const CustomProviderSourceV2Schema = z.discriminatedUnion('type', [
  NpmCustomProviderSourceV2Schema,
  ScriptCustomProviderSourceV2Schema,
]);

export const ExecutionDefaultsV2Schema = z
  .strictObject({
    mode: z.enum(['sync', 'async']),
    max_concurrency: z
      .number()
      .int()
      .min(RESEARCH_REQUEST_LIMITS.minConcurrency)
      .max(RESEARCH_REQUEST_LIMITS.maxConcurrency),
    inline_attempt_deadline_ms: z
      .number()
      .int()
      .min(RESEARCH_REQUEST_LIMITS.minDeadlineMs)
      .max(RESEARCH_REQUEST_LIMITS.maxDeadlineMs),
    background_attempt_deadline_ms: z
      .number()
      .int()
      .min(RESEARCH_REQUEST_LIMITS.minDeadlineMs)
      .max(RESEARCH_REQUEST_LIMITS.maxDeadlineMs),
    poll_interval_ms: z
      .number()
      .int()
      .min(RESEARCH_REQUEST_LIMITS.minPollIntervalMs)
      .max(RESEARCH_REQUEST_LIMITS.maxPollIntervalMs),
    request_deadline_ms: z
      .number()
      .int()
      .min(RESEARCH_REQUEST_LIMITS.minDeadlineMs)
      .max(RESEARCH_REQUEST_LIMITS.maxDeadlineMs)
      .optional(),
    max_actual_cost_microusd: ExactMicrousdSchema.optional(),
    max_estimated_cost_microusd: ExactMicrousdSchema.optional(),
  })
  .superRefine((defaults, ctx) => {
    if (defaults.poll_interval_ms > defaults.background_attempt_deadline_ms) {
      ctx.addIssue({
        code: 'custom',
        path: ['poll_interval_ms'],
        message: 'Poll interval cannot exceed the background attempt deadline',
      });
    }
    if (
      defaults.request_deadline_ms !== undefined &&
      (defaults.request_deadline_ms < defaults.inline_attempt_deadline_ms ||
        defaults.request_deadline_ms < defaults.background_attempt_deadline_ms)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['request_deadline_ms'],
        message: 'Request deadline cannot be shorter than an attempt deadline',
      });
    }
  });

const ProjectExecutionDefaultsV2Schema = z.strictObject({
  mode: z.enum(['sync', 'async']).optional(),
  max_concurrency: z
    .number()
    .int()
    .min(RESEARCH_REQUEST_LIMITS.minConcurrency)
    .max(RESEARCH_REQUEST_LIMITS.maxConcurrency)
    .optional(),
  inline_attempt_deadline_ms: z
    .number()
    .int()
    .min(RESEARCH_REQUEST_LIMITS.minDeadlineMs)
    .max(RESEARCH_REQUEST_LIMITS.maxDeadlineMs)
    .optional(),
  background_attempt_deadline_ms: z
    .number()
    .int()
    .min(RESEARCH_REQUEST_LIMITS.minDeadlineMs)
    .max(RESEARCH_REQUEST_LIMITS.maxDeadlineMs)
    .optional(),
  poll_interval_ms: z
    .number()
    .int()
    .min(RESEARCH_REQUEST_LIMITS.minPollIntervalMs)
    .max(RESEARCH_REQUEST_LIMITS.maxPollIntervalMs)
    .optional(),
  request_deadline_ms: z
    .number()
    .int()
    .min(RESEARCH_REQUEST_LIMITS.minDeadlineMs)
    .max(RESEARCH_REQUEST_LIMITS.maxDeadlineMs)
    .optional(),
  max_actual_cost_microusd: ExactMicrousdSchema.optional(),
  max_estimated_cost_microusd: ExactMicrousdSchema.optional(),
});

const RuntimeModelPreferenceSchema = z.strictObject({
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
});

export const RuntimeConfigV2Schema = z.strictObject({
  output_dir: z.string().trim().min(1),
  llm_web_search: z.boolean(),
  refine: RuntimeModelPreferenceSchema.optional(),
  answer: RuntimeModelPreferenceSchema.optional(),
});

const ProjectRuntimeConfigV2Schema = z.strictObject({
  output_dir: z.string().trim().min(1).optional(),
  llm_web_search: z.boolean().optional(),
  refine: RuntimeModelPreferenceSchema.partial().optional(),
  answer: RuntimeModelPreferenceSchema.partial().optional(),
});

const CustomGroupIdSchema = OpaqueIdSchema.refine(
  (value) =>
    value.startsWith('custom:') &&
    OpaqueIdSchema.safeParse(value.slice('custom:'.length)).success,
  { message: 'Persisted v2 groups must use a non-empty custom:<name> id' },
);

const CustomGroupsV2Schema = z.record(
  CustomGroupIdSchema,
  z.array(OpaqueIdSchema),
);

export const LibrariumConfigV2Schema = z.strictObject({
  version: z.literal(2),
  execution_defaults: ExecutionDefaultsV2Schema,
  providers: z.record(ConfigIdSchema, ConfigProviderV2Schema),
  custom_providers: z.record(ConfigIdSchema, CustomProviderSourceV2Schema),
  trusted_provider_ids: z.array(ConfigIdSchema),
  groups: CustomGroupsV2Schema,
  runtime: RuntimeConfigV2Schema,
});

export const LibrariumProjectConfigV2Schema = z.strictObject({
  version: z.literal(2),
  execution_defaults: ProjectExecutionDefaultsV2Schema.optional(),
  providers: z.record(ConfigIdSchema, ProjectProviderV2Schema).optional(),
  custom_providers: z
    .record(ConfigIdSchema, CustomProviderSourceV2Schema)
    .optional(),
  trusted_provider_ids: z.array(ConfigIdSchema).optional(),
  groups: CustomGroupsV2Schema.optional(),
  runtime: ProjectRuntimeConfigV2Schema.optional(),
});

export type ConfigProviderV2 = z.infer<typeof ConfigProviderV2Schema>;
export type CustomProviderSourceV2 = z.infer<
  typeof CustomProviderSourceV2Schema
>;
export type ExecutionDefaultsV2 = z.infer<typeof ExecutionDefaultsV2Schema>;
export type LibrariumConfigV2 = z.infer<typeof LibrariumConfigV2Schema>;
export type LibrariumProjectConfigV2 = z.infer<
  typeof LibrariumProjectConfigV2Schema
>;
export type RuntimeConfigV2 = z.infer<typeof RuntimeConfigV2Schema>;

const LegacyProviderSchema = z.strictObject({
  apiKey: z.string().optional(),
  enabled: z.boolean().default(true),
  model: z.string().optional(),
  options: JsonObjectSchema.optional(),
  fallback: z.string().optional(),
});

const LegacyProjectProviderSchema = z.strictObject({
  apiKey: z.string().optional(),
  enabled: z.boolean().optional(),
  model: z.string().optional(),
  options: JsonObjectSchema.optional(),
  fallback: z.string().optional(),
});

const LegacyExecutionProfileSchema = z.strictObject({
  bindingId: OpaqueIdSchema,
  profile: ExecutionProfileSchema,
  credential: z.strictObject({ envVar: EnvNameSchema }).optional(),
});

const LegacyNpmSourceSchema = z.strictObject({
  type: z.literal('npm'),
  module: z.string().trim().min(1),
  export: z.string().trim().min(1).optional(),
  options: JsonObjectSchema.optional(),
  executionProfile: LegacyExecutionProfileSchema.optional(),
});

const LegacyScriptSourceSchema = z.strictObject({
  type: z.literal('script'),
  command: z.string().trim().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: EnvironmentSchema.optional(),
  options: JsonObjectSchema.optional(),
  executionProfile: LegacyExecutionProfileSchema.optional(),
});

const LegacySourceSchema = z.discriminatedUnion('type', [
  LegacyNpmSourceSchema,
  LegacyScriptSourceSchema,
]);

const LegacyDefaultsSchema = z.strictObject({
  outputDir: z.string().default('./agents/librarium'),
  maxParallel: z.number().default(6),
  timeout: z.number().default(30),
  asyncTimeout: z.number().default(1800),
  asyncPollInterval: z.number().default(30),
  mode: z.enum(['sync', 'async', 'mixed']).default('mixed'),
  llmWebSearch: z.boolean().default(true),
  maxCostUsd: z.number().finite().optional(),
  maxEstimatedCostUsd: z.number().finite().optional(),
});

const LegacyProjectDefaultsSchema = z.strictObject({
  outputDir: z.string().optional(),
  maxParallel: z.number().optional(),
  timeout: z.number().optional(),
  asyncTimeout: z.number().optional(),
  asyncPollInterval: z.number().optional(),
  mode: z.enum(['sync', 'async', 'mixed']).optional(),
  llmWebSearch: z.boolean().optional(),
  maxCostUsd: z.number().finite().optional(),
  maxEstimatedCostUsd: z.number().finite().optional(),
});

const LegacyPreferenceSchema = z.strictObject({
  provider: z.enum(['openai', 'gemini', 'perplexity']).optional(),
  model: z.string().optional(),
});

const LegacyGlobalSchema = z.strictObject({
  version: z.literal(1),
  defaults: LegacyDefaultsSchema,
  providers: z.record(z.string(), LegacyProviderSchema).default({}),
  customProviders: z.record(z.string(), LegacySourceSchema).default({}),
  trustedProviderIds: z.array(z.string()).default([]),
  groups: z.record(z.string(), z.array(z.string())).default({}),
  refine: LegacyPreferenceSchema.optional(),
  answer: LegacyPreferenceSchema.optional(),
});

const LegacyProjectSchema = z.strictObject({
  version: z.literal(1).optional(),
  defaults: LegacyProjectDefaultsSchema.optional(),
  providers: z.record(z.string(), LegacyProjectProviderSchema).optional(),
  customProviders: z.record(z.string(), LegacySourceSchema).optional(),
  trustedProviderIds: z.array(z.string()).optional(),
  groups: z.record(z.string(), z.array(z.string())).optional(),
  refine: LegacyPreferenceSchema.optional(),
  answer: LegacyPreferenceSchema.optional(),
});

type LegacyGlobal = z.infer<typeof LegacyGlobalSchema>;
type LegacyProject = z.infer<typeof LegacyProjectSchema>;

export interface ConfigMigrationInput {
  readonly global: unknown;
  readonly project?: unknown;
}

export type ConfigSourceVersion = 1 | 2;

export type ConfigValidationResult =
  | {
      readonly ok: true;
      readonly config: LibrariumConfigV2;
      readonly notices: readonly PreparationNotice[];
      readonly fallback_reserve_adapter_ids: readonly string[];
      readonly reserve_only_adapter_ids: readonly string[];
    }
  | {
      readonly ok: false;
      readonly issues: readonly PreparationIssue[];
      readonly notices: readonly PreparationNotice[];
    };

export type ConfigMigrationResult =
  | {
      readonly ok: true;
      readonly config: LibrariumConfigV2;
      readonly source_versions: {
        readonly global: ConfigSourceVersion;
        readonly project?: ConfigSourceVersion;
      };
      readonly notices: readonly PreparationNotice[];
      readonly selection_aliases: Readonly<Record<string, string>>;
      readonly fallback_reserve_adapter_ids: readonly string[];
      readonly reserve_only_adapter_ids: readonly string[];
    }
  | {
      readonly ok: false;
      readonly issues: readonly PreparationIssue[];
      readonly notices: readonly PreparationNotice[];
    };

interface NormalizedLayer {
  readonly version: ConfigSourceVersion;
  readonly execution_defaults?: Partial<ExecutionDefaultsV2>;
  readonly providers: Record<string, Partial<ConfigProviderV2>>;
  readonly custom_providers: Record<string, CustomProviderSourceV2>;
  readonly trusted_provider_ids: string[];
  readonly groups: Record<
    string,
    { readonly members: readonly string[]; readonly legacy: boolean }
  >;
  readonly runtime?: Partial<RuntimeConfigV2>;
  readonly notices: PreparationNotice[];
}

const DEFAULT_V2_CONFIG: LibrariumConfigV2 = {
  version: 2,
  execution_defaults: {
    mode: 'async',
    max_concurrency: 6,
    inline_attempt_deadline_ms: 30_000,
    background_attempt_deadline_ms: 1_800_000,
    poll_interval_ms: 30_000,
  },
  providers: {},
  custom_providers: {},
  trusted_provider_ids: [],
  groups: {},
  runtime: {
    output_dir: './agents/librarium',
    llm_web_search: true,
  },
};

function pointer(path: PropertyKey[]): string {
  if (path.length === 0) return '/';
  return `/${path
    .map(String)
    .map((part) => part.replaceAll('~', '~0').replaceAll('/', '~1'))
    .join('/')}`;
}

function appendPointer(base: string, ...segments: PropertyKey[]): string {
  return `${base}${segments
    .map(String)
    .map((part) => `/${part.replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('')}`;
}

function schemaIssues(
  error: z.ZodError,
  prefix: 'global' | 'project' | undefined,
): PreparationIssue[] {
  return error.issues.map((issue) => ({
    code: 'config_schema_invalid',
    phase: 'migration',
    path: pointer([...(prefix ? [prefix] : []), ...issue.path]),
    message: issue.message,
  }));
}

function issue(code: string, path: string, message: string): PreparationIssue {
  return { code, phase: 'migration', path, message };
}

function notice(
  code: string,
  path: string,
  message: string,
): PreparationNotice {
  return { code, phase: 'migration', path, message };
}

function sortDiagnostics<T extends PreparationIssue | PreparationNotice>(
  values: readonly T[],
): T[] {
  return [...values].sort(comparePreparationDiagnostics);
}

function freeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) freeze(nested);
  return value;
}

type OwnJsonCloneResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issues: readonly PreparationIssue[] };

/**
 * Configuration is intentionally bounded before schema parsing so hostile
 * JSON-like input cannot exhaust the JavaScript call stack. The root
 * container is depth one, so this permits 64 nested arrays/objects and rejects
 * the 65th before descending into it.
 */
const MAX_JSON_NESTING = 64;

function ownJsonClone(
  input: unknown,
  basePath: PropertyKey[] = [],
  initialDepth = 0,
): OwnJsonCloneResult {
  const issues: PreparationIssue[] = [];
  const active = new WeakSet<object>();

  const reject = (path: PropertyKey[], message: string): null => {
    issues.push(issue('config_input_not_plain_json', pointer(path), message));
    return null;
  };

  const rejectTooDeep = (path: PropertyKey[]): null => {
    issues.push(
      issue(
        'config_input_too_deep',
        pointer(path),
        `Configuration nesting cannot exceed ${MAX_JSON_NESTING} arrays or objects.`,
      ),
    );
    return null;
  };

  const clone = (
    value: unknown,
    path: PropertyKey[],
    depth: number,
  ): unknown => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    ) {
      return value;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value)
        ? value
        : reject(path, 'Configuration numbers must be finite JSON values.');
    }
    if (typeof value !== 'object') {
      return reject(
        path,
        'Configuration values must be JSON data without functions, accessors, symbols, bigint, or undefined.',
      );
    }
    if (depth >= MAX_JSON_NESTING) return rejectTooDeep(path);
    if (active.has(value)) {
      return reject(path, 'Configuration values cannot contain cycles.');
    }
    active.add(value);

    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        active.delete(value);
        return reject(
          path,
          'Configuration arrays must use the standard Array prototype.',
        );
      }
      const names = Object.getOwnPropertyNames(value);
      const unexpected = names.filter(
        (name) =>
          name !== 'length' &&
          (!/^(?:0|[1-9]\d*)$/.test(name) || Number(name) >= value.length),
      );
      if (
        Object.getOwnPropertySymbols(value).length > 0 ||
        unexpected.length > 0
      ) {
        active.delete(value);
        return reject(
          path,
          'Configuration arrays cannot contain symbol or named properties.',
        );
      }
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor || !('value' in descriptor)) {
          result.push(
            reject(
              [...path, index],
              'Configuration arrays cannot contain holes or accessor properties.',
            ),
          );
          continue;
        }
        result.push(clone(descriptor.value, [...path, index], depth + 1));
      }
      active.delete(value);
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      active.delete(value);
      return reject(
        path,
        'Configuration objects must use Object.prototype or a null prototype.',
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      active.delete(value);
      return reject(
        path,
        'Configuration objects cannot contain symbol properties.',
      );
    }

    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (!descriptor.enumerable || !('value' in descriptor)) {
        reject(
          [...path, key],
          'Configuration objects cannot contain non-enumerable or accessor properties.',
        );
        continue;
      }
      Object.defineProperty(result, key, {
        value: clone(descriptor.value, [...path, key], depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    active.delete(value);
    return result;
  };

  const value = clone(input, basePath, initialDepth);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

function sourceVersion(
  input: unknown,
  project: boolean,
): ConfigSourceVersion | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return undefined;
  const record = input as Record<string, unknown>;
  const version = Object.hasOwn(record, 'version') ? record.version : undefined;
  if (version === 2) return 2;
  if (version === 1 || (project && version === undefined)) return 1;
  return undefined;
}

const UNSAFE_DICTIONARY_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
const CONFIG_DICTIONARY_FIELDS = new Set([
  'providers',
  'customProviders',
  'custom_providers',
  'groups',
]);

function unsafeDictionaryIssues(
  input: unknown,
  prefix?: 'global' | 'project',
): PreparationIssue[] {
  const issues: PreparationIssue[] = [];
  const basePath: PropertyKey[] = prefix ? [prefix] : [];
  const visit = (value: unknown, path: PropertyKey[]): void => {
    if (typeof value !== 'object' || value === null) return;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        visit(value[index], [...path, index]);
      }
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      // Legacy/native dictionary ids may be persisted as custom:<name>;
      // preserve the historical rejection for prototype names after prefix.
      const parent = path.at(-1);
      const local =
        typeof parent === 'string' &&
        CONFIG_DICTIONARY_FIELDS.has(parent) &&
        key.startsWith('custom:')
          ? key.slice('custom:'.length)
          : key;
      if (UNSAFE_DICTIONARY_KEYS.has(local)) {
        issues.push(
          issue(
            'config_dictionary_key_unsafe',
            pointer([...path, key]),
            'Configuration dictionary keys cannot use JavaScript prototype names.',
          ),
        );
      }
      visit(record[key], [...path, key]);
    }
  };
  visit(input, basePath);
  return issues;
}

function canonicalLegacyId(id: string): string {
  switch (id) {
    case 'perplexity-sonar':
      return 'perplexity-sonar-pro';
    case 'perplexity-deep':
      return 'perplexity-sonar-deep';
    case 'openai-deep':
    case 'openai-deep-o3':
      return 'openai-research';
    default:
      return id;
  }
}

const LEGACY_PROVIDER_ALIASES: ReadonlySet<string> = new Set([
  'perplexity-sonar',
  'perplexity-deep',
  'openai-deep',
  'openai-deep-o3',
]);

function legacyAliasPriority(id: string, canonical: string): number {
  if (id === canonical) return 0;
  if (id === 'openai-deep-o3') return 1;
  if (id === 'openai-deep') return 2;
  return 1;
}

function legacySource(
  source: z.infer<typeof LegacySourceSchema>,
): CustomProviderSourceV2 {
  const { executionProfile, ...portable } = source;
  return {
    ...portable,
    ...(executionProfile && {
      execution_profile: {
        binding_id: executionProfile.bindingId,
        profile: executionProfile.profile,
        ...(executionProfile.credential && {
          credential: {
            env_var: executionProfile.credential.envVar,
          },
        }),
      },
    }),
  };
}

function secondsToMilliseconds(
  value: number,
  path: string,
  issues: PreparationIssue[],
): number | undefined {
  if (!Number.isSafeInteger(value) || value < 1) {
    issues.push(
      issue(
        'config_time_invalid',
        path,
        'Legacy seconds must be a positive safe integer.',
      ),
    );
    return undefined;
  }
  const milliseconds = value * 1_000;
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds > RESEARCH_REQUEST_LIMITS.maxDeadlineMs
  ) {
    issues.push(
      issue(
        'config_time_out_of_range',
        path,
        `The converted value must not exceed ${RESEARCH_REQUEST_LIMITS.maxDeadlineMs}ms.`,
      ),
    );
    return undefined;
  }
  return milliseconds;
}

function legacyProviderLayer(
  providers: Readonly<
    Record<string, z.infer<typeof LegacyProjectProviderSchema>>
  >,
  basePath: string,
  notices: PreparationNotice[],
): Record<string, Partial<ConfigProviderV2>> {
  const grouped = new Map<
    string,
    Array<{
      readonly id: string;
      readonly provider: z.infer<typeof LegacyProjectProviderSchema>;
    }>
  >();
  for (const [id, provider] of Object.entries(providers)) {
    const canonical = canonicalLegacyId(id);
    const candidates = grouped.get(canonical) ?? [];
    candidates.push({ id, provider });
    grouped.set(canonical, candidates);
    if (canonical !== id) {
      notices.push(
        notice(
          'config_provider_alias_migrated',
          appendPointer(basePath, id),
          `Legacy provider "${id}" was migrated to "${canonical}".`,
        ),
      );
    }
  }

  const result = new Map<string, Partial<ConfigProviderV2>>();
  for (const [canonical, candidates] of grouped) {
    const ordered = [...candidates].sort(
      (left, right) =>
        legacyAliasPriority(left.id, canonical) -
          legacyAliasPriority(right.id, canonical) ||
        left.id.localeCompare(right.id),
    );
    const selected = ordered[0];
    if (!selected) continue;
    for (const ignored of ordered.slice(1)) {
      notices.push(
        notice(
          'config_provider_alias_collision',
          appendPointer(basePath, ignored.id),
          `Provider "${ignored.id}" collides with "${selected.id}" after alias migration; "${selected.id}" wins by canonical precedence.`,
        ),
      );
    }
    const { id, provider } = selected;
    const fallback = provider.fallback
      ? canonicalLegacyId(provider.fallback)
      : undefined;
    if (fallback !== provider.fallback && provider.fallback !== undefined) {
      notices.push(
        notice(
          'config_fallback_alias_migrated',
          appendPointer(basePath, id, 'fallback'),
          `Legacy fallback "${provider.fallback}" was migrated to "${fallback}".`,
        ),
      );
    }
    result.set(canonical, {
      ...(provider.enabled !== undefined && { enabled: provider.enabled }),
      ...(provider.apiKey !== undefined && { api_key: provider.apiKey }),
      ...(provider.model !== undefined && { model: provider.model }),
      ...(provider.options !== undefined && { options: provider.options }),
      ...(fallback !== undefined && { fallback }),
    });
  }
  return Object.fromEntries(result);
}

function legacyExecutionDefaults(
  defaults: z.infer<typeof LegacyProjectDefaultsSchema>,
  basePath: string,
  issues: PreparationIssue[],
  notices: PreparationNotice[],
): Partial<ExecutionDefaultsV2> {
  const result: Partial<ExecutionDefaultsV2> = {};
  if (defaults.mode !== undefined) {
    result.mode = defaults.mode === 'mixed' ? 'async' : defaults.mode;
    if (defaults.mode === 'mixed') {
      notices.push(
        notice(
          'legacy_mixed_mode_migrated',
          appendPointer(basePath, 'mode'),
          'Legacy mixed mode was migrated to async.',
        ),
      );
    }
  }
  if (defaults.maxParallel !== undefined) {
    result.max_concurrency = defaults.maxParallel;
  }
  for (const [legacy, canonical] of [
    ['timeout', 'inline_attempt_deadline_ms'],
    ['asyncTimeout', 'background_attempt_deadline_ms'],
    ['asyncPollInterval', 'poll_interval_ms'],
  ] as const) {
    const value = defaults[legacy];
    if (value === undefined) continue;
    const converted = secondsToMilliseconds(
      value,
      appendPointer(basePath, legacy),
      issues,
    );
    if (converted !== undefined) result[canonical] = converted;
  }
  const budgets = exactUsdBudgets(
    defaults.maxCostUsd,
    defaults.maxEstimatedCostUsd,
    basePath,
  );
  issues.push(
    ...budgets.issues.map((diagnostic) => ({
      ...diagnostic,
      phase: 'migration' as const,
    })),
  );
  Object.assign(result, budgets.budgets ?? {});
  return result;
}

function normalizeLegacy(
  input: LegacyGlobal | LegacyProject,
  prefix: 'global' | 'project',
  issues: PreparationIssue[],
): NormalizedLayer {
  const notices: PreparationNotice[] = [];
  const defaults = input.defaults ?? {};
  return {
    version: 1,
    execution_defaults: legacyExecutionDefaults(
      defaults,
      `/${prefix}/defaults`,
      issues,
      notices,
    ),
    providers: legacyProviderLayer(
      input.providers ?? {},
      `/${prefix}/providers`,
      notices,
    ),
    custom_providers: Object.fromEntries(
      Object.entries(input.customProviders ?? {}).map(([id, source]) => [
        id,
        legacySource(source),
      ]),
    ),
    trusted_provider_ids: [...(input.trustedProviderIds ?? [])],
    groups: Object.fromEntries(
      Object.entries(input.groups ?? {}).map(([name, members]) => [
        name,
        { members, legacy: true },
      ]),
    ),
    runtime: {
      ...(defaults.outputDir !== undefined && {
        output_dir: defaults.outputDir,
      }),
      ...(defaults.llmWebSearch !== undefined && {
        llm_web_search: defaults.llmWebSearch,
      }),
      ...(input.refine && { refine: input.refine }),
      ...(input.answer && { answer: input.answer }),
    },
    notices,
  };
}

function normalizeV2(
  input: LibrariumConfigV2 | LibrariumProjectConfigV2,
): NormalizedLayer {
  return {
    version: 2,
    execution_defaults: input.execution_defaults,
    providers: input.providers ?? {},
    custom_providers: input.custom_providers ?? {},
    trusted_provider_ids: [...(input.trusted_provider_ids ?? [])],
    groups: Object.fromEntries(
      Object.entries(input.groups ?? {}).map(([name, members]) => [
        name,
        { members, legacy: false },
      ]),
    ),
    runtime: input.runtime,
    notices: [],
  };
}

function parseLayer(
  input: unknown,
  project: boolean,
  issues: PreparationIssue[],
): NormalizedLayer | undefined {
  const prefix = project ? 'project' : 'global';
  const cloned = ownJsonClone(input, [prefix]);
  if (!cloned.ok) {
    issues.push(...cloned.issues);
    return undefined;
  }
  const safeInput = cloned.value;
  const unsafe = unsafeDictionaryIssues(safeInput, prefix);
  if (unsafe.length > 0) {
    issues.push(...unsafe);
    return undefined;
  }
  const version = sourceVersion(safeInput, project);
  if (version === undefined) {
    issues.push(
      issue(
        'config_version_unsupported',
        `/${prefix}/version`,
        project
          ? 'Project config must omit version for legacy v1 or declare version 1 or 2.'
          : 'Global config must declare supported version 1 or 2.',
      ),
    );
    return undefined;
  }
  const schema =
    version === 1
      ? project
        ? LegacyProjectSchema
        : LegacyGlobalSchema
      : project
        ? LibrariumProjectConfigV2Schema
        : LibrariumConfigV2Schema;
  const parsed = schema.safeParse(safeInput);
  if (!parsed.success) {
    issues.push(...schemaIssues(parsed.error, prefix));
    return undefined;
  }
  return version === 1
    ? normalizeLegacy(
        parsed.data as LegacyGlobal | LegacyProject,
        prefix,
        issues,
      )
    : normalizeV2(parsed.data as LibrariumConfigV2 | LibrariumProjectConfigV2);
}

function mergeObject<T extends object>(base: T, override?: Partial<T>): T {
  return { ...base, ...(override ?? {}) };
}

function mergeProviders(
  base: Readonly<Record<string, ConfigProviderV2>>,
  overrides: Readonly<Record<string, Partial<ConfigProviderV2>>>,
): Record<string, ConfigProviderV2> {
  const merged = new Map<string, ConfigProviderV2>(
    Object.entries(base).map(([id, provider]) => [
      id,
      structuredClone(provider),
    ]),
  );
  for (const [id, override] of Object.entries(overrides)) {
    const current = merged.get(id) ?? { enabled: true };
    merged.set(id, {
      ...current,
      ...override,
      // Provider-specific bags are atomic at the layer boundary. Deep-merging
      // them can retain incompatible global keys the project intentionally
      // replaced.
      ...(override.options !== undefined && { options: override.options }),
    });
  }
  return Object.fromEntries(merged);
}

function exactGroupMember(
  member: string,
  legacy: boolean,
  customProviders: Readonly<Record<string, CustomProviderSourceV2>>,
  trustedCustomIds: ReadonlySet<string>,
): string | undefined {
  const token = legacy ? canonicalLegacyId(member) : member;
  const binding = legacy ? adapterProfileBinding(token) : undefined;
  if (binding) return `${binding.provider_id}/${binding.profile_id}`;
  const customSource =
    trustedCustomIds.has(token) && Object.hasOwn(customProviders, token)
      ? customProviders[token]
      : undefined;
  if (legacy && customSource) {
    const profile = customSource.execution_profile?.profile.identity;
    return profile ? `${profile.provider_id}/${profile.profile_id}` : token;
  }
  const [providerId, profileId, extra] = token.split('/');
  if (!providerId || !profileId || extra) return undefined;
  const builtin = BUILTIN_PROVIDER_CATALOG.some(
    (provider) =>
      provider.provider_id === providerId &&
      provider.profiles.some(
        (profile) =>
          profile.profile_id === profileId && profile.status === 'implemented',
      ),
  );
  const custom = Object.entries(customProviders).some(([id, source]) => {
    if (!trustedCustomIds.has(id)) return false;
    const identity = source.execution_profile?.profile.identity;
    return (
      identity?.provider_id === providerId && identity.profile_id === profileId
    );
  });
  return builtin || custom ? token : undefined;
}

function migrateGroups(
  layers: readonly NormalizedLayer[],
  customProviders: Readonly<Record<string, CustomProviderSourceV2>>,
  trustedCustomIds: ReadonlySet<string>,
  issues: PreparationIssue[],
  notices: PreparationNotice[],
): {
  groups: Record<string, string[]>;
  aliases: Record<string, string>;
} {
  const authored = new Map<
    string,
    { readonly members: readonly string[]; readonly legacy: boolean }
  >();
  for (const layer of layers) {
    for (const [name, definition] of Object.entries(layer.groups)) {
      authored.set(name, definition);
    }
  }
  const groups = new Map<string, string[]>();
  const aliases = new Map<string, string>();
  const sourceByTarget = new Map<string, string>();
  for (const [name, definition] of [...authored].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const target = name.startsWith('custom:') ? name : `custom:${name}`;
    const previous = sourceByTarget.get(target);
    if (previous && previous !== name) {
      issues.push(
        issue(
          'config_group_name_collision',
          pointer(['groups', name]),
          `Both "${previous}" and "${name}" resolve to "${target}"; rename one group.`,
        ),
      );
      continue;
    }
    sourceByTarget.set(target, name);
    if (definition.legacy && name !== target) {
      aliases.set(name, target);
      notices.push(
        notice(
          'config_group_migrated',
          pointer(['groups', name]),
          `Authored group "${name}" was migrated to "${target}".`,
        ),
      );
    }
    const members: string[] = [];
    const seen = new Set<string>();
    for (const [index, member] of definition.members.entries()) {
      const exact = exactGroupMember(
        member,
        definition.legacy,
        customProviders,
        trustedCustomIds,
      );
      if (!exact) {
        issues.push(
          issue(
            'config_group_member_unknown',
            pointer(['groups', name, index]),
            'Group members must resolve to a known implemented built-in or executable custom provider profile.',
          ),
        );
        continue;
      }
      if (definition.legacy && canonicalLegacyId(member) !== member) {
        notices.push(
          notice(
            'config_group_provider_alias_migrated',
            pointer(['groups', name, index]),
            `Legacy group member "${member}" was migrated to "${exact}".`,
          ),
        );
      }
      if (!seen.has(exact)) {
        seen.add(exact);
        members.push(exact);
      }
    }
    groups.set(target, members);
  }
  return {
    groups: Object.fromEntries(groups),
    aliases: Object.fromEntries(aliases),
  };
}

function nativeGroups(
  config: LibrariumConfigV2,
  issues: PreparationIssue[],
): Record<string, string[]> {
  const trustedCustomIds = new Set(config.trusted_provider_ids);
  const normalized = new Map<string, string[]>();
  for (const [name, members] of Object.entries(config.groups)) {
    const exact: string[] = [];
    const seen = new Set<string>();
    for (const [index, member] of members.entries()) {
      const resolved = exactGroupMember(
        member,
        false,
        config.custom_providers,
        trustedCustomIds,
      );
      if (!resolved) {
        issues.push(
          issue(
            'config_group_member_unknown',
            pointer(['groups', name, index]),
            'Native v2 group members must name an implemented built-in or executable custom provider/profile identity.',
          ),
        );
        continue;
      }
      if (!seen.has(resolved)) {
        seen.add(resolved);
        exact.push(resolved);
      }
    }
    normalized.set(name, exact);
  }
  return Object.fromEntries(normalized);
}

function requirementsFor(
  profile: ExecutionProfile,
): RequestSlot['requirements'] {
  return {
    result_kind: profile.result_kind,
    ...(profile.result_kind !== 'search_results' && {
      grounding_policy: profile.grounding_policy,
    }),
    observation_mode: profile.observation_mode,
    corpora: [...profile.corpora],
    retrieval_methods: [profile.retrieval_method],
    ...(profile.surface_id && { surface_id: profile.surface_id }),
  };
}

/**
 * Return one deterministic source id for each non-self fallback cycle. The
 * fallback graph has at most one outgoing edge per provider, so an iterative
 * walk is enough and avoids adding another recursive path to config handling.
 */
function fallbackCycleSources(
  edges: readonly {
    readonly source: string;
    readonly target: string;
  }[],
): string[] {
  const fallbackBySource = new Map(
    edges.map(({ source, target }) => [source, target]),
  );
  const visited = new Set<string>();
  const cycles = new Set<string>();

  for (const start of [...fallbackBySource.keys()].sort()) {
    if (visited.has(start)) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current: string | undefined = start;

    while (
      current !== undefined &&
      fallbackBySource.has(current) &&
      !visited.has(current)
    ) {
      const existing = positions.get(current);
      if (existing !== undefined) {
        const cycle = path.slice(existing);
        if (cycle.length > 1) {
          cycles.add([...cycle].sort().join('\u0000'));
        }
        break;
      }
      positions.set(current, path.length);
      path.push(current);
      current = fallbackBySource.get(current);
    }

    for (const id of path) visited.add(id);
  }

  return [...cycles].map((cycle) => cycle.split('\u0000').sort()[0]).sort();
}

function semanticIssues(config: LibrariumConfigV2): {
  issues: PreparationIssue[];
  notices: PreparationNotice[];
  fallbackReserve: string[];
  reserveOnly: string[];
} {
  const issues: PreparationIssue[] = [];
  const notices: PreparationNotice[] = [];
  const builtinBindings = adapterProfileBindings();
  const customIds = new Set(Object.keys(config.custom_providers));
  const trusted = new Set(config.trusted_provider_ids);
  const enabledCustom = new Set(
    Object.entries(config.providers)
      .filter(([id, provider]) => customIds.has(id) && provider.enabled)
      .map(([id]) => id),
  );

  for (const id of enabledCustom) {
    if (!trusted.has(id)) {
      issues.push(
        issue(
          'config_custom_provider_untrusted',
          pointer(['providers', id, 'enabled']),
          'Enabled custom providers must be explicitly listed in trusted_provider_ids.',
        ),
      );
    }
  }

  for (const id of trusted) {
    if (!customIds.has(id)) {
      issues.push(
        issue(
          'config_trusted_provider_missing',
          pointer([
            'trusted_provider_ids',
            config.trusted_provider_ids.indexOf(id),
          ]),
          'Every trusted provider id must have a matching custom provider declaration.',
        ),
      );
    }
  }

  for (const id of customIds) {
    if (RESERVED_BUILTIN_PROVIDER_IDS.has(id)) {
      issues.push(
        issue(
          'config_custom_provider_id_reserved',
          pointer(['custom_providers', id]),
          'Custom providers cannot claim a current, planned, alias, or retired built-in id.',
        ),
      );
    }
  }

  const declarations = new Map(
    BUILTIN_PROVIDER_CATALOG.flatMap((provider) =>
      provider.profiles.map(
        (profile) =>
          [`${provider.provider_id}/${profile.profile_id}`, profile] as const,
      ),
    ),
  );
  const bindings = buildProfileBindings(declarations);
  const profileByAdapter = new Map<string, ExecutionProfile>();
  const customProfileKeys = new Set<string>(declarations.keys());
  for (const [id, source] of Object.entries(config.custom_providers)) {
    const execution = source.execution_profile;
    if (!execution) {
      if (trusted.has(id) || enabledCustom.has(id)) {
        issues.push(
          issue(
            'config_custom_execution_profile_required',
            pointer(['custom_providers', id, 'execution_profile']),
            'Trusted or enabled custom providers require canonical execution_profile metadata before code loading.',
          ),
        );
      }
      continue;
    }
    const identity = execution.profile.identity;
    const profileKey = `${identity.provider_id}/${identity.profile_id}`;
    if (
      RESERVED_BUILTIN_PROVIDER_IDS.has(identity.provider_id) ||
      identity.provider_id.includes('/') ||
      identity.profile_id.includes('/')
    ) {
      issues.push(
        issue(
          'config_custom_profile_identity_invalid',
          pointer([
            'custom_providers',
            id,
            'execution_profile',
            'profile',
            'identity',
          ]),
          'Custom profile identities must be addressable and cannot claim a built-in provider identity.',
        ),
      );
      continue;
    }
    if (execution.profile.resumability === 'process_local') {
      issues.push(
        issue(
          'config_custom_process_local_unsupported',
          pointer([
            'custom_providers',
            id,
            'execution_profile',
            'profile',
            'resumability',
          ]),
          'Custom canonical profiles must be inline or durably resumable.',
        ),
      );
      continue;
    }
    if (customProfileKeys.has(profileKey)) {
      issues.push(
        issue(
          'config_custom_profile_duplicate',
          pointer([
            'custom_providers',
            id,
            'execution_profile',
            'profile',
            'identity',
          ]),
          'Every custom provider/profile identity must be unique and distinct from built-ins.',
        ),
      );
      continue;
    }
    customProfileKeys.add(profileKey);
    if (trusted.has(id)) profileByAdapter.set(id, execution.profile);
  }

  for (const [id, provider] of Object.entries(config.providers)) {
    const bindingIdentity = builtinBindings.get(id);
    if (LEGACY_PROVIDER_ALIASES.has(id)) {
      issues.push(
        issue(
          'config_provider_alias_removed',
          pointer(['providers', id]),
          'Native v2 config does not accept retired provider aliases; use the canonical adapter id.',
        ),
      );
      continue;
    }
    if (!bindingIdentity && !customIds.has(id)) {
      issues.push(
        issue(
          'config_provider_unknown',
          pointer(['providers', id]),
          'Every provider entry must name a built-in adapter or matching custom provider declaration.',
        ),
      );
    }
    if (!bindingIdentity) continue;
    const binding = bindings.get(
      `${bindingIdentity.provider_id}/${bindingIdentity.profile_id}`,
    );
    const declaration = declarations.get(
      `${bindingIdentity.provider_id}/${bindingIdentity.profile_id}`,
    );
    if (
      provider.model !== undefined &&
      declaration?.target.primary.model_selection !== 'configurable'
    ) {
      issues.push(
        issue(
          'config_model_not_configurable',
          pointer(['providers', id, 'model']),
          'This provider profile does not support selecting a different model.',
        ),
      );
    }
    try {
      const resolved = binding?.resolve({
        model: provider.model,
        options: provider.options,
      });
      if (resolved) profileByAdapter.set(id, resolved.profile);
    } catch (error) {
      issues.push(
        issue(
          'config_provider_options_invalid',
          pointer(['providers', id, 'options']),
          error instanceof Error ? error.message : 'Invalid provider options.',
        ),
      );
    }
  }

  const acceptedEdges: Array<{
    readonly source: string;
    readonly target: string;
  }> = [];
  for (const [id, provider] of Object.entries(config.providers)) {
    const fallback = provider.fallback;
    if (!fallback) continue;
    if (!provider.enabled) {
      notices.push(
        notice(
          'configuration_fallback_disabled_source_omitted',
          pointer(['providers', id, 'fallback']),
          'A fallback from a disabled source adapter was omitted.',
        ),
      );
      continue;
    }
    if (fallback === id) {
      issues.push(
        issue(
          'config_fallback_self_reference',
          pointer(['providers', id, 'fallback']),
          'A provider cannot fall back to itself.',
        ),
      );
      continue;
    }
    const target = Object.hasOwn(config.providers, fallback)
      ? config.providers[fallback]
      : undefined;
    if (!target) {
      issues.push(
        issue(
          'config_fallback_target_unconfigured',
          pointer(['providers', id, 'fallback']),
          'Fallback targets must be explicitly configured.',
        ),
      );
      continue;
    }
    if (!builtinBindings.has(fallback) && !customIds.has(fallback)) {
      issues.push(
        issue(
          'config_fallback_target_unknown',
          pointer(['providers', id, 'fallback']),
          'Fallback target must be a known built-in or declared custom provider.',
        ),
      );
      continue;
    }
    if (customIds.has(fallback) && !trusted.has(fallback)) {
      issues.push(
        issue(
          'config_fallback_target_untrusted',
          pointer(['providers', id, 'fallback']),
          'Custom fallback targets must be explicitly trusted before they can enter the reserve.',
        ),
      );
      continue;
    }
    const sourceProfile = profileByAdapter.get(id);
    const targetProfile = profileByAdapter.get(fallback);
    if (!sourceProfile || !targetProfile) {
      issues.push(
        issue(
          'config_fallback_profile_unavailable',
          pointer(['providers', id, 'fallback']),
          'Fallback source and target must both resolve to executable exact profiles.',
        ),
      );
      continue;
    }
    const compatibility = fallbackCompatibilityIssues(
      {
        slot_id: 'config-fallback-validation',
        position: 0,
        requirements: requirementsFor(sourceProfile),
        primary: sourceProfile,
      },
      targetProfile,
    );
    if (compatibility.length > 0) {
      issues.push(
        issue(
          'config_fallback_incompatible',
          pointer(['providers', id, 'fallback']),
          `Fallback must preserve the source capability and evidence lane (${compatibility.join(', ')}).`,
        ),
      );
      continue;
    }
    acceptedEdges.push({ source: id, target: fallback });
  }

  const cycleSources = fallbackCycleSources(acceptedEdges);
  if (cycleSources.length > 0) {
    for (const id of cycleSources) {
      issues.push(
        issue(
          'config_fallback_cycle',
          pointer(['providers', id, 'fallback']),
          'Fallback providers cannot form a cycle.',
        ),
      );
    }
    // Do not materialize any reserve from a graph that contains a cycle. This
    // keeps the failure before reserve construction and avoids partial plans.
    return { issues, notices, fallbackReserve: [], reserveOnly: [] };
  }

  const fallbackReserve: string[] = [];
  const reserveOnly: string[] = [];
  const seenReserve = new Set<string>();
  for (const { target } of acceptedEdges) {
    if (!seenReserve.has(target)) {
      seenReserve.add(target);
      fallbackReserve.push(target);
    }
    if (
      config.providers[target]?.enabled === false &&
      !reserveOnly.includes(target)
    ) {
      reserveOnly.push(target);
    }
  }
  const acceptedSources = new Set(acceptedEdges.map(({ source }) => source));
  for (const { source, target } of acceptedEdges) {
    if (acceptedSources.has(target)) {
      notices.push(
        notice(
          'configuration_fallback_chain_flattened',
          pointer(['providers', source, 'fallback']),
          'A fallback chain was flattened into the ordered global fallback reserve.',
        ),
      );
    }
  }
  return { issues, notices, fallbackReserve, reserveOnly };
}

function materializeRuntimeProviderDefaults(
  config: LibrariumConfigV2,
): LibrariumConfigV2 {
  const providers = new Map(Object.entries(config.providers));
  for (const [id, provider] of providers) {
    const binding = adapterProfileBinding(id);
    if (
      binding?.profile_id === 'chat' &&
      provider.options?.webSearch === undefined
    ) {
      providers.set(id, {
        ...provider,
        options: {
          ...(provider.options ?? {}),
          webSearch: config.runtime.llm_web_search,
        },
      });
    }
  }
  return {
    ...config,
    providers: Object.fromEntries(providers),
  };
}

export function validateConfigV2(input: unknown): ConfigValidationResult {
  const cloned = ownJsonClone(input);
  if (!cloned.ok) {
    return {
      ok: false,
      issues: sortDiagnostics(cloned.issues),
      notices: [],
    };
  }
  const safeInput = cloned.value;
  const unsafe = unsafeDictionaryIssues(safeInput);
  if (unsafe.length > 0) {
    return {
      ok: false,
      issues: sortDiagnostics(unsafe),
      notices: [],
    };
  }
  const parsed = LibrariumConfigV2Schema.safeParse(safeInput);
  if (!parsed.success) {
    return {
      ok: false,
      issues: sortDiagnostics(schemaIssues(parsed.error, undefined)),
      notices: [],
    };
  }
  const materialized = materializeRuntimeProviderDefaults(parsed.data);
  const groupIssues: PreparationIssue[] = [];
  const normalized = {
    ...materialized,
    groups: nativeGroups(materialized, groupIssues),
  };
  const semantics = semanticIssues(normalized);
  const allIssues = [...groupIssues, ...semantics.issues];
  if (allIssues.length > 0) {
    return {
      ok: false,
      issues: sortDiagnostics(allIssues),
      notices: sortDiagnostics(semantics.notices),
    };
  }
  return freeze({
    ok: true,
    config: structuredClone(normalized),
    notices: sortDiagnostics(semantics.notices),
    fallback_reserve_adapter_ids: semantics.fallbackReserve,
    reserve_only_adapter_ids: semantics.reserveOnly,
  });
}

export function migrateConfig(
  input: ConfigMigrationInput,
): ConfigMigrationResult {
  const issues: PreparationIssue[] = [];
  // The migration wrapper is transport-only; offset it so the nested global
  // and project documents have the same depth budget as direct validation.
  const clonedInput = ownJsonClone(input, [], -1);
  if (!clonedInput.ok) {
    return {
      ok: false,
      issues: sortDiagnostics(clonedInput.issues),
      notices: [],
    };
  }
  if (
    typeof clonedInput.value !== 'object' ||
    clonedInput.value === null ||
    Array.isArray(clonedInput.value)
  ) {
    return {
      ok: false,
      issues: [
        issue(
          'config_migration_input_invalid',
          '/',
          'Migration input must be an object containing an own global config value.',
        ),
      ],
      notices: [],
    };
  }
  const migrationInput = clonedInput.value as Record<string, unknown>;
  const unsafe = unsafeDictionaryIssues(migrationInput);
  if (unsafe.length > 0) {
    return {
      ok: false,
      issues: sortDiagnostics(unsafe),
      notices: [],
    };
  }
  const unexpected = Object.keys(migrationInput).filter(
    (key) => key !== 'global' && key !== 'project',
  );
  for (const key of unexpected) {
    issues.push(
      issue(
        'config_migration_input_unknown_field',
        pointer([key]),
        'Migration input accepts only global and optional project fields.',
      ),
    );
  }
  if (!Object.hasOwn(migrationInput, 'global')) {
    issues.push(
      issue(
        'config_migration_global_required',
        '/global',
        'Migration input requires an own global config value.',
      ),
    );
  }
  const hasProject = Object.hasOwn(migrationInput, 'project');
  const global = Object.hasOwn(migrationInput, 'global')
    ? parseLayer(migrationInput.global, false, issues)
    : undefined;
  const project = hasProject
    ? parseLayer(migrationInput.project, true, issues)
    : undefined;
  const layers = [global, project].filter(
    (layer): layer is NormalizedLayer => layer !== undefined,
  );
  const notices = layers.flatMap((layer) => layer.notices);
  if (!global || (hasProject && !project) || unexpected.length > 0) {
    return {
      ok: false,
      issues: sortDiagnostics(issues),
      notices: sortDiagnostics(notices),
    };
  }

  const executionDefaults = mergeObject(
    mergeObject(
      DEFAULT_V2_CONFIG.execution_defaults,
      global.execution_defaults,
    ),
    project?.execution_defaults,
  );
  let providers = mergeProviders(DEFAULT_V2_CONFIG.providers, global.providers);
  providers = mergeProviders(providers, project?.providers ?? {});
  const customProviders = Object.fromEntries(
    new Map([
      ...Object.entries(global.custom_providers),
      ...Object.entries(project?.custom_providers ?? {}),
    ]),
  );
  const inheritedTrust = new Set(global.trusted_provider_ids);
  for (const id of Object.keys(project?.custom_providers ?? {})) {
    inheritedTrust.delete(id);
  }
  const trustedProviderIds = [
    ...new Set([...inheritedTrust, ...(project?.trusted_provider_ids ?? [])]),
  ];
  const runtime = mergeObject(
    mergeObject(DEFAULT_V2_CONFIG.runtime, global.runtime),
    project?.runtime,
  );
  if (global.runtime?.refine || project?.runtime?.refine) {
    runtime.refine = mergeObject(
      global.runtime?.refine ?? {},
      project?.runtime?.refine,
    );
  }
  if (global.runtime?.answer || project?.runtime?.answer) {
    runtime.answer = mergeObject(
      global.runtime?.answer ?? {},
      project?.runtime?.answer,
    );
  }
  const migratedGroups = migrateGroups(
    layers,
    customProviders,
    new Set(trustedProviderIds),
    issues,
    notices,
  );

  const candidate = {
    version: 2 as const,
    execution_defaults: executionDefaults,
    providers,
    custom_providers: customProviders,
    trusted_provider_ids: trustedProviderIds,
    groups: migratedGroups.groups,
    runtime,
  };
  const validation = validateConfigV2(candidate);
  if (!validation.ok) issues.push(...validation.issues);
  notices.push(...validation.notices);
  if (issues.length > 0 || !validation.ok) {
    return {
      ok: false,
      issues: sortDiagnostics(issues),
      notices: sortDiagnostics(notices),
    };
  }

  return freeze({
    ok: true,
    config: validation.config,
    source_versions: {
      global: global.version,
      ...(project && { project: project.version }),
    },
    notices: sortDiagnostics(notices),
    selection_aliases: Object.fromEntries(
      Object.entries(migratedGroups.aliases).sort(),
    ),
    fallback_reserve_adapter_ids: validation.fallback_reserve_adapter_ids,
    reserve_only_adapter_ids: validation.reserve_only_adapter_ids,
  });
}
