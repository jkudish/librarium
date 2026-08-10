/**
 * Side-effect-free, Worker-safe public API.
 *
 * Keep this entry deliberately small: importing `librarium` must never start
 * the CLI, inspect the host, touch files, initialize adapters, or install
 * process handlers.
 */
export { VERSION } from './constants.js';
export type {
  ExecutionProfile,
  ProfileTarget,
  ProviderIdentity,
} from './contracts/domain/index.js';
export type {
  ResearchError,
  ResearchResponse,
} from './contracts/interchange/research-response.js';
export {
  ResearchErrorSchema,
  ResearchResponseSchema,
} from './contracts/interchange/research-response.js';
export type {
  Citation,
  ResearchResult,
  ResultProvenance,
  Source,
  Usage,
} from './contracts/interchange/research-result.js';
export {
  CitationSchema,
  ResearchResultSchema,
  ResultProvenanceSchema,
  SourceSchema,
  UsageSchema,
} from './contracts/interchange/research-result.js';
export type {
  BuiltinWorkflowId,
  DeclarableWorkflowId,
} from './core/builtin-workflows.js';
export type {
  CatalogProfileRef,
  ExecutableProfileDeclaration,
  ProfileFeatures,
  ProviderCatalogEntry,
} from './core/provider-profiles.js';
export { BUILTIN_PROVIDER_CATALOG } from './core/provider-profiles.js';
export type { CanonicalResearchRequest as ResearchRequest } from './core/research-request.js';
export { CanonicalResearchRequestSchema as ResearchRequestSchema } from './core/research-request.js';
