/**
 * Deliberate Node-only services layered on the Worker-safe core API.
 *
 * This entry exposes explicit v2 config-file load/save services while durable
 * run artifacts remain private until their v2 service shapes land.
 */
import {
  type CustomProviderLoadResult,
  loadCustomProviders as loadCustomProvidersInternal,
} from './adapters/custom.js';
import type { ExecutionProfile } from './contracts/domain/index.js';
import { RESERVED_BUILTIN_PROVIDER_IDS } from './core/reserved-provider-ids.js';

export type { CustomProviderLoadResult } from './adapters/custom.js';
export { SCRIPT_CUSTOM_PROVIDER_PROTOCOL_VERSION } from './adapters/custom.js';
export type {
  ApprovalGate,
  FrozenCanonicalExecutor,
  FrozenExecutionOutcome,
  FrozenExecutionState,
  LiveValidationApproval,
} from './commands/live-validation.js';
export {
  approvalFingerprint,
  assertLiveValidationGate,
  continueFrozenValidationProtocol,
  executeFrozenValidationProtocol,
  productionLiveValidationBindingUnavailable,
  readLiveValidationApproval,
} from './commands/live-validation.js';
export type {
  ActualCostSource,
  AdapterBindingIdentity,
  AdmittedSelectedProfile,
  AsyncPollResult,
  AsyncTaskHandle,
  AsyncTaskStatus,
  AttemptExecutionContext,
  AttemptExecutionPort,
  AttemptExecutionResult,
  AttemptFinishedInput,
  AttemptLaunch,
  AvailabilityReason,
  BackgroundProvider,
  BaseProviderOptions,
  BuiltinWorkflowId,
  CanonicalResearchAdmissionResult,
  CatalogProfileBinding,
  CatalogProfileRef,
  CatalogProfileTarget,
  CatalogProviderConfig,
  Citation,
  ConfigMigrationInput,
  ConfigMigrationResult,
  ConfigProviderV2,
  ConfigSourceVersion,
  ConfigValidationResult,
  CoordinationCompareAndSwapResult,
  CoordinationStateStore,
  CoordinatorAttemptState,
  CoordinatorAttemptStatus,
  CoordinatorBudgetState,
  CoordinatorCancellation,
  CoordinatorClock,
  CoordinatorDependencies,
  CoordinatorIdGenerator,
  CoordinatorReserveCandidate,
  CoordinatorSlotState,
  CoordinatorSlotStatus,
  CoordinatorState,
  CoordinatorStatus,
  CoordinatorTerminalOutcome,
  CostConfidence,
  CredentialContext,
  CustomCatalogProfile,
  CustomProviderSourceV2,
  DeclarableWorkflowId,
  DurableHandle,
  EvidenceRequirements,
  ExecutableProfileDeclaration,
  ExecutionDefaultsV2,
  ExecutionProfile,
  ExecutionRuntimeDependencies,
  ExecutionRuntimeResult,
  FrozenPlanningCatalog,
  HttpClient,
  HttpRequestOptions,
  HttpResponse,
  HttpRetryPolicy,
  HttpStreamClient,
  HttpStreamRequestOptions,
  HttpStreamResponse,
  InlineProvider,
  InterchangeRequest,
  JsonValue,
  LegacyProviderTier,
  LibrariumConfigV2,
  LibrariumProjectConfigV2,
  LifecycleEvent,
  MeteringActual,
  MeteringEstimate,
  MeteringKind,
  NetworkFreeEstimate,
  PendingFallbackLaunch,
  PlanningProfile,
  PreparationClock,
  PreparationDependencies,
  PreparationDiagnostic,
  PreparationIdGenerator,
  PreparationIssue,
  PreparationNotice,
  PreparationPhase,
  PreparationResult,
  PreparedProfilePlan,
  PreparedResearchExecution,
  PrivateExecutionPolicy,
  ProfileFeatures,
  ProfileTarget,
  Provider,
  ProviderAttemptBridgeDependencies,
  ProviderCatalog,
  ProviderCatalogEntry,
  ProviderCatalogOptions,
  ProviderCitation,
  ProviderCommon,
  ProviderIdentity,
  ProviderMetering,
  ProviderOptions,
  ProviderResult,
  ProviderSource,
  ProviderUsage,
  RequestSlot,
  ResearchAdmissionResult,
  ResearchError,
  ResearchExecutionAdmission,
  ResearchRequest,
  ResearchResponse,
  ResearchResult,
  ResolvedCatalogProfile,
  ResultProvenance,
  RuntimeConfigV2,
  Source,
  StructuredError,
  UnresolvedAcceptance,
  Usage,
  VersionedCoordinationState,
  WorkflowOmission,
  WorkflowResolutionResult,
} from './core-entry.js';
export {
  admitResearchExecution,
  BUILTIN_PROVIDER_CATALOG,
  buildPrompt,
  buildProviderCatalog,
  CitationSchema,
  ConfigProviderV2Schema,
  CustomProviderExecutionProfileV2Schema,
  CustomProviderSourceV2Schema,
  createProviderAttemptBridge,
  ExecutionDefaultsV2Schema,
  generateSlug,
  HttpRequestAbortedError,
  HttpRequestTimeoutError,
  HttpResponseTooLargeError,
  httpRequest,
  httpStreamRequest,
  InMemoryCoordinationStateStore,
  JsonValueSchema,
  LibrariumConfigV2Schema,
  LibrariumProjectConfigV2Schema,
  materializeResearchExecution,
  migrateConfig,
  NpmCustomProviderSourceV2Schema,
  ProviderCatalogError,
  prepareResearchExecution,
  ResearchErrorSchema,
  ResearchRequestSchema,
  ResearchResponseSchema,
  ResearchResultSchema,
  ResultProvenanceSchema,
  RuntimeConfigV2Schema,
  resolveOutputDir,
  runPreparedExecution,
  ScriptCustomProviderSourceV2Schema,
  SourceSchema,
  UsageSchema,
  updateCoordinationState,
  VERSION,
  validateConfigV2,
} from './core-entry.js';
export { materializeCanonicalPreparedExecution } from './node-canonical-run.js';
export type {
  LoadConfigV2Options,
  SaveConfigV2Options,
} from './node-config-v2.js';
export {
  ConfigV2FileError,
  loadConfigV2,
  projectConfigV2Path,
  saveConfigV2,
} from './node-config-v2.js';
export { createNodeCredentialContext } from './node-credentials.js';
export type {
  CanonicalValidationCheckpoint,
  CanonicalValidationCostAdmission,
  CanonicalValidationExecutor,
  CanonicalValidationMatrix,
  CanonicalValidationPins,
  CanonicalValidationProviderConfig,
  CanonicalValidationTarget,
  FrozenAttemptReference,
} from './node-live-validation.js';
export {
  assertCanonicalTargetDispatchable,
  assertCanonicalValidationPins,
  assertCanonicalValidationPreparedExecution,
  buildCanonicalValidationMatrix,
  CanonicalLiveValidationError,
  CanonicalValidationCheckpointRepository,
  createCanonicalPreparedValidationExecutor,
  deterministicReceiptSensibility,
  executeCanonicalValidationLane,
  executeWithCanonicalValidationAbort,
  interruptCanonicalValidation,
  quoteCanonicalValidationTarget,
  readPrivateRawEvidence,
  sanitizeCanonicalReceipt,
  writePrivateRawEvidence,
  writeSanitizedCanonicalReceipt,
} from './node-live-validation.js';
export { createFilesystemCandidateAuthority } from './node-live-validation-binding.js';

export interface LoadCustomProvidersOptions {
  /** Additional IDs which custom providers may not claim. */
  reservedProviderIds?: Iterable<string>;
}

export interface CustomProviderExecutionProfileConfig {
  bindingId: string;
  profile: ExecutionProfile;
  credential?: { envVar: string };
}

export interface NpmCustomProviderSource {
  type: 'npm';
  module: string;
  export?: string;
  options?: Record<string, unknown>;
  executionProfile?: CustomProviderExecutionProfileConfig;
}

export interface ScriptCustomProviderSource {
  type: 'script';
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  options?: Record<string, unknown>;
  executionProfile?: CustomProviderExecutionProfileConfig;
}

export type CustomProviderSource =
  | NpmCustomProviderSource
  | ScriptCustomProviderSource;

export interface CustomProviderRuntimeConfig {
  apiKey?: string;
  enabled?: boolean;
  model?: string;
  options?: Record<string, unknown>;
  fallback?: string;
}

/** Minimal trusted-provider input; deliberately independent of v1 Config. */
export interface CustomProviderLoadConfig {
  readonly customProviders?: Readonly<Record<string, CustomProviderSource>>;
  readonly trustedProviderIds?: readonly string[];
  readonly providers?: Readonly<Record<string, CustomProviderRuntimeConfig>>;
}

/**
 * Load trusted custom providers without mutating a global registry.
 *
 * The caller owns the returned provider instances and decides how to bind
 * them into its client-scoped execution runtime.
 *
 * SECURITY: trusted npm modules and script declarations execute arbitrary
 * code with this process's permissions and inherited environment. Load only
 * code you explicitly trust; `trustedProviderIds` is an execution allowlist,
 * not a sandbox.
 */
export async function loadCustomProviders(
  config: CustomProviderLoadConfig,
  options: LoadCustomProvidersOptions = {},
): Promise<CustomProviderLoadResult> {
  const reservedProviderIds = new Set([
    ...RESERVED_BUILTIN_PROVIDER_IDS,
    ...(options.reservedProviderIds ?? []),
  ]);

  return loadCustomProvidersInternal({
    customProviders: { ...(config.customProviders ?? {}) },
    trustedProviderIds: [...(config.trustedProviderIds ?? [])],
    providerConfigs: Object.fromEntries(
      Object.entries(config.providers ?? {}).map(([id, provider]) => [
        id,
        { ...provider, enabled: provider.enabled ?? true },
      ]),
    ),
    reservedProviderIds,
  });
}
