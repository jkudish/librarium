import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { z } from 'zod/v4';
import {
  ARTIFACTS_VERSION,
  ArtifactProducerSchema,
  ArtifactSchema,
  ContractFixtureIndexSchema,
  ContractSnapshotManifestSchema,
  HistoricalArtifactReaderSchema,
  JsonlArtifactRecordSchema,
  ProviderMetadataArtifactSchema,
  RunManifestArtifactSchema,
  SourcesArtifactSchema,
} from '../src/contracts/artifacts/index.js';
import {
  CUSTOM_PROVIDER_PROTOCOL_VERSION,
  CustomProviderExchangeSchema,
  CustomProviderRequestSchema,
  CustomProviderResponseSchema,
} from '../src/contracts/custom-provider/index.js';
import {
  CitationSchema,
  CollectionProvenanceSchema,
  DOMAIN_VERSION,
  DurableHandleSchema,
  ExecutionProfileSchema,
  NormalizedSourceSchema,
  ProviderIdentitySchema,
  SemanticFactsSchema,
  StructuredErrorSchema,
  SurfaceContextConstraintSchema,
  SurfaceContextSchema,
  UsageSchema,
} from '../src/contracts/domain/index.js';
import {
  durableResearchProfile,
  representativeArtifactReader,
  representativeCustomProviderExchange,
  representativeCustomProviderTerminalPollExchange,
  representativeLifecycleTrace,
  representativePartialResponse,
  representativeRequest,
  representativeRunManifest,
  representativeSearchRequest,
  representativeSurfaceContextRequest,
  representativeUnsuccessfulResponse,
  SNAPSHOT_GENERATED_AT,
} from '../src/contracts/examples.js';
import {
  AttemptSchema,
  EvidenceRequirementsSchema,
  INTERCHANGE_VERSION,
  InterchangeMessageSchema,
  InterchangeRequestSchema,
  InterchangeResponseSchema,
  InterchangeResultSchema,
  LifecycleEventSchema,
  LifecycleTraceSchema,
  RequestSlotSchema,
  SlotOutcomeSchema,
} from '../src/contracts/interchange/index.js';
import { resolveSnapshotWritePath } from './contract-snapshot-path.js';

const root =
  process.env.LIBRARIUM_CONTRACTS_OUTPUT ??
  join(process.cwd(), 'contracts', 'v1');

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function write(relativePath: string, value: unknown): string {
  const path = resolveSnapshotWritePath(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  const content = typeof value === 'string' ? value : canonicalJson(value);
  writeFileSync(resolveSnapshotWritePath(root, relativePath), content);
  return relativePath;
}

function areaSchema(
  id: string,
  title: string,
  definitions: Record<string, z.ZodType>,
): Record<string, unknown> {
  const escapeJsonPointerToken = (token: string): string =>
    token.replace(/~/g, '~0').replace(/\//g, '~1');

  const rewriteLocalRefs = (
    value: unknown,
    definitionName: string,
  ): unknown => {
    if (Array.isArray(value)) {
      return value.map((item) => rewriteLocalRefs(item, definitionName));
    }
    if (!value || typeof value !== 'object') return value;

    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (
          key === '$ref' &&
          typeof child === 'string' &&
          child.startsWith('#')
        ) {
          const definitionRef = `#/$defs/${escapeJsonPointerToken(definitionName)}`;
          return [
            key,
            child === '#' ? definitionRef : `${definitionRef}${child.slice(1)}`,
          ];
        }
        return [key, rewriteLocalRefs(child, definitionName)];
      }),
    );
  };

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: id,
    title,
    $defs: Object.fromEntries(
      Object.entries(definitions).map(([name, schema]) => {
        const jsonSchema = z.toJSONSchema(schema, { target: 'draft-2020-12' });
        delete jsonSchema.$schema;
        return [name, rewriteLocalRefs(jsonSchema, name)];
      }),
    ),
  };
}

const schemaFiles = [
  write(
    'schema/domain.schema.json',
    areaSchema(
      'https://librarium.dev/contracts/v1/domain',
      'Librarium domain contracts',
      {
        citation: CitationSchema,
        collection_provenance: CollectionProvenanceSchema,
        durable_handle: DurableHandleSchema,
        execution_profile: ExecutionProfileSchema,
        normalized_source: NormalizedSourceSchema,
        provider_identity: ProviderIdentitySchema,
        semantic_facts: SemanticFactsSchema,
        structured_error: StructuredErrorSchema,
        surface_context: SurfaceContextSchema,
        surface_context_constraint: SurfaceContextConstraintSchema,
        usage: UsageSchema,
      },
    ),
  ),
  write(
    'schema/artifacts.schema.json',
    areaSchema(
      'https://librarium.dev/contracts/v1/artifacts',
      'Librarium artifact contracts',
      {
        artifact_producer: ArtifactProducerSchema,
        artifact: ArtifactSchema,
        fixture_index: ContractFixtureIndexSchema,
        snapshot_manifest: ContractSnapshotManifestSchema,
        historical_reader: HistoricalArtifactReaderSchema,
        jsonl_record: JsonlArtifactRecordSchema,
        provider_metadata: ProviderMetadataArtifactSchema,
        run_manifest: RunManifestArtifactSchema,
        sources: SourcesArtifactSchema,
      },
    ),
  ),
  write(
    'schema/custom-provider.schema.json',
    areaSchema(
      'https://librarium.dev/contracts/v1/custom-provider',
      'Librarium custom-provider protocol',
      {
        exchange: CustomProviderExchangeSchema,
        request: CustomProviderRequestSchema,
        response: CustomProviderResponseSchema,
      },
    ),
  ),
  write(
    'schema/interchange.schema.json',
    areaSchema(
      'https://librarium.dev/contracts/v1/interchange',
      'Librarium language-neutral interchange',
      {
        attempt: AttemptSchema,
        evidence_requirements: EvidenceRequirementsSchema,
        lifecycle_event: LifecycleEventSchema,
        lifecycle_trace: LifecycleTraceSchema,
        message: InterchangeMessageSchema,
        request: InterchangeRequestSchema,
        request_slot: RequestSlotSchema,
        response: InterchangeResponseSchema,
        result: InterchangeResultSchema,
        slot_outcome: SlotOutcomeSchema,
      },
    ),
  ),
];

const clone = <T>(value: T): T => structuredClone(value);

const invalidRequestUnknown = clone(representativeRequest) as Record<
  string,
  unknown
>;
invalidRequestUnknown.query_text = invalidRequestUnknown.query;

const invalidRequestTimestamp = clone(representativeRequest);
invalidRequestTimestamp.requested_at = '2026-08-08T00:00:00+00:00';

const invalidAsyncRequest = clone(representativeRequest);
invalidAsyncRequest.mode = 'async';

const invalidFallback = clone(representativeRequest);
invalidFallback.fallback_reserve[0]!.profile.result_kind = 'model_answer';

const invalidSecretExtension = clone(representativeRequest);
invalidSecretExtension.extensions = {
  'com.example:authorization': 'redacted-but-forbidden-field',
};

const invalidError = clone(representativePartialResponse) as Record<
  string,
  any
>;
delete invalidError.attempts[0].error.fallback_allowed;

const invalidLifecycle = clone(representativeLifecycleTrace);
invalidLifecycle[2]!.sequence = 1;

const invalidResultReference = clone(representativePartialResponse);
invalidResultReference.results[0]!.attempt_id = 'attempt-does-not-exist';

const invalidMoney = clone(representativePartialResponse) as Record<
  string,
  any
>;
invalidMoney.attempts[2].usage.actual_cost.amount.amount_decimal = 0.25;

const invalidCitation = clone(representativePartialResponse);
invalidCitation.results[0]!.citations[0]!.source_kind =
  'blog_post' as 'web_page';

const invalidProvenance = clone(representativePartialResponse);
invalidProvenance.results[0]!.provenance.request_id = 'req-does-not-match';

const invalidDurableHandle = clone(representativePartialResponse);
invalidDurableHandle.attempts[2]!.durable_handle!.submitted_at =
  '2026-08-08T00:00:06+00:00';

const invalidPartialOutcome = clone(representativePartialResponse);
invalidPartialOutcome.slots[1] = {
  slot_id: 'slot-research',
  slot_status: 'pending',
  selected_attempt_id: 'attempt-research-primary',
};

const invalidMissingSurfaceContext = clone(
  representativeSurfaceContextRequest,
) as Record<string, any>;
delete invalidMissingSurfaceContext.slots[0].primary.surface_context;

const invalidUnknownConstrainedAccountContext = clone(
  representativeSurfaceContextRequest,
);
invalidUnknownConstrainedAccountContext
  .slots[0]!.requirements.surface_context_constraint = {
  account_context: 'anonymous',
};

const invalidUnknownConstrainedPersonalization = clone(
  representativeSurfaceContextRequest,
);
invalidUnknownConstrainedPersonalization
  .slots[0]!.requirements.surface_context_constraint = {
  personalization: 'absent',
};
invalidUnknownConstrainedPersonalization.slots[0]!.primary
  .surface_context!.personalization = 'unknown';

const invalidFallbackSurfaceContext = clone(
  representativeSurfaceContextRequest,
);
invalidFallbackSurfaceContext.fallback_reserve[0]!.profile
  .surface_context!.locale = 'en-US';

const invalidSearchProfileGrounding = clone(representativeSearchRequest) as any;
invalidSearchProfileGrounding.slots[0].primary.grounding_policy = 'none';

const invalidSearchRequirementGrounding = clone(
  representativeSearchRequest,
) as any;
invalidSearchRequirementGrounding.slots[0].requirements.grounding_policy =
  'none';

const invalidAnswerMissingGrounding = clone(representativeRequest) as any;
delete invalidAnswerMissingGrounding.slots[0].primary.grounding_policy;

const invalidRunManifestStorageField = clone(
  representativeRunManifest,
) as Record<string, unknown>;
invalidRunManifestStorageField.run_id = 'redundant-run-id';

const invalidRequestMissingSeconds = clone(representativeRequest);
invalidRequestMissingSeconds.requested_at = '2026-08-08T00:00Z';

const invalidNestedCamelCaseSecret = clone(representativeRequest);
invalidNestedCamelCaseSecret.extensions = {
  'com.example:publicMetadata': {
    accountContext: {
      refreshToken: 'fixture-secret-value-must-never-appear-in-errors',
    },
  },
};

const invalidDecimalTooLong = clone(representativePartialResponse) as Record<
  string,
  any
>;
invalidDecimalTooLong.attempts[2].usage.actual_cost.amount.amount_decimal =
  '1'.repeat(129);

const invalidCitationUrl = clone(representativePartialResponse);
invalidCitationUrl.results[0]!.citations[0]!.url = 'ftp://example.com/source';

const invalidCitationLocator = clone(representativePartialResponse) as Record<
  string,
  any
>;
delete invalidCitationLocator.results[0].citations[0].url;
delete invalidCitationLocator.results[0].citations[0].provider_reference;

const invalidSelectedAttempt = clone(representativePartialResponse);
invalidSelectedAttempt.slots[0]!.selected_attempt_id =
  'attempt-grounded-primary';

const invalidEffectiveProfile = clone(representativePartialResponse);
invalidEffectiveProfile.results[0]!.provenance.effective_profile = clone(
  invalidEffectiveProfile.results[0]!.provenance.effective_profile,
);
invalidEffectiveProfile
  .results[0]!.provenance.effective_profile.identity.profile_id =
  'mismatched-profile';

const invalidCollectionProvider = clone(representativePartialResponse);
invalidCollectionProvider.results[0]!.provenance.collection.provider = clone(
  invalidCollectionProvider.results[0]!.provenance.collection.provider,
);
invalidCollectionProvider
  .results[0]!.provenance.collection.provider.profile_id = 'mismatched-profile';

const invalidReplacementProvenance = clone(
  representativePartialResponse,
) as Record<string, any>;
delete invalidReplacementProvenance.results[0].provenance.replaced_attempt_id;

const invalidMixedUnsuccessfulStatus = clone(
  representativeUnsuccessfulResponse,
);
invalidMixedUnsuccessfulStatus.response_status = 'failed' as 'unsuccessful';

const invalidLifecycleFailedWithoutError = clone(
  representativeLifecycleTrace,
) as Record<string, any>[];
delete invalidLifecycleFailedWithoutError[2]!.data.error;

const invalidLifecycleSucceededWithError = clone(
  representativeLifecycleTrace,
) as Record<string, any>[];
invalidLifecycleSucceededWithError[5]!.data.error = clone(
  invalidLifecycleFailedWithoutError[9]!.data.error ??
    representativePartialResponse.errors[0],
);

const invalidCustomProviderTerminalHandle = {
  request: {
    protocol_version: '1.0.0',
    message_type: 'submit',
    request_id: 'req-custom-submit-001',
    attempt_id: 'attempt-custom-submit-001',
    sent_at: '2026-08-08T00:00:00Z',
    query: 'Run a background research task.',
    profile: durableResearchProfile,
  },
  response: {
    protocol_version: '1.0.0',
    message_type: 'submitted',
    request_id: 'req-custom-submit-001',
    attempt_id: 'attempt-custom-submit-001',
    emitted_at: '2026-08-08T00:00:01Z',
    durable_handle: {
      handle_id: 'handle-custom-submit-001',
      provider_task_id: 'public-provider-task-001',
      provider: durableResearchProfile.identity,
      submitted_at: '2026-08-08T00:00:01Z',
      status: 'succeeded',
    },
  },
};

const invalidCustomProviderProgressTerminal = clone(
  representativeCustomProviderTerminalPollExchange,
) as Record<string, any>;
invalidCustomProviderProgressTerminal.response.message_type = 'progress';

const invalidCustomProviderStatusHandleBinding = clone(
  representativeCustomProviderTerminalPollExchange,
) as Record<string, any>;
invalidCustomProviderStatusHandleBinding.response.durable_handle.handle_id =
  'handle-does-not-match';

const invalidCustomProviderResultIdentifiers = clone(
  representativeCustomProviderExchange,
);
invalidCustomProviderResultIdentifiers.response.result.provenance.slot_id =
  'slot-does-not-match';

const invalidRunManifestSlotOrder = clone(representativeRunManifest);
invalidRunManifestSlotOrder.response.slots.reverse();

const invalidRunManifestFallbackCandidate = clone(representativeRunManifest);
invalidRunManifestFallbackCandidate.response.attempts[1]!.candidate_id =
  'candidate-does-not-exist';

const invalidRunManifestPrimaryProfile = clone(representativeRunManifest);
invalidRunManifestPrimaryProfile.response.attempts[0]!.profile = clone(
  invalidRunManifestPrimaryProfile.request.fallback_reserve[0]!.profile,
);

const representativeSpecializedResponse = clone(representativePartialResponse);
const specializedProfile = clone(
  representativeSpecializedResponse.attempts[1]!.profile,
);
specializedProfile.corpora = ['specialized'];
representativeSpecializedResponse.attempts[1]!.profile = specializedProfile;
representativeSpecializedResponse.results[0]!.semantic_facts.corpora = [
  'specialized',
];
representativeSpecializedResponse.results[0]!.semantic_facts.retrieval_methods =
  ['search_endpoint'];
representativeSpecializedResponse.results[0]!.provenance.effective_profile =
  clone(specializedProfile);
representativeSpecializedResponse.results[0]!.citations[0] = {
  ...representativeSpecializedResponse.results[0]!.citations[0]!,
  source_kind: 'data_record',
  source_category: 'patent_record',
  dataset_id: 'dataset-public-001',
  provider_reference: 'record-public-001',
  url: undefined,
};

const invalidSourceCategoryTooLong = clone(representativeSpecializedResponse);
invalidSourceCategoryTooLong.results[0]!.citations[0]!.source_category =
  `a${'b'.repeat(128)}`;

const fixtureDefinitions = [
  {
    id: 'valid.interchange_request',
    area: 'interchange',
    schema: 'interchange_request',
    valid: true,
    path: 'fixtures/valid/interchange-request.json',
    payload: representativeRequest,
  },
  {
    id: 'valid.search_results_request',
    area: 'interchange',
    schema: 'interchange_request',
    valid: true,
    path: 'fixtures/valid/search-results-request.json',
    payload: representativeSearchRequest,
  },
  {
    id: 'valid.locale_only_surface_context',
    area: 'interchange',
    schema: 'interchange_request',
    valid: true,
    path: 'fixtures/valid/locale-only-surface-context.json',
    payload: representativeSurfaceContextRequest,
  },
  {
    id: 'valid.partial_response',
    area: 'interchange',
    schema: 'interchange_response',
    valid: true,
    path: 'fixtures/valid/partial-response.json',
    payload: representativePartialResponse,
  },
  {
    id: 'valid.lifecycle_trace',
    area: 'interchange',
    schema: 'lifecycle_trace',
    valid: true,
    path: 'fixtures/valid/lifecycle-trace.json',
    payload: representativeLifecycleTrace,
  },
  {
    id: 'valid.run_manifest',
    area: 'artifacts',
    schema: 'run_manifest',
    valid: true,
    path: 'fixtures/valid/run-manifest.json',
    payload: representativeRunManifest,
  },
  {
    id: 'valid.custom_provider_exchange',
    area: 'custom_provider',
    schema: 'custom_provider_exchange',
    valid: true,
    path: 'fixtures/valid/custom-provider-exchange.json',
    payload: representativeCustomProviderExchange,
  },
  {
    id: 'valid.custom_provider_terminal_poll_exchange',
    area: 'custom_provider',
    schema: 'custom_provider_exchange',
    valid: true,
    path: 'fixtures/valid/custom-provider-terminal-poll-exchange.json',
    payload: representativeCustomProviderTerminalPollExchange,
  },
  {
    id: 'valid.artifact_reader',
    area: 'artifacts',
    schema: 'historical_artifact_reader',
    valid: true,
    path: 'fixtures/valid/artifact-reader.json',
    payload: representativeArtifactReader,
  },
  {
    id: 'valid.unsuccessful_response',
    area: 'interchange',
    schema: 'interchange_response',
    valid: true,
    path: 'fixtures/valid/unsuccessful-response.json',
    payload: representativeUnsuccessfulResponse,
  },
  {
    id: 'valid.specialized_data_record_response',
    area: 'interchange',
    schema: 'interchange_response',
    valid: true,
    path: 'fixtures/valid/specialized-data-record-response.json',
    payload: representativeSpecializedResponse,
  },
  {
    id: 'invalid.request_unknown_field',
    area: 'interchange',
    schema: 'interchange_request',
    valid: false,
    expected_issue_path: '',
    path: 'fixtures/invalid/request-unknown-field.json',
    payload: invalidRequestUnknown,
  },
  {
    id: 'invalid.request_non_utc_timestamp',
    area: 'interchange',
    schema: 'interchange_request',
    valid: false,
    expected_issue_path: '/requested_at',
    path: 'fixtures/invalid/request-non-utc-timestamp.json',
    payload: invalidRequestTimestamp,
  },
  {
    id: 'invalid.async_non_durable_profile',
    area: 'interchange',
    schema: 'interchange_request',
    valid: false,
    expected_issue_path: '/slots/0/primary/resumability',
    path: 'fixtures/invalid/async-non-durable-profile.json',
    payload: invalidAsyncRequest,
  },
  {
    id: 'invalid.incompatible_fallback',
    area: 'interchange',
    schema: 'interchange_request',
    valid: false,
    expected_issue_path: '/fallback_reserve/0/eligible_slot_ids/0',
    path: 'fixtures/invalid/incompatible-fallback.json',
    payload: invalidFallback,
  },
  {
    id: 'invalid.secret_extension',
    area: 'interchange',
    schema: 'interchange_request',
    valid: false,
    expected_issue_path: '/extensions/com.example:authorization',
    path: 'fixtures/invalid/secret-extension.json',
    payload: invalidSecretExtension,
  },
  {
    id: 'invalid.error_missing_fallback_allowed',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/attempts/0/error/fallback_allowed',
    path: 'fixtures/invalid/error-missing-fallback-allowed.json',
    payload: invalidError,
  },
  {
    id: 'invalid.lifecycle_out_of_order',
    area: 'interchange',
    schema: 'lifecycle_trace',
    valid: false,
    expected_issue_path: '/2/sequence',
    path: 'fixtures/invalid/lifecycle-out-of-order.json',
    payload: invalidLifecycle,
  },
  {
    id: 'invalid.result_attempt_reference',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/attempt_id',
    path: 'fixtures/invalid/result-attempt-reference.json',
    payload: invalidResultReference,
  },
  {
    id: 'invalid.monetary_float',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/attempts/2/usage/actual_cost/amount/amount_decimal',
    path: 'fixtures/invalid/monetary-float.json',
    payload: invalidMoney,
  },
  {
    id: 'invalid.citation_source_kind',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/citations/0/source_kind',
    path: 'fixtures/invalid/citation-source-kind.json',
    payload: invalidCitation,
  },
  {
    id: 'invalid.provenance_request_reference',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/provenance',
    path: 'fixtures/invalid/provenance-request-reference.json',
    payload: invalidProvenance,
  },
  {
    id: 'invalid.durable_handle_timestamp',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/attempts/2/durable_handle/submitted_at',
    path: 'fixtures/invalid/durable-handle-timestamp.json',
    payload: invalidDurableHandle,
  },
  {
    id: 'invalid.partial_outcome_shape',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/response_status',
    path: 'fixtures/invalid/partial-outcome-shape.json',
    payload: invalidPartialOutcome,
  },
  {
    id: 'invalid.missing_surface_context',
    area: 'interchange',
    schema: 'interchange_request',
    valid: false,
    expected_issue_path: '/slots/0/primary',
    path: 'fixtures/invalid/missing-surface-context.json',
    payload: invalidMissingSurfaceContext,
  },
  {
    id: 'invalid.unknown_constrained_account_context',
    area: 'interchange',
    schema: 'interchange_request',
    valid: false,
    expected_issue_path: '/slots/0/primary',
    path: 'fixtures/invalid/unknown-constrained-account-context.json',
    payload: invalidUnknownConstrainedAccountContext,
  },
  {
    id: 'invalid.unknown_constrained_personalization',
    area: 'interchange',
    schema: 'interchange_request',
    valid: false,
    expected_issue_path: '/slots/0/primary',
    path: 'fixtures/invalid/unknown-constrained-personalization.json',
    payload: invalidUnknownConstrainedPersonalization,
  },
  {
    id: 'invalid.fallback_surface_context',
    area: 'interchange',
    schema: 'interchange_request',
    valid: false,
    expected_issue_path: '/fallback_reserve/0/eligible_slot_ids/0',
    path: 'fixtures/invalid/fallback-surface-context.json',
    payload: invalidFallbackSurfaceContext,
  },
  {
    id: 'invalid.search_profile_grounding_policy',
    area: 'interchange',
    schema: 'interchange_request',
    valid: false,
    expected_issue_path: '/slots/0/primary/grounding_policy',
    path: 'fixtures/invalid/search-profile-grounding-policy.json',
    payload: invalidSearchProfileGrounding,
  },
  {
    id: 'invalid.search_requirement_grounding_policy',
    area: 'interchange',
    schema: 'interchange_request',
    valid: false,
    expected_issue_path: '/slots/0/requirements/grounding_policy',
    path: 'fixtures/invalid/search-requirement-grounding-policy.json',
    payload: invalidSearchRequirementGrounding,
  },
  {
    id: 'invalid.answer_missing_grounding_policy',
    area: 'interchange',
    schema: 'interchange_request',
    valid: false,
    expected_issue_path: '/slots/0/primary/grounding_policy',
    path: 'fixtures/invalid/answer-missing-grounding-policy.json',
    payload: invalidAnswerMissingGrounding,
  },
  {
    id: 'invalid.run_manifest_storage_field',
    area: 'artifacts',
    schema: 'run_manifest',
    valid: false,
    expected_issue_path: '',
    path: 'fixtures/invalid/run-manifest-storage-field.json',
    payload: invalidRunManifestStorageField,
  },
  {
    id: 'invalid.request_timestamp_missing_seconds',
    area: 'interchange',
    schema: 'interchange_request',
    valid: false,
    expected_issue_path: '/requested_at',
    path: 'fixtures/invalid/request-timestamp-missing-seconds.json',
    payload: invalidRequestMissingSeconds,
  },
  {
    id: 'invalid.nested_camel_case_secret',
    area: 'interchange',
    schema: 'interchange_request',
    valid: false,
    expected_issue_path:
      '/extensions/com.example:publicMetadata/accountContext/refreshToken',
    path: 'fixtures/invalid/nested-camel-case-secret.json',
    payload: invalidNestedCamelCaseSecret,
  },
  {
    id: 'invalid.decimal_too_long',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/attempts/2/usage/actual_cost/amount/amount_decimal',
    path: 'fixtures/invalid/decimal-too-long.json',
    payload: invalidDecimalTooLong,
  },
  {
    id: 'invalid.citation_non_http_url',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/citations/0/url',
    path: 'fixtures/invalid/citation-non-http-url.json',
    payload: invalidCitationUrl,
  },
  {
    id: 'invalid.citation_missing_locator',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/citations/0/url',
    path: 'fixtures/invalid/citation-missing-locator.json',
    payload: invalidCitationLocator,
  },
  {
    id: 'invalid.response_selected_attempt_status',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/slots/0/selected_attempt_id',
    path: 'fixtures/invalid/response-selected-attempt-status.json',
    payload: invalidSelectedAttempt,
  },
  {
    id: 'invalid.response_effective_profile',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/provenance/effective_profile',
    path: 'fixtures/invalid/response-effective-profile.json',
    payload: invalidEffectiveProfile,
  },
  {
    id: 'invalid.response_collection_provider',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/provenance/collection/provider',
    path: 'fixtures/invalid/response-collection-provider.json',
    payload: invalidCollectionProvider,
  },
  {
    id: 'invalid.response_replacement_provenance',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/provenance/replaced_attempt_id',
    path: 'fixtures/invalid/response-replacement-provenance.json',
    payload: invalidReplacementProvenance,
  },
  {
    id: 'invalid.response_mixed_unsuccessful_status',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/response_status',
    path: 'fixtures/invalid/response-mixed-unsuccessful-status.json',
    payload: invalidMixedUnsuccessfulStatus,
  },
  {
    id: 'invalid.lifecycle_failed_without_error',
    area: 'interchange',
    schema: 'lifecycle_trace',
    valid: false,
    expected_issue_path: '/2/data/error',
    path: 'fixtures/invalid/lifecycle-failed-without-error.json',
    payload: invalidLifecycleFailedWithoutError,
  },
  {
    id: 'invalid.lifecycle_succeeded_with_error',
    area: 'interchange',
    schema: 'lifecycle_trace',
    valid: false,
    expected_issue_path: '/5/data',
    path: 'fixtures/invalid/lifecycle-succeeded-with-error.json',
    payload: invalidLifecycleSucceededWithError,
  },
  {
    id: 'invalid.custom_provider_terminal_handle',
    area: 'custom_provider',
    schema: 'custom_provider_exchange',
    valid: false,
    expected_issue_path: '/response/durable_handle/status',
    path: 'fixtures/invalid/custom-provider-terminal-handle.json',
    payload: invalidCustomProviderTerminalHandle,
  },
  {
    id: 'invalid.custom_provider_progress_terminal_handle',
    area: 'custom_provider',
    schema: 'custom_provider_exchange',
    valid: false,
    expected_issue_path: '/response/durable_handle/status',
    path: 'fixtures/invalid/custom-provider-progress-terminal-handle.json',
    payload: invalidCustomProviderProgressTerminal,
  },
  {
    id: 'invalid.custom_provider_status_handle_binding',
    area: 'custom_provider',
    schema: 'custom_provider_exchange',
    valid: false,
    expected_issue_path: '/response/durable_handle/handle_id',
    path: 'fixtures/invalid/custom-provider-status-handle-binding.json',
    payload: invalidCustomProviderStatusHandleBinding,
  },
  {
    id: 'invalid.custom_provider_result_identifiers',
    area: 'custom_provider',
    schema: 'custom_provider_exchange',
    valid: false,
    expected_issue_path: '/response/result/provenance',
    path: 'fixtures/invalid/custom-provider-result-identifiers.json',
    payload: invalidCustomProviderResultIdentifiers,
  },
  {
    id: 'invalid.run_manifest_slot_order',
    area: 'artifacts',
    schema: 'run_manifest',
    valid: false,
    expected_issue_path: '/response/slots/0/slot_id',
    path: 'fixtures/invalid/run-manifest-slot-order.json',
    payload: invalidRunManifestSlotOrder,
  },
  {
    id: 'invalid.run_manifest_fallback_candidate',
    area: 'artifacts',
    schema: 'run_manifest',
    valid: false,
    expected_issue_path: '/response/attempts/1/candidate_id',
    path: 'fixtures/invalid/run-manifest-fallback-candidate.json',
    payload: invalidRunManifestFallbackCandidate,
  },
  {
    id: 'invalid.run_manifest_primary_profile',
    area: 'artifacts',
    schema: 'run_manifest',
    valid: false,
    expected_issue_path: '/response/attempts/0',
    path: 'fixtures/invalid/run-manifest-primary-profile.json',
    payload: invalidRunManifestPrimaryProfile,
  },
  {
    id: 'invalid.source_category_too_long',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/citations/0/source_category',
    path: 'fixtures/invalid/source-category-too-long.json',
    payload: invalidSourceCategoryTooLong,
  },
] as const;

const schemaTargets = {
  interchange_request: {
    schema_path: 'schema/interchange.schema.json',
    schema_ref: '#/$defs/request',
  },
  interchange_response: {
    schema_path: 'schema/interchange.schema.json',
    schema_ref: '#/$defs/response',
  },
  lifecycle_trace: {
    schema_path: 'schema/interchange.schema.json',
    schema_ref: '#/$defs/lifecycle_trace',
  },
  run_manifest: {
    schema_path: 'schema/artifacts.schema.json',
    schema_ref: '#/$defs/run_manifest',
  },
  custom_provider_exchange: {
    schema_path: 'schema/custom-provider.schema.json',
    schema_ref: '#/$defs/exchange',
  },
  historical_artifact_reader: {
    schema_path: 'schema/artifacts.schema.json',
    schema_ref: '#/$defs/historical_reader',
  },
} as const;

const semanticFixtureRules: Record<string, string> = {
  'invalid.async_non_durable_profile': 'request.preflight_plan_compatibility',
  'invalid.incompatible_fallback': 'request.preflight_plan_compatibility',
  'invalid.secret_extension': 'extensions.bounded_namespaced_json',
  'invalid.nested_camel_case_secret': 'extensions.bounded_namespaced_json',
  'invalid.lifecycle_out_of_order': 'lifecycle.monotonic_order',
  'invalid.result_attempt_reference': 'response.lossless_references',
  'invalid.provenance_request_reference': 'response.lossless_references',
  'invalid.partial_outcome_shape': 'response.status_coherence',
  'invalid.missing_surface_context': 'surface_context.explicit_constraint_only',
  'invalid.unknown_constrained_account_context':
    'surface_context.explicit_constraint_only',
  'invalid.unknown_constrained_personalization':
    'surface_context.explicit_constraint_only',
  'invalid.fallback_surface_context':
    'surface_context.explicit_constraint_only',
  'invalid.search_profile_grounding_policy':
    'grounding.search_results_inapplicable',
  'invalid.search_requirement_grounding_policy':
    'grounding.search_results_inapplicable',
  'invalid.answer_missing_grounding_policy':
    'grounding.search_results_inapplicable',
  'invalid.citation_missing_locator': 'source.locator_required',
  'invalid.response_selected_attempt_status': 'response.lossless_references',
  'invalid.response_effective_profile': 'response.lossless_references',
  'invalid.response_collection_provider': 'response.lossless_references',
  'invalid.response_replacement_provenance': 'response.lossless_references',
  'invalid.response_mixed_unsuccessful_status': 'response.status_coherence',
  'invalid.custom_provider_result_identifiers':
    'custom_provider.result_binding',
  'invalid.custom_provider_status_handle_binding':
    'custom_provider.task_binding',
  'invalid.run_manifest_slot_order': 'artifacts.run_manifest_execution_plan',
  'invalid.run_manifest_fallback_candidate':
    'artifacts.run_manifest_execution_plan',
  'invalid.run_manifest_primary_profile':
    'artifacts.run_manifest_execution_plan',
};

const fixtureFiles = fixtureDefinitions.map((fixture) =>
  write(fixture.path, fixture.payload),
);
const fixtureIndex = fixtureDefinitions.map((fixture) => {
  const target = schemaTargets[fixture.schema];
  const base = {
    id: fixture.id,
    area: fixture.area,
    valid: fixture.valid,
    path: fixture.path,
    ...target,
  };
  if (fixture.valid) return base;

  const semanticRuleId = semanticFixtureRules[fixture.id];
  if (semanticRuleId) {
    return {
      ...base,
      enforcement: 'semantic_rule' as const,
      semantic_rule_id: semanticRuleId,
      expected_issue_path: fixture.expected_issue_path,
    };
  }
  return {
    ...base,
    enforcement: 'json_schema' as const,
    expected_issue_path: fixture.expected_issue_path,
  };
});
const fixtureIndexDocument = {
  fixture_index_version: '1.0.0',
  fixtures: fixtureIndex,
} as const;
ContractFixtureIndexSchema.parse(fixtureIndexDocument);
const fixtureIndexPath = write('fixtures/index.json', fixtureIndexDocument);

const manifest = {
  snapshot_format_version: '1.0.0',
  contract_set: 'librarium_contracts',
  generated_at: SNAPSHOT_GENERATED_AT,
  owner: 'typescript_librarium',
  ownership_policy: 'canonical_upstream',
  checksum_algorithm: 'sha256',
  checksum_file: 'checksums.sha256',
  versions: {
    domain: DOMAIN_VERSION,
    artifacts: ARTIFACTS_VERSION,
    custom_provider: CUSTOM_PROVIDER_PROTOCOL_VERSION,
    interchange: INTERCHANGE_VERSION,
  },
  semantic_rules: [
    {
      rule_id: 'extensions.bounded_namespaced_json',
      version: '1.0.0',
      description:
        'Extensions are namespaced, JSON-safe, size/depth bounded, and secret-free.',
    },
    {
      rule_id: 'request.preflight_plan_compatibility',
      version: '1.0.0',
      description:
        'Primary and reserve profiles are validated before provider execution.',
    },
    {
      rule_id: 'durable_handle.public_task_reference',
      version: '1.0.0',
      description:
        'provider_task_id is a non-secret public reference; resume credentials and signed polling material remain adapter-local.',
    },
    {
      rule_id: 'grounding.search_results_inapplicable',
      version: '1.0.0',
      description:
        'Search-results profiles, requirements, and search-only result facts omit answer-grounding semantics.',
    },
    {
      rule_id: 'surface_context.explicit_constraint_only',
      version: '1.0.0',
      description:
        'Surface context is descriptive unless constrained; then every explicitly constrained field must match for primary and fallback profiles.',
    },
    {
      rule_id: 'lifecycle.monotonic_order',
      version: '1.0.0',
      description:
        'Lifecycle is a separate request-keyed event stream whose sequence and time are ordered and whose terminal events are final.',
    },
    {
      rule_id: 'artifacts.run_manifest_thin_envelope',
      version: '1.0.0',
      description:
        'Run manifests contain only producer metadata, normalized request and response, generation time, version identity, and bounded extensions.',
    },
    {
      rule_id: 'response.attempt_usage_accounting',
      version: '1.0.0',
      description:
        'Attempts may record exact usage and cost even when no result is returned.',
    },
    {
      rule_id: 'response.lossless_references',
      version: '1.0.0',
      description:
        'Slots, attempts, replacements, results, and provenance references agree.',
    },
    {
      rule_id: 'response.status_coherence',
      version: '1.0.0',
      description:
        'Response status reports the exact pending, successful, partially successful, failed, cancelled, or mixed-unsuccessful slot state.',
    },
    {
      rule_id: 'source.locator_required',
      version: '1.0.0',
      description:
        'Citations and normalized sources identify their source with an HTTP(S) URL or an opaque provider reference.',
    },
    {
      rule_id: 'custom_provider.result_binding',
      version: '1.0.0',
      description:
        'Custom-provider result identifiers, profile, collection provider, and response envelope agree.',
    },
    {
      rule_id: 'custom_provider.task_binding',
      version: '1.0.0',
      description:
        'Custom-provider poll responses preserve the polled durable task identity while distinguishing nonterminal progress from terminal status.',
    },
    {
      rule_id: 'artifacts.run_manifest_execution_plan',
      version: '1.0.0',
      description:
        'Run manifest response slots and attempts exactly implement the request primary and eligible ordered fallback plan.',
    },
    {
      rule_id: 'verification.consumer_owned_policy',
      version: '1.0.0',
      description:
        'Evidence facts cross the boundary without a universal verified boolean or threshold.',
    },
  ],
  files: [
    ...schemaFiles.map((path) => ({
      path,
      role: 'schema',
      areas: [schemaArea(path)],
    })),
    {
      path: fixtureIndexPath,
      role: 'fixture_index',
      areas: Array.from(
        new Set(fixtureDefinitions.map((fixture) => fixture.area)),
      ).sort(),
    },
    ...fixtureFiles.map((path) => ({
      path,
      role: 'fixture',
      areas: [
        fixtureDefinitions.find((fixture) => fixture.path === path)!.area,
      ],
    })),
  ],
};

ContractSnapshotManifestSchema.parse(manifest);
const manifestPath = write('manifest.json', manifest);

const filesToChecksum = [
  ...schemaFiles,
  fixtureIndexPath,
  ...fixtureFiles,
  manifestPath,
].sort();
const checksums = filesToChecksum
  .map((path) => {
    const content = requireContent(join(root, path));
    return `${createHash('sha256').update(content).digest('hex')}  ${path}`;
  })
  .join('\n');
write('checksums.sha256', `${checksums}\n`);

function schemaArea(
  path: string,
): 'domain' | 'artifacts' | 'custom_provider' | 'interchange' {
  const name = path.split('/').at(-1);
  if (name === 'domain.schema.json') return 'domain';
  if (name === 'artifacts.schema.json') return 'artifacts';
  if (name === 'custom-provider.schema.json') return 'custom_provider';
  return 'interchange';
}

function requireContent(path: string): Uint8Array {
  const normalized = relative(root, path);
  if (normalized.startsWith('..') || isAbsolute(normalized))
    throw new Error(`Refusing to checksum outside snapshot root: ${path}`);
  return new Uint8Array(readFileSync(path));
}
