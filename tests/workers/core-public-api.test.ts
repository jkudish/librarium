import { describe, expect, it } from 'vitest';
import * as core from '../../src/core-entry.js';

const CORE_RUNTIME_EXPORTS = [
  'BUILTIN_PROVIDER_CATALOG',
  'CitationSchema',
  'ConfigProviderV2Schema',
  'CustomProviderExecutionProfileV2Schema',
  'CustomProviderSourceV2Schema',
  'ExecutionDefaultsV2Schema',
  'HttpRequestAbortedError',
  'HttpRequestTimeoutError',
  'HttpResponseTooLargeError',
  'InMemoryCoordinationStateStore',
  'JsonValueSchema',
  'LibrariumConfigV2Schema',
  'LibrariumProjectConfigV2Schema',
  'NpmCustomProviderSourceV2Schema',
  'ProviderCatalogError',
  'ResearchErrorSchema',
  'ResearchRequestSchema',
  'ResearchResponseSchema',
  'ResearchResultSchema',
  'ResultProvenanceSchema',
  'RuntimeConfigV2Schema',
  'ScriptCustomProviderSourceV2Schema',
  'SourceSchema',
  'UsageSchema',
  'VERSION',
  'admitResearchExecution',
  'buildPrompt',
  'buildProviderCatalog',
  'createProviderAttemptBridge',
  'generateSlug',
  'httpRequest',
  'httpStreamRequest',
  'materializeResearchExecution',
  'migrateConfig',
  'prepareResearchExecution',
  'resolveOutputDir',
  'runPreparedExecution',
  'updateCoordinationState',
  'validateConfigV2',
].sort();

describe('librarium/core Worker API', () => {
  it('exports the exact supported runtime surface in workerd', () => {
    expect(Object.keys(core).sort()).toEqual(CORE_RUNTIME_EXPORTS);
  });

  it('does not expose Node-only configuration or module loading APIs', () => {
    expect(core).not.toHaveProperty('loadConfigV2');
    expect(core).not.toHaveProperty('saveConfigV2');
    expect(core).not.toHaveProperty('loadCustomProviders');
  });
});
