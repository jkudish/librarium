/** Advanced, Worker-safe planning and execution ports. */

export type { BaseProviderOptions } from './adapters/base.js';
export type {
  DurableHandle,
  StructuredError,
} from './contracts/domain/index.js';
export type { LifecycleEvent } from './contracts/interchange/internal.js';
export type {
  EvidenceRequirements,
  InterchangeRequest,
  RequestSlot,
} from './contracts/interchange/request.js';
export type {
  AttemptFinishedInput,
  AttemptLaunch,
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
  PendingFallbackLaunch,
  UnresolvedAcceptance,
} from './core/coordinator.js';
export type {
  CoordinationCompareAndSwapResult,
  CoordinationStateStore,
  VersionedCoordinationState,
} from './core/coordinator-store.js';
export {
  InMemoryCoordinationStateStore,
  updateCoordinationState,
} from './core/coordinator-store.js';
export type { CredentialContext } from './core/credentials.js';
export type {
  AdapterBindingIdentity,
  AdmittedSelectedProfile,
  CanonicalResearchAdmissionResult,
  FrozenPlanningCatalog,
  NetworkFreeEstimate,
  PlanningProfile,
  PreparationClock,
  PreparationDependencies,
  PreparationIdGenerator,
  PreparationResult,
  PreparedProfilePlan,
  PreparedResearchExecution,
  PrivateExecutionPolicy,
  ResearchAdmissionResult,
  ResearchExecutionAdmission,
} from './core/execution-plan.js';
export {
  admitResearchExecution,
  materializeResearchExecution,
  prepareResearchExecution,
} from './core/execution-plan.js';
export type {
  AttemptExecutionContext,
  AttemptExecutionPort,
  AttemptExecutionResult,
  ExecutionRuntimeDependencies,
  ExecutionRuntimeResult,
} from './core/execution-runtime.js';
export { runPreparedExecution } from './core/execution-runtime.js';
export type {
  HttpClient,
  HttpRequestOptions,
  HttpResponse,
  HttpRetryPolicy,
  HttpStreamClient,
  HttpStreamRequestOptions,
  HttpStreamResponse,
} from './core/http-client.js';
export {
  HttpRequestAbortedError,
  HttpRequestTimeoutError,
  HttpResponseTooLargeError,
  httpRequest,
  httpStreamRequest,
} from './core/http-client.js';
export type {
  AvailabilityReason,
  CatalogProfileBinding,
  CatalogProfileTarget,
  CatalogProviderConfig,
  CustomCatalogProfile,
  ProviderCatalog,
  ProviderCatalogOptions,
  ResolvedCatalogProfile,
  WorkflowOmission,
  WorkflowResolutionResult,
} from './core/profile-catalog.js';
export {
  buildProviderCatalog,
  ProviderCatalogError,
} from './core/profile-catalog.js';
export {
  buildPrompt,
  generateSlug,
  resolveOutputDir,
} from './core/prompt-builder.js';
export type { ProviderAttemptBridgeDependencies } from './core/provider-attempt-bridge.js';
export { createProviderAttemptBridge } from './core/provider-attempt-bridge.js';
export type {
  PreparationDiagnostic,
  PreparationIssue,
  PreparationNotice,
  PreparationPhase,
} from './core/research-request.js';
export type {
  BuiltinWorkflowId,
  CatalogProfileRef,
  Citation,
  ConfigMigrationInput,
  ConfigMigrationResult,
  ConfigProviderV2,
  ConfigSourceVersion,
  ConfigValidationResult,
  CustomProviderSourceV2,
  DeclarableWorkflowId,
  ExecutableProfileDeclaration,
  ExecutionDefaultsV2,
  ExecutionProfile,
  JsonValue,
  LibrariumConfigV2,
  LibrariumProjectConfigV2,
  ProfileFeatures,
  ProfileTarget,
  ProviderCatalogEntry,
  ProviderIdentity,
  ResearchError,
  ResearchRequest,
  ResearchResponse,
  ResearchResult,
  ResultProvenance,
  RuntimeConfigV2,
  Source,
  Usage,
} from './index.js';
export {
  BUILTIN_PROVIDER_CATALOG,
  CitationSchema,
  ConfigProviderV2Schema,
  CustomProviderExecutionProfileV2Schema,
  CustomProviderSourceV2Schema,
  ExecutionDefaultsV2Schema,
  JsonValueSchema,
  LibrariumConfigV2Schema,
  LibrariumProjectConfigV2Schema,
  migrateConfig,
  NpmCustomProviderSourceV2Schema,
  ResearchErrorSchema,
  ResearchRequestSchema,
  ResearchResponseSchema,
  ResearchResultSchema,
  ResultProvenanceSchema,
  RuntimeConfigV2Schema,
  ScriptCustomProviderSourceV2Schema,
  SourceSchema,
  UsageSchema,
  VERSION,
  validateConfigV2,
} from './index.js';
export type {
  ActualCostSource,
  AsyncPollResult,
  AsyncTaskHandle,
  AsyncTaskStatus,
  BackgroundProvider,
  Citation as ProviderCitation,
  CostConfidence,
  InlineProvider,
  MeteringActual,
  MeteringEstimate,
  MeteringKind,
  Provider,
  ProviderCommon,
  ProviderMetering,
  ProviderOptions,
  ProviderResult,
  ProviderSource,
  ProviderTier as LegacyProviderTier,
  ProviderUsage,
} from './types.js';
