import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  ProfileTargetSchema,
  ProfileTargetSlotSchema,
  ProviderIdentitySchema,
  RuntimeEffectiveTargetSchema,
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
  ResearchErrorSchema,
  RESEARCH_RESPONSE_CONTRACT_VERSION,
  ResearchResponseSchema,
  ResearchResultSchema,
  ResearchResultProvenanceSchema,
} from '../src/contracts/interchange/index.js';
import {
  AttemptSchema,
  EvidenceRequirementsSchema,
  InterchangeMessageSchema,
  InterchangeRequestSchema,
  InterchangeResponseSchema,
  InterchangeResultSchema,
  LifecycleEventSchema,
  LifecycleTraceSchema,
  RequestSlotSchema,
  SlotOutcomeSchema,
} from '../src/contracts/interchange/internal.js';
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

function listSnapshotFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listSnapshotFiles(path) : [path];
  });
}

function assertExactSnapshotInventory(expectedPaths: readonly string[]): void {
  const actualPaths = listSnapshotFiles(root)
    .map((path) => relative(root, path).replaceAll('\\', '/'))
    .sort();
  const expected = [...expectedPaths].sort();
  if (JSON.stringify(actualPaths) === JSON.stringify(expected)) return;

  const expectedSet = new Set(expected);
  const actualSet = new Set(actualPaths);
  const unexpected = actualPaths.filter((path) => !expectedSet.has(path));
  const missing = expected.filter((path) => !actualSet.has(path));
  throw new Error(
    `Contract snapshot inventory mismatch; unexpected=[${unexpected.join(', ')}], missing=[${missing.join(', ')}]`,
  );
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
        profile_target: ProfileTargetSchema,
        profile_target_slot: ProfileTargetSlotSchema,
        provider_identity: ProviderIdentitySchema,
        runtime_effective_target: RuntimeEffectiveTargetSchema,
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
        execution_attempt: AttemptSchema,
        execution_request: InterchangeRequestSchema,
        execution_response: InterchangeResponseSchema,
        execution_result: InterchangeResultSchema,
        lifecycle_trace: LifecycleTraceSchema,
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
        research_error: ResearchErrorSchema,
        research_response: ResearchResponseSchema,
        research_result: ResearchResultSchema,
        research_result_provenance: ResearchResultProvenanceSchema,
      },
    ),
  ),
];

const clone = <T>(value: T): T => structuredClone(value);

const configurableModelIdentity = {
  provider_id: 'example-configurable-model',
  profile_id: 'chat',
  target: {
    primary: {
      model_selection: 'configurable',
      kind: 'model',
      target_id: 'example-model-v1',
    },
  },
} satisfies z.input<typeof ProviderIdentitySchema>;

const configurableAgentIdentity = {
  provider_id: 'example-configurable-agent',
  profile_id: 'research',
  target: {
    primary: {
      model_selection: 'configurable',
      kind: 'agent',
      target_id: 'example-research-agent',
    },
  },
} satisfies z.input<typeof ProviderIdentitySchema>;

const fixedModelIdentity = {
  provider_id: 'example-fixed-model',
  profile_id: 'grounded',
  target: {
    primary: {
      model_selection: 'fixed',
      kind: 'model',
      target_id: 'example-fixed-model-v1',
    },
  },
} satisfies z.input<typeof ProviderIdentitySchema>;

const fixedPresetUnderlyingModelIdentity = {
  provider_id: 'example-preset',
  profile_id: 'deep-research',
  target: {
    primary: {
      model_selection: 'fixed',
      kind: 'preset',
      target_id: 'deep-research',
    },
    underlying: {
      model_selection: 'configurable',
      kind: 'model',
      target_id: 'example-model-v2',
    },
  },
} satisfies z.input<typeof ProviderIdentitySchema>;

const providerManagedKnownKindIdentity = {
  provider_id: 'example-provider-managed',
  profile_id: 'answer',
  target: {
    primary: {
      model_selection: 'provider_managed',
      kind: 'model',
    },
  },
} satisfies z.input<typeof ProviderIdentitySchema>;

const providerManagedUnknownKindIdentity = {
  provider_id: 'example-provider-managed',
  profile_id: 'unknown-target-kind',
  target: {
    primary: {
      model_selection: 'provider_managed',
    },
  },
} satisfies z.input<typeof ProviderIdentitySchema>;

const providerManagedAgentUnderlyingIdentity = {
  provider_id: 'example-provider-managed-agent',
  profile_id: 'research',
  target: {
    primary: {
      model_selection: 'provider_managed',
      kind: 'agent',
    },
    underlying: {
      model_selection: 'configurable',
      kind: 'model',
      target_id: 'example-model-v3',
    },
  },
} satisfies z.input<typeof ProviderIdentitySchema>;

const sharedIdNestedIdentity = {
  provider_id: 'example-agent',
  profile_id: 'shared-target-name',
  target: {
    primary: {
      model_selection: 'fixed',
      kind: 'agent',
      target_id: 'shared-target-name',
    },
    underlying: {
      model_selection: 'fixed',
      kind: 'model',
      target_id: 'shared-target-name',
    },
  },
} satisfies z.input<typeof ProviderIdentitySchema>;

const notApplicableIdentity = {
  provider_id: 'example-search',
  profile_id: 'search',
  target: {
    primary: {
      model_selection: 'not_applicable',
    },
  },
} satisfies z.input<typeof ProviderIdentitySchema>;

const invalidConfigurableTargetMissingKind = clone(
  configurableModelIdentity,
) as Record<string, any>;
delete invalidConfigurableTargetMissingKind.target.primary.kind;

const invalidConfigurableTargetMissingId = clone(
  configurableModelIdentity,
) as Record<string, any>;
delete invalidConfigurableTargetMissingId.target.primary.target_id;

const invalidFixedTargetMissingKind = clone(fixedModelIdentity) as Record<
  string,
  any
>;
delete invalidFixedTargetMissingKind.target.primary.kind;

const invalidFixedTargetMissingId = clone(fixedModelIdentity) as Record<
  string,
  any
>;
delete invalidFixedTargetMissingId.target.primary.target_id;

const invalidProviderManagedTargetId = clone(
  providerManagedKnownKindIdentity,
) as Record<string, any>;
invalidProviderManagedTargetId.target.primary.target_id =
  'unreported-provider-target';

const invalidNotApplicableTargetKind = clone(notApplicableIdentity) as Record<
  string,
  any
>;
invalidNotApplicableTargetKind.target.primary.kind = 'model';

const invalidNotApplicableTargetId = clone(notApplicableIdentity) as Record<
  string,
  any
>;
invalidNotApplicableTargetId.target.primary.target_id = 'forbidden-target';

const invalidUnderlyingPrimaryModel = clone(
  fixedPresetUnderlyingModelIdentity,
) as Record<string, any>;
invalidUnderlyingPrimaryModel.target.primary.kind = 'model';

const invalidUnderlyingProviderManaged = clone(
  fixedPresetUnderlyingModelIdentity,
) as Record<string, any>;
invalidUnderlyingProviderManaged.target.underlying = {
  model_selection: 'provider_managed',
  kind: 'model',
};

const invalidUnderlyingNestedAgent = clone(
  fixedPresetUnderlyingModelIdentity,
) as Record<string, any>;
invalidUnderlyingNestedAgent.target.underlying.kind = 'agent';

const invalidLegacyModelId = clone(configurableModelIdentity) as Record<
  string,
  any
>;
invalidLegacyModelId.model_id = 'legacy-model-id';

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

const invalidCompoundSecretExtension = clone(representativeRequest);
invalidCompoundSecretExtension.extensions = {
  'com.example:metadata': {
    openaiApiKey: 'fixture-secret-value-must-never-appear-in-errors',
    githubaccesstoken: 'fixture-secret-value-must-never-appear-in-errors',
    authorizationHeader: 'fixture-secret-value-must-never-appear-in-errors',
    databasepassword: 'fixture-secret-value-must-never-appear-in-errors',
    providerRawResponse: 'fixture-secret-value-must-never-appear-in-errors',
    stripeSecretKey: 'fixture-secret-value-must-never-appear-in-errors',
    awsSecretAccessKey: 'fixture-secret-value-must-never-appear-in-errors',
    api_key_2: 'fixture-secret-value-must-never-appear-in-errors',
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

const invalidCitationProviderTarget = clone(representativePartialResponse);
invalidCitationProviderTarget.results[0]!.citations[0]!.provenance.provider =
  clone(
    invalidCitationProviderTarget.results[0]!.citations[0]!.provenance.provider,
  );
invalidCitationProviderTarget.results[0]!.citations[0]!.provenance.provider.target.primary.target_id =
  'mismatched-citation-target';

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

const invalidEffectiveProfileTarget = clone(representativePartialResponse);
invalidEffectiveProfileTarget.results[0]!.provenance.effective_profile = clone(
  invalidEffectiveProfileTarget.results[0]!.provenance.effective_profile,
);
invalidEffectiveProfileTarget.results[0]!.provenance.effective_profile.identity.target.primary.target_id =
  'mismatched-target';

const invalidRequestedProfileTarget = clone(representativePartialResponse);
invalidRequestedProfileTarget.results[0]!.provenance.requested_profile = clone(
  invalidRequestedProfileTarget.results[0]!.provenance.requested_profile,
);
invalidRequestedProfileTarget.results[0]!.provenance.requested_profile.identity.target.primary.target_id =
  'mismatched-requested-target';

const invalidCollectionProvider = clone(representativePartialResponse);
invalidCollectionProvider.results[0]!.provenance.collection.provider = clone(
  invalidCollectionProvider.results[0]!.provenance.collection.provider,
);
invalidCollectionProvider
  .results[0]!.provenance.collection.provider.profile_id = 'mismatched-profile';

const invalidCollectionProviderTarget = clone(representativePartialResponse);
invalidCollectionProviderTarget.results[0]!.provenance.collection.provider =
  clone(
    invalidCollectionProviderTarget.results[0]!.provenance.collection.provider,
  );
invalidCollectionProviderTarget.results[0]!.provenance.collection.provider.target.primary.target_id =
  'mismatched-target';

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

const invalidCustomProviderCitationTarget = clone(
  representativeCustomProviderExchange,
);
invalidCustomProviderCitationTarget.response.result.citations[0]!.provenance.provider =
  clone(
    invalidCustomProviderCitationTarget.response.result.citations[0]!
      .provenance.provider,
  );
invalidCustomProviderCitationTarget.response.result.citations[0]!.provenance.provider.target.primary.target_id =
  'mismatched-custom-citation-target';

const invalidRunManifestSlotOrder = clone(representativeRunManifest);
invalidRunManifestSlotOrder.response.slots.reverse();

const invalidRunManifestFallbackCandidate = clone(representativeRunManifest);
invalidRunManifestFallbackCandidate.response.attempts[1]!.candidate_id =
  'candidate-does-not-exist';

const invalidRunManifestPrimaryProfile = clone(representativeRunManifest);
invalidRunManifestPrimaryProfile.response.attempts[0]!.profile = clone(
  invalidRunManifestPrimaryProfile.request.fallback_reserve[0]!.profile,
);

const invalidReplacementOfSucceeded = clone(
  representativePartialResponse,
) as Record<string, any>;
invalidReplacementOfSucceeded.attempts[0].attempt_status = 'succeeded';
invalidReplacementOfSucceeded.attempts[0].result_id = 'result-grounded-primary';
delete invalidReplacementOfSucceeded.attempts[0].error;
const succeededPrimaryResult = clone(invalidReplacementOfSucceeded.results[0]);
succeededPrimaryResult.result_id = 'result-grounded-primary';
succeededPrimaryResult.attempt_id = 'attempt-grounded-primary';
succeededPrimaryResult.semantic_facts.retrieval_methods = ['model_search_tool'];
succeededPrimaryResult.provenance.attempt_id = 'attempt-grounded-primary';
succeededPrimaryResult.provenance.requested_profile = clone(
  invalidReplacementOfSucceeded.attempts[0].profile,
);
succeededPrimaryResult.provenance.effective_profile = clone(
  invalidReplacementOfSucceeded.attempts[0].profile,
);
succeededPrimaryResult.provenance.collection.provider = clone(
  invalidReplacementOfSucceeded.attempts[0].profile.identity,
);
succeededPrimaryResult.provenance.collection.operator_id =
  invalidReplacementOfSucceeded.attempts[0].profile.operator_id;
delete succeededPrimaryResult.provenance.replaced_attempt_id;
succeededPrimaryResult.citations[0].provenance.provider = clone(
  invalidReplacementOfSucceeded.attempts[0].profile.identity,
);
succeededPrimaryResult.citations[0].provenance.operator_id =
  invalidReplacementOfSucceeded.attempts[0].profile.operator_id;
invalidReplacementOfSucceeded.results.push(succeededPrimaryResult);

const invalidFallbackCandidateReuse = clone(
  representativeRunManifest,
) as Record<string, any>;
const reusedCandidate =
  invalidFallbackCandidateReuse.request.fallback_reserve[0];
reusedCandidate.eligible_slot_ids.push('slot-research');
const secondPrimaryProfile = clone(
  invalidFallbackCandidateReuse.request.slots[0].primary,
);
secondPrimaryProfile.identity = {
  ...secondPrimaryProfile.identity,
  provider_id: 'perplexity-sonar-pro-secondary',
};
invalidFallbackCandidateReuse.request.slots[1].requirements = clone(
  invalidFallbackCandidateReuse.request.slots[0].requirements,
);
invalidFallbackCandidateReuse.request.slots[1].primary = secondPrimaryProfile;
const secondPrimaryAttempt = {
  attempt_id: 'attempt-secondary-primary',
  slot_id: 'slot-research',
  attempt_number: 1,
  profile: secondPrimaryProfile,
  started_at: '2026-08-08T00:00:06Z',
  attempt_status: 'failed',
  finished_at: '2026-08-08T00:00:07Z',
  error: {
    code: 'provider_unavailable',
    message: 'The provider did not return a usable response.',
    category: 'provider',
    retryable: true,
    fallback_allowed: true,
  },
};
const secondFallbackAttempt = clone(
  invalidFallbackCandidateReuse.response.attempts[1],
);
secondFallbackAttempt.attempt_id = 'attempt-secondary-fallback';
secondFallbackAttempt.slot_id = 'slot-research';
secondFallbackAttempt.replaces_attempt_id = 'attempt-secondary-primary';
secondFallbackAttempt.result_id = 'result-secondary-fallback';
secondFallbackAttempt.started_at = '2026-08-08T00:00:08Z';
secondFallbackAttempt.finished_at = '2026-08-08T00:00:10Z';
const secondFallbackResult = clone(
  invalidFallbackCandidateReuse.response.results[0],
);
secondFallbackResult.result_id = 'result-secondary-fallback';
secondFallbackResult.slot_id = 'slot-research';
secondFallbackResult.attempt_id = 'attempt-secondary-fallback';
secondFallbackResult.provenance.slot_id = 'slot-research';
secondFallbackResult.provenance.attempt_id = 'attempt-secondary-fallback';
secondFallbackResult.provenance.requested_profile = secondPrimaryProfile;
secondFallbackResult.provenance.replaced_attempt_id =
  'attempt-secondary-primary';
secondFallbackResult.completed_at = '2026-08-08T00:00:10Z';
invalidFallbackCandidateReuse.response.slots[1] = {
  slot_id: 'slot-research',
  slot_status: 'succeeded',
  selected_attempt_id: 'attempt-secondary-fallback',
  result_id: 'result-secondary-fallback',
};
invalidFallbackCandidateReuse.response.attempts = [
  ...invalidFallbackCandidateReuse.response.attempts.slice(0, 2),
  secondPrimaryAttempt,
  secondFallbackAttempt,
];
invalidFallbackCandidateReuse.response.results.push(secondFallbackResult);
invalidFallbackCandidateReuse.response.response_status = 'succeeded';

const invalidResponseFallbackCandidateReuse = clone(
  invalidFallbackCandidateReuse.response,
);

const invalidFallbackSurfaceLane = clone(representativeSurfaceContextRequest);
invalidFallbackSurfaceLane.fallback_reserve[0]!.profile.observation_mode =
  'api_output';
invalidFallbackSurfaceLane.fallback_reserve[0]!.profile.retrieval_method =
  'model_only';
invalidFallbackSurfaceLane.fallback_reserve[0]!.profile.access_mode = 'direct';
delete invalidFallbackSurfaceLane.fallback_reserve[0]!.profile.collector_id;

const invalidFallbackSurfaceIdentity = clone(
  representativeSurfaceContextRequest,
);
invalidFallbackSurfaceIdentity.fallback_reserve[0]!.profile.surface_id =
  'chatgpt_search';

const invalidAttemptHandleProvider = clone(representativePartialResponse);
invalidAttemptHandleProvider.attempts[2]!.durable_handle!.provider = {
  ...invalidAttemptHandleProvider.attempts[2]!.durable_handle!.provider,
  provider_id: 'different-provider',
};

const invalidAttemptHandleTarget = clone(representativePartialResponse);
invalidAttemptHandleTarget.attempts[2]!.durable_handle!.provider = clone(
  invalidAttemptHandleTarget.attempts[2]!.durable_handle!.provider,
);
invalidAttemptHandleTarget.attempts[2]!.durable_handle!.provider.target.primary.target_id =
  'different-target';

const invalidRetrieveRunningHandle = {
  request: {
    protocol_version: '1.0.0',
    message_type: 'retrieve',
    request_id: representativeCustomProviderExchange.request.request_id,
    attempt_id: representativeCustomProviderExchange.request.attempt_id,
    sent_at: '2026-08-08T00:00:10Z',
    durable_handle: {
      ...clone(representativePartialResponse.attempts[2]!.durable_handle!),
      status: 'running',
    },
  },
  response: clone(representativeCustomProviderExchange.response),
};

const invalidResultSemanticFacts = clone(representativePartialResponse);
invalidResultSemanticFacts.results[0]!.semantic_facts.result_kinds = [
  'model_answer',
];

const invalidResultObservationMode = clone(representativePartialResponse);
invalidResultObservationMode.results[0]!.semantic_facts.observation_mode =
  'surface_snapshot';

const invalidResultMeasuredSurface = clone(representativePartialResponse);
invalidResultMeasuredSurface.results[0]!.semantic_facts.measured_surface_id =
  'unexpected_surface';

const invalidResultRequiredGrounding = clone(representativePartialResponse);
invalidResultRequiredGrounding.results[0]!.semantic_facts.grounding_outcome =
  'not_used';

const invalidResultNoneGrounding = clone(representativePartialResponse);
invalidResultNoneGrounding.attempts[1]!.profile.grounding_policy = 'none';
invalidResultNoneGrounding.results[0]!.provenance.effective_profile
  .grounding_policy = 'none';

const representativeReportedEffectiveTargetResponse = clone(
  representativePartialResponse,
);
representativeReportedEffectiveTargetResponse.results[0]!.provenance.effective_target =
  {
    source: 'provider_reported',
    kind: 'model',
    target_id: 'brave-reported-model',
  };

const representativeNestedPrimaryTargetResponse = clone(
  representativePartialResponse,
);
const nestedTargetProfile = clone(
  representativeNestedPrimaryTargetResponse.attempts[1]!.profile,
);
nestedTargetProfile.identity.target = {
  primary: {
    model_selection: 'fixed',
    kind: 'preset',
    target_id: 'answers',
  },
  underlying: {
    model_selection: 'fixed',
    kind: 'model',
    target_id: 'brave',
  },
};
representativeNestedPrimaryTargetResponse.attempts[1]!.profile =
  clone(nestedTargetProfile);
representativeNestedPrimaryTargetResponse.results[0]!.provenance.effective_profile =
  clone(nestedTargetProfile);
representativeNestedPrimaryTargetResponse.results[0]!.provenance.collection.provider =
  clone(nestedTargetProfile.identity);
representativeNestedPrimaryTargetResponse.results[0]!.citations[0]!.provenance.provider =
  clone(nestedTargetProfile.identity);
representativeNestedPrimaryTargetResponse.results[0]!.provenance.effective_target =
  {
    source: 'provider_reported',
    kind: 'preset',
    target_id: 'answers',
  };

const representativeNestedUnderlyingTargetResponse = clone(
  representativeNestedPrimaryTargetResponse,
);
representativeNestedUnderlyingTargetResponse.results[0]!.provenance.effective_target =
  {
    source: 'provider_reported',
    kind: 'model',
    target_id: 'brave',
  };

const invalidEffectiveTargetSource = clone(
  representativeReportedEffectiveTargetResponse,
) as Record<string, any>;
invalidEffectiveTargetSource.results[0].provenance.effective_target.source =
  'configured';

const invalidEffectiveTargetKind = clone(
  representativeReportedEffectiveTargetResponse,
);
invalidEffectiveTargetKind.results[0]!.provenance.effective_target!.kind =
  'agent';

const invalidNotApplicableEffectiveTarget = clone(
  representativeReportedEffectiveTargetResponse,
);
const notApplicableTargetProfile = clone(
  invalidNotApplicableEffectiveTarget.attempts[1]!.profile,
);
notApplicableTargetProfile.identity.target = clone(notApplicableIdentity.target);
invalidNotApplicableEffectiveTarget.attempts[1]!.profile = clone(
  notApplicableTargetProfile,
);
invalidNotApplicableEffectiveTarget.results[0]!.provenance.effective_profile =
  clone(notApplicableTargetProfile);
invalidNotApplicableEffectiveTarget.results[0]!.provenance.collection.provider =
  clone(notApplicableTargetProfile.identity);
invalidNotApplicableEffectiveTarget.results[0]!.citations[0]!.provenance.provider =
  clone(notApplicableTargetProfile.identity);

const invalidSurfaceProfileMissingIdentity = clone(
  representativeSurfaceContextRequest,
) as Record<string, any>;
delete invalidSurfaceProfileMissingIdentity.slots[0].primary.surface_id;

const invalidSurfaceSnapshotRetrieval = clone(
  representativeSurfaceContextRequest,
);
invalidSurfaceSnapshotRetrieval.slots[0]!.primary.retrieval_method =
  'model_only';

const invalidSurfaceSnapshotAccess = clone(
  representativeSurfaceContextRequest,
);
invalidSurfaceSnapshotAccess.slots[0]!.primary.access_mode = 'direct';

const representativeApiProxySurfaceRequest = clone(
  representativeSurfaceContextRequest,
);
const apiProxyProfile = {
  identity: {
    provider_id: 'google-gemini-api',
    profile_id: 'google-ai-mode-api-proxy',
    target: {
      primary: {
        model_selection: 'provider_managed' as const,
        kind: 'model' as const,
      },
    },
  },
  result_kind: 'surface_observation' as const,
  grounding_policy: 'optional' as const,
  observation_mode: 'api_output' as const,
  corpora: ['web' as const],
  retrieval_method: 'model_only' as const,
  access_mode: 'direct' as const,
  operator_id: 'google',
  surface_id: 'google_ai_mode',
  surface_context: clone(
    representativeSurfaceContextRequest.slots[0]!.primary.surface_context!,
  ),
  invocation: 'inline' as const,
  resumability: 'none' as const,
};
representativeApiProxySurfaceRequest.slots[0]!.requirements.observation_mode =
  'api_output';
representativeApiProxySurfaceRequest.slots[0]!.requirements.retrieval_methods =
  ['model_only'];
representativeApiProxySurfaceRequest.slots[0]!.primary = apiProxyProfile;
representativeApiProxySurfaceRequest.fallback_reserve[0]!.profile = {
  ...apiProxyProfile,
  identity: {
    provider_id: 'openai-api',
    profile_id: 'google-ai-mode-api-proxy-comparison',
    target: {
      primary: {
        model_selection: 'provider_managed',
        kind: 'model',
      },
    },
  },
  operator_id: 'openai',
};

const representativeSourcesArtifact = {
  artifact_name: 'sources' as const,
  artifact_version: '1.0.0' as const,
  generated_at: '2026-08-08T00:00:11Z',
  request_id: representativePartialResponse.request_id,
  sources: [
    {
      source_id: 'source-001',
      canonical_url:
        representativePartialResponse.results[0]!.citations[0]!.url,
      source_kind:
        representativePartialResponse.results[0]!.citations[0]!.source_kind,
      citation_ids: [
        representativePartialResponse.results[0]!.citations[0]!.citation_id,
      ],
    },
  ],
  citations: [clone(representativePartialResponse.results[0]!.citations[0]!)],
};

const invalidSourcesDanglingCitation = clone(representativeSourcesArtifact);
invalidSourcesDanglingCitation.sources[0]!.citation_ids = [
  'citation-does-not-exist',
];

const invalidSourcesDuplicateIdentity = clone(representativeSourcesArtifact);
invalidSourcesDuplicateIdentity.sources.push(
  clone(invalidSourcesDuplicateIdentity.sources[0]!),
);

const invalidSourcesDuplicateCitationIdentity = clone(
  representativeSourcesArtifact,
);
invalidSourcesDuplicateCitationIdentity.citations.push(
  clone(invalidSourcesDuplicateCitationIdentity.citations[0]!),
);

const invalidSourcesDuplicateReference = clone(representativeSourcesArtifact);
invalidSourcesDuplicateReference.sources[0]!.citation_ids.push(
  invalidSourcesDuplicateReference.sources[0]!.citation_ids[0]!,
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

const toSharedResult = (result: typeof representativePartialResponse.results[number]) => {
  const { slot_id: _slotId, attempt_id: _attemptId, provenance, ...shared } = result;
  const {
    request_id: _requestId,
    slot_id: _provenanceSlotId,
    attempt_id: _provenanceAttemptId,
    replaced_attempt_id: _replacedAttemptId,
    ...sharedProvenance
  } = provenance;
  return { ...shared, provenance: sharedProvenance };
};

const representativeSharedPartialResponse = {
  generator: 'jkudish/librarium',
  generator_version: '1.4.1',
  request_id: representativePartialResponse.request_id,
  status: 'partial' as const,
  completed_at: representativePartialResponse.emitted_at,
  results: representativePartialResponse.results.map(toSharedResult),
  errors: [
    {
      provider: durableResearchProfile.identity,
      error: representativePartialResponse.errors[0]!,
      usage: representativePartialResponse.attempts[2]!.usage,
    },
  ],
  sources: [
    {
      source_id: 'source-001',
      canonical_url: representativePartialResponse.results[0]!.citations[0]!.url,
      source_kind: representativePartialResponse.results[0]!.citations[0]!.source_kind,
      citation_ids: [
        representativePartialResponse.results[0]!.citations[0]!.citation_id,
      ],
    },
  ],
};

const representativeSharedSucceededResponse = {
  ...clone(representativeSharedPartialResponse),
  status: 'succeeded' as const,
  errors: [],
};

const representativeSharedFailedResponse = {
  ...clone(representativeSharedPartialResponse),
  status: 'failed' as const,
  results: [],
  sources: [],
};

const invalidSharedGenericVersion = {
  ...clone(representativeSharedSucceededResponse),
  version: '1.0.0',
};
const invalidSharedInterchangeVersion = {
  ...clone(representativeSharedSucceededResponse),
  interchange_version: '1.0.0',
};
const invalidSharedExecutionField = {
  ...clone(representativeSharedSucceededResponse),
  attempts: [],
};
const invalidSharedSlotField = {
  ...clone(representativeSharedSucceededResponse),
  slots: [],
};
const invalidSharedHandleField = {
  ...clone(representativeSharedSucceededResponse),
  durable_handle: {},
};
const invalidSharedLifecycleField = {
  ...clone(representativeSharedSucceededResponse),
  lifecycle: [],
};
const invalidSharedPendingStatus = {
  ...clone(representativeSharedSucceededResponse),
  status: 'pending',
};
const invalidSharedCancelledStatus = {
  ...clone(representativeSharedFailedResponse),
  status: 'cancelled',
};
const invalidSharedUnsuccessfulStatus = {
  ...clone(representativeSharedFailedResponse),
  status: 'unsuccessful',
};
const invalidSharedSubmittedStatus = {
  ...clone(representativeSharedSucceededResponse),
  status: 'submitted',
};
const invalidSharedRunningStatus = {
  ...clone(representativeSharedSucceededResponse),
  status: 'running',
};
const invalidSharedMissingReceipt = clone(representativeSharedSucceededResponse) as Record<string, unknown>;
delete invalidSharedMissingReceipt.generator;
const invalidSharedMalformedReceipt = {
  ...clone(representativeSharedSucceededResponse),
  generator_version: '1.4',
};
const invalidSharedBlankReceipt = {
  ...clone(representativeSharedSucceededResponse),
  generator: ' ',
};
const invalidSharedBareScopeReceipt = {
  ...clone(representativeSharedSucceededResponse),
  generator: '@scope',
};
const invalidSharedOversizedReceipt = {
  ...clone(representativeSharedSucceededResponse),
  generator: 'a'.repeat(256),
};
const representativeSharedPhpSucceededResponse = {
  ...clone(representativeSharedSucceededResponse),
  generator: 'jkudish/laravel-ai-librarium',
  generator_version: '2.0.0-rc.1+build.7',
};
const invalidSharedResultExecutionField = clone(
  representativeSharedSucceededResponse,
) as Record<string, any>;
invalidSharedResultExecutionField.results[0].attempt_id = 'attempt-internal';
const invalidSharedCollectionProvider = clone(
  representativeSharedSucceededResponse,
);
invalidSharedCollectionProvider.results[0]!.provenance.collection.provider = {
  ...invalidSharedCollectionProvider.results[0]!.provenance.collection.provider,
  provider_id: 'other-provider',
};
const invalidSharedDuplicateCitationSource = clone(
  representativeSharedSucceededResponse,
);
invalidSharedDuplicateCitationSource.sources.push({
  ...clone(invalidSharedDuplicateCitationSource.sources[0]!),
  source_id: 'source-002',
});
const invalidSharedDanglingCitationSource = clone(
  representativeSharedSucceededResponse,
);
invalidSharedDanglingCitationSource.sources[0]!.citation_ids = [
  'citation-does-not-exist',
];
const invalidSharedUnownedCitation = clone(representativeSharedSucceededResponse);
invalidSharedUnownedCitation.sources = [];
const invalidSharedTerminalShape = {
  ...clone(representativeSharedSucceededResponse),
  errors: [{ error: representativePartialResponse.errors[0]! }],
};
const invalidSharedSemanticProfile = clone(representativeSharedSucceededResponse);
invalidSharedSemanticProfile.results[0]!.semantic_facts.result_kinds = [
  'model_answer',
];
const invalidSharedEffectiveTarget = clone(representativeSharedSucceededResponse);
invalidSharedEffectiveTarget.results[0]!.provenance.effective_target = {
  source: 'provider_reported',
  kind: 'agent',
  target_id: 'wrong-kind',
};
const invalidSharedCitationProvider = clone(representativeSharedSucceededResponse);
invalidSharedCitationProvider.results[0]!.citations[0]!.provenance.provider = {
  ...invalidSharedCitationProvider.results[0]!.citations[0]!.provenance.provider,
  provider_id: 'other-provider',
};

const fixtureDefinitions = [
  {
    id: 'valid.target_configurable_model',
    area: 'domain',
    schema: 'provider_identity',
    valid: true,
    path: 'fixtures/valid/target-configurable-model.json',
    payload: configurableModelIdentity,
  },
  {
    id: 'valid.target_configurable_agent',
    area: 'domain',
    schema: 'provider_identity',
    valid: true,
    path: 'fixtures/valid/target-configurable-agent.json',
    payload: configurableAgentIdentity,
  },
  {
    id: 'valid.target_fixed_preset_underlying_configurable_model',
    area: 'domain',
    schema: 'provider_identity',
    valid: true,
    path:
      'fixtures/valid/target-fixed-preset-underlying-configurable-model.json',
    payload: fixedPresetUnderlyingModelIdentity,
  },
  {
    id: 'valid.target_provider_managed_known_kind',
    area: 'domain',
    schema: 'provider_identity',
    valid: true,
    path: 'fixtures/valid/target-provider-managed-known-kind.json',
    payload: providerManagedKnownKindIdentity,
  },
  {
    id: 'valid.target_provider_managed_unknown_kind',
    area: 'domain',
    schema: 'provider_identity',
    valid: true,
    path: 'fixtures/valid/target-provider-managed-unknown-kind.json',
    payload: providerManagedUnknownKindIdentity,
  },
  {
    id: 'valid.target_provider_managed_agent_underlying_model',
    area: 'domain',
    schema: 'provider_identity',
    valid: true,
    path: 'fixtures/valid/target-provider-managed-agent-underlying-model.json',
    payload: providerManagedAgentUnderlyingIdentity,
  },
  {
    id: 'valid.target_distinct_kinds_shared_id',
    area: 'domain',
    schema: 'provider_identity',
    valid: true,
    path: 'fixtures/valid/target-distinct-kinds-shared-id.json',
    payload: sharedIdNestedIdentity,
  },
  {
    id: 'valid.target_not_applicable',
    area: 'domain',
    schema: 'provider_identity',
    valid: true,
    path: 'fixtures/valid/target-not-applicable.json',
    payload: notApplicableIdentity,
  },
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
    id: 'valid.api_proxy_surface_request',
    area: 'interchange',
    schema: 'interchange_request',
    valid: true,
    path: 'fixtures/valid/api-proxy-surface-request.json',
    payload: representativeApiProxySurfaceRequest,
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
    id: 'valid.provider_reported_effective_target_response',
    area: 'interchange',
    schema: 'interchange_response',
    valid: true,
    path: 'fixtures/valid/provider-reported-effective-target-response.json',
    payload: representativeReportedEffectiveTargetResponse,
  },
  {
    id: 'valid.nested_primary_effective_target_response',
    area: 'interchange',
    schema: 'interchange_response',
    valid: true,
    path: 'fixtures/valid/nested-primary-effective-target-response.json',
    payload: representativeNestedPrimaryTargetResponse,
  },
  {
    id: 'valid.nested_underlying_effective_target_response',
    area: 'interchange',
    schema: 'interchange_response',
    valid: true,
    path: 'fixtures/valid/nested-underlying-effective-target-response.json',
    payload: representativeNestedUnderlyingTargetResponse,
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
    id: 'invalid.target_configurable_missing_kind',
    area: 'domain',
    schema: 'provider_identity',
    valid: false,
    expected_issue_path: '/target/primary/kind',
    path: 'fixtures/invalid/target-configurable-missing-kind.json',
    payload: invalidConfigurableTargetMissingKind,
  },
  {
    id: 'invalid.target_configurable_missing_id',
    area: 'domain',
    schema: 'provider_identity',
    valid: false,
    expected_issue_path: '/target/primary/target_id',
    path: 'fixtures/invalid/target-configurable-missing-id.json',
    payload: invalidConfigurableTargetMissingId,
  },
  {
    id: 'invalid.target_fixed_missing_kind',
    area: 'domain',
    schema: 'provider_identity',
    valid: false,
    expected_issue_path: '/target/primary/kind',
    path: 'fixtures/invalid/target-fixed-missing-kind.json',
    payload: invalidFixedTargetMissingKind,
  },
  {
    id: 'invalid.target_fixed_missing_id',
    area: 'domain',
    schema: 'provider_identity',
    valid: false,
    expected_issue_path: '/target/primary/target_id',
    path: 'fixtures/invalid/target-fixed-missing-id.json',
    payload: invalidFixedTargetMissingId,
  },
  {
    id: 'invalid.target_provider_managed_id',
    area: 'domain',
    schema: 'provider_identity',
    valid: false,
    expected_issue_path: '/target/primary/target_id',
    path: 'fixtures/invalid/target-provider-managed-id.json',
    payload: invalidProviderManagedTargetId,
  },
  {
    id: 'invalid.target_not_applicable_kind',
    area: 'domain',
    schema: 'provider_identity',
    valid: false,
    expected_issue_path: '/target/primary/kind',
    path: 'fixtures/invalid/target-not-applicable-kind.json',
    payload: invalidNotApplicableTargetKind,
  },
  {
    id: 'invalid.target_not_applicable_id',
    area: 'domain',
    schema: 'provider_identity',
    valid: false,
    expected_issue_path: '/target/primary/target_id',
    path: 'fixtures/invalid/target-not-applicable-id.json',
    payload: invalidNotApplicableTargetId,
  },
  {
    id: 'invalid.target_underlying_primary_model',
    area: 'domain',
    schema: 'provider_identity',
    valid: false,
    expected_issue_path: '/target/underlying',
    path: 'fixtures/invalid/target-underlying-primary-model.json',
    payload: invalidUnderlyingPrimaryModel,
  },
  {
    id: 'invalid.target_underlying_provider_managed',
    area: 'domain',
    schema: 'provider_identity',
    valid: false,
    expected_issue_path: '/target/underlying/model_selection',
    path: 'fixtures/invalid/target-underlying-provider-managed.json',
    payload: invalidUnderlyingProviderManaged,
  },
  {
    id: 'invalid.target_underlying_nested_agent',
    area: 'domain',
    schema: 'provider_identity',
    valid: false,
    expected_issue_path: '/target/underlying/kind',
    path: 'fixtures/invalid/target-underlying-nested-agent.json',
    payload: invalidUnderlyingNestedAgent,
  },
  {
    id: 'invalid.target_legacy_model_id',
    area: 'domain',
    schema: 'provider_identity',
    valid: false,
    expected_issue_path: '',
    path: 'fixtures/invalid/target-legacy-model-id.json',
    payload: invalidLegacyModelId,
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
    id: 'invalid.compound_secret_extension',
    area: 'interchange',
    schema: 'interchange_request',
    valid: false,
    expected_issue_path: '/extensions/com.example:metadata/openaiApiKey',
    path: 'fixtures/invalid/compound-secret-extension.json',
    payload: invalidCompoundSecretExtension,
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
    id: 'invalid.citation_provider_target',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/citations/0/provenance/provider',
    path: 'fixtures/invalid/citation-provider-target.json',
    payload: invalidCitationProviderTarget,
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
    id: 'invalid.response_effective_profile_target',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/provenance/effective_profile',
    path: 'fixtures/invalid/response-effective-profile-target.json',
    payload: invalidEffectiveProfileTarget,
  },
  {
    id: 'invalid.response_requested_profile_target',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/provenance/requested_profile',
    path: 'fixtures/invalid/response-requested-profile-target.json',
    payload: invalidRequestedProfileTarget,
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
    id: 'invalid.response_collection_provider_target',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/provenance/collection/provider',
    path: 'fixtures/invalid/response-collection-provider-target.json',
    payload: invalidCollectionProviderTarget,
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
    id: 'invalid.response_replacement_of_succeeded',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/attempts/1/replaces_attempt_id',
    path: 'fixtures/invalid/response-replacement-of-succeeded.json',
    payload: invalidReplacementOfSucceeded,
  },
  {
    id: 'invalid.response_attempt_handle_provider',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/attempts/2/durable_handle/provider',
    path: 'fixtures/invalid/response-attempt-handle-provider.json',
    payload: invalidAttemptHandleProvider,
  },
  {
    id: 'invalid.response_attempt_handle_target',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/attempts/2/durable_handle/provider',
    path: 'fixtures/invalid/response-attempt-handle-target.json',
    payload: invalidAttemptHandleTarget,
  },
  {
    id: 'invalid.response_semantic_facts',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/semantic_facts/result_kinds',
    path: 'fixtures/invalid/response-semantic-facts.json',
    payload: invalidResultSemanticFacts,
  },
  {
    id: 'invalid.response_observation_mode',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/semantic_facts/observation_mode',
    path: 'fixtures/invalid/response-observation-mode.json',
    payload: invalidResultObservationMode,
  },
  {
    id: 'invalid.response_measured_surface',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/semantic_facts/measured_surface_id',
    path: 'fixtures/invalid/response-measured-surface.json',
    payload: invalidResultMeasuredSurface,
  },
  {
    id: 'invalid.response_required_grounding',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/semantic_facts/grounding_outcome',
    path: 'fixtures/invalid/response-required-grounding.json',
    payload: invalidResultRequiredGrounding,
  },
  {
    id: 'invalid.response_none_grounding',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/semantic_facts/grounding_outcome',
    path: 'fixtures/invalid/response-none-grounding.json',
    payload: invalidResultNoneGrounding,
  },
  {
    id: 'invalid.response_effective_target_source',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/provenance/effective_target/source',
    path: 'fixtures/invalid/response-effective-target-source.json',
    payload: invalidEffectiveTargetSource,
  },
  {
    id: 'invalid.response_effective_target_kind',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/provenance/effective_target/kind',
    path: 'fixtures/invalid/response-effective-target-kind.json',
    payload: invalidEffectiveTargetKind,
  },
  {
    id: 'invalid.response_not_applicable_effective_target',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/results/0/provenance/effective_target',
    path: 'fixtures/invalid/response-not-applicable-effective-target.json',
    payload: invalidNotApplicableEffectiveTarget,
  },
  {
    id: 'invalid.response_fallback_candidate_reuse',
    area: 'interchange',
    schema: 'interchange_response',
    valid: false,
    expected_issue_path: '/attempts/3/candidate_id',
    path: 'fixtures/invalid/response-fallback-candidate-reuse.json',
    payload: invalidResponseFallbackCandidateReuse,
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
    id: 'invalid.custom_provider_citation_target',
    area: 'custom_provider',
    schema: 'custom_provider_exchange',
    valid: false,
    expected_issue_path: '/response/result/citations/0/provenance/provider',
    path: 'fixtures/invalid/custom-provider-citation-target.json',
    payload: invalidCustomProviderCitationTarget,
  },
  {
    id: 'invalid.custom_provider_retrieve_running_handle',
    area: 'custom_provider',
    schema: 'custom_provider_exchange',
    valid: false,
    expected_issue_path: '/request/durable_handle/status',
    path: 'fixtures/invalid/custom-provider-retrieve-running-handle.json',
    payload: invalidRetrieveRunningHandle,
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
    id: 'invalid.run_manifest_fallback_candidate_reuse',
    area: 'artifacts',
    schema: 'run_manifest',
    valid: false,
    expected_issue_path: '/response/attempts/3/candidate_id',
    path: 'fixtures/invalid/run-manifest-fallback-candidate-reuse.json',
    payload: invalidFallbackCandidateReuse,
  },
  {
    id: 'invalid.fallback_surface_lane',
    area: 'interchange',
    schema: 'interchange_request',
    valid: false,
    expected_issue_path: '/fallback_reserve/0/eligible_slot_ids/0',
    path: 'fixtures/invalid/fallback-surface-lane.json',
    payload: invalidFallbackSurfaceLane,
  },
  {
    id: 'invalid.fallback_surface_identity',
    area: 'interchange',
    schema: 'interchange_request',
    valid: false,
    expected_issue_path: '/fallback_reserve/0/eligible_slot_ids/0',
    path: 'fixtures/invalid/fallback-surface-identity.json',
    payload: invalidFallbackSurfaceIdentity,
  },
  {
    id: 'invalid.surface_profile_missing_identity',
    area: 'interchange',
    schema: 'interchange_request',
    valid: false,
    expected_issue_path: '/slots/0/primary/surface_id',
    path: 'fixtures/invalid/surface-profile-missing-identity.json',
    payload: invalidSurfaceProfileMissingIdentity,
  },
  {
    id: 'invalid.surface_snapshot_retrieval',
    area: 'interchange',
    schema: 'interchange_request',
    valid: false,
    expected_issue_path: '/slots/0/primary/retrieval_method',
    path: 'fixtures/invalid/surface-snapshot-retrieval.json',
    payload: invalidSurfaceSnapshotRetrieval,
  },
  {
    id: 'invalid.surface_snapshot_access',
    area: 'interchange',
    schema: 'interchange_request',
    valid: false,
    expected_issue_path: '/slots/0/primary/access_mode',
    path: 'fixtures/invalid/surface-snapshot-access.json',
    payload: invalidSurfaceSnapshotAccess,
  },
  {
    id: 'invalid.sources_dangling_citation',
    area: 'artifacts',
    schema: 'sources_artifact',
    valid: false,
    expected_issue_path: '/sources/0/citation_ids/0',
    path: 'fixtures/invalid/sources-dangling-citation.json',
    payload: invalidSourcesDanglingCitation,
  },
  {
    id: 'invalid.sources_duplicate_identity',
    area: 'artifacts',
    schema: 'sources_artifact',
    valid: false,
    expected_issue_path: '/sources/1/source_id',
    path: 'fixtures/invalid/sources-duplicate-identity.json',
    payload: invalidSourcesDuplicateIdentity,
  },
  {
    id: 'invalid.sources_duplicate_citation_identity',
    area: 'artifacts',
    schema: 'sources_artifact',
    valid: false,
    expected_issue_path: '/citations/1/citation_id',
    path: 'fixtures/invalid/sources-duplicate-citation-identity.json',
    payload: invalidSourcesDuplicateCitationIdentity,
  },
  {
    id: 'invalid.sources_duplicate_reference',
    area: 'artifacts',
    schema: 'sources_artifact',
    valid: false,
    expected_issue_path: '/sources/0/citation_ids/1',
    path: 'fixtures/invalid/sources-duplicate-reference.json',
    payload: invalidSourcesDuplicateReference,
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

const sharedFixtureDefinitions = [
  {
    id: 'valid.research_response_succeeded',
    area: 'interchange',
    schema: 'research_response',
    valid: true,
    path: 'fixtures/valid/research-response-succeeded.json',
    payload: representativeSharedSucceededResponse,
  },
  {
    id: 'valid.research_response_php_succeeded',
    area: 'interchange',
    schema: 'research_response',
    valid: true,
    path: 'fixtures/valid/research-response-php-succeeded.json',
    payload: representativeSharedPhpSucceededResponse,
  },
  {
    id: 'valid.research_response_partial',
    area: 'interchange',
    schema: 'research_response',
    valid: true,
    path: 'fixtures/valid/research-response-partial.json',
    payload: representativeSharedPartialResponse,
  },
  {
    id: 'valid.research_response_failed',
    area: 'interchange',
    schema: 'research_response',
    valid: true,
    path: 'fixtures/valid/research-response-failed.json',
    payload: representativeSharedFailedResponse,
  },
  {
    id: 'invalid.research_response_missing_receipt',
    area: 'interchange',
    schema: 'research_response',
    valid: false,
    expected_issue_path: '/generator',
    path: 'fixtures/invalid/research-response-missing-receipt.json',
    payload: invalidSharedMissingReceipt,
  },
  {
    id: 'invalid.research_response_blank_receipt',
    area: 'interchange',
    schema: 'research_response',
    valid: false,
    expected_issue_path: '/generator',
    path: 'fixtures/invalid/research-response-blank-receipt.json',
    payload: invalidSharedBlankReceipt,
  },
  {
    id: 'invalid.research_response_bare_scope_receipt',
    area: 'interchange',
    schema: 'research_response',
    valid: false,
    expected_issue_path: '/generator',
    path: 'fixtures/invalid/research-response-bare-scope-receipt.json',
    payload: invalidSharedBareScopeReceipt,
  },
  {
    id: 'invalid.research_response_oversized_receipt',
    area: 'interchange',
    schema: 'research_response',
    valid: false,
    expected_issue_path: '/generator',
    path: 'fixtures/invalid/research-response-oversized-receipt.json',
    payload: invalidSharedOversizedReceipt,
  },
  {
    id: 'invalid.research_response_malformed_receipt',
    area: 'interchange',
    schema: 'research_response',
    valid: false,
    expected_issue_path: '/generator_version',
    path: 'fixtures/invalid/research-response-malformed-receipt.json',
    payload: invalidSharedMalformedReceipt,
  },
  {
    id: 'invalid.research_response_generic_version',
    area: 'interchange',
    schema: 'research_response',
    valid: false,
    expected_issue_path: '',
    path: 'fixtures/invalid/research-response-generic-version.json',
    payload: invalidSharedGenericVersion,
  },
  {
    id: 'invalid.research_response_interchange_version',
    area: 'interchange',
    schema: 'research_response',
    valid: false,
    expected_issue_path: '',
    path: 'fixtures/invalid/research-response-interchange-version.json',
    payload: invalidSharedInterchangeVersion,
  },
  {
    id: 'invalid.research_response_execution_field',
    area: 'interchange',
    schema: 'research_response',
    valid: false,
    expected_issue_path: '',
    path: 'fixtures/invalid/research-response-execution-field.json',
    payload: invalidSharedExecutionField,
  },
  {
    id: 'invalid.research_response_result_execution_field',
    area: 'interchange',
    schema: 'research_response',
    valid: false,
    expected_issue_path: '/results/0',
    path: 'fixtures/invalid/research-response-result-execution-field.json',
    payload: invalidSharedResultExecutionField,
  },
  ...(
    [
      ['slot_field', invalidSharedSlotField],
      ['handle_field', invalidSharedHandleField],
      ['lifecycle_field', invalidSharedLifecycleField],
    ] as const
  ).map(([name, payload]) => ({
    id: `invalid.research_response_${name}`,
    area: 'interchange' as const,
    schema: 'research_response' as const,
    valid: false as const,
    expected_issue_path: '',
    path: `fixtures/invalid/research-response-${name.replaceAll('_', '-')}.json`,
    payload,
  })),
  {
    id: 'invalid.research_response_collection_provider',
    area: 'interchange',
    schema: 'research_response',
    valid: false,
    expected_issue_path: '/results/0/provenance/collection/provider',
    path: 'fixtures/invalid/research-response-collection-provider.json',
    payload: invalidSharedCollectionProvider,
  },
  {
    id: 'invalid.research_response_duplicate_citation_source',
    area: 'interchange',
    schema: 'research_response',
    valid: false,
    expected_issue_path: '/sources/1/citation_ids/0',
    path: 'fixtures/invalid/research-response-duplicate-citation-source.json',
    payload: invalidSharedDuplicateCitationSource,
  },
  {
    id: 'invalid.research_response_dangling_citation_source',
    area: 'interchange',
    schema: 'research_response',
    valid: false,
    expected_issue_path: '/sources/0/citation_ids/0',
    path: 'fixtures/invalid/research-response-dangling-citation-source.json',
    payload: invalidSharedDanglingCitationSource,
  },
  {
    id: 'invalid.research_response_unowned_citation',
    area: 'interchange',
    schema: 'research_response',
    valid: false,
    expected_issue_path: '/results/0/citations/0/citation_id',
    path: 'fixtures/invalid/research-response-unowned-citation.json',
    payload: invalidSharedUnownedCitation,
  },
  {
    id: 'invalid.research_response_terminal_shape',
    area: 'interchange',
    schema: 'research_response',
    valid: false,
    expected_issue_path: '/errors',
    path: 'fixtures/invalid/research-response-terminal-shape.json',
    payload: invalidSharedTerminalShape,
  },
  {
    id: 'invalid.research_response_semantic_profile',
    area: 'interchange',
    schema: 'research_response',
    valid: false,
    expected_issue_path: '/results/0/semantic_facts/result_kinds',
    path: 'fixtures/invalid/research-response-semantic-profile.json',
    payload: invalidSharedSemanticProfile,
  },
  {
    id: 'invalid.research_response_effective_target',
    area: 'interchange',
    schema: 'research_response',
    valid: false,
    expected_issue_path: '/results/0/provenance/effective_target/kind',
    path: 'fixtures/invalid/research-response-effective-target.json',
    payload: invalidSharedEffectiveTarget,
  },
  {
    id: 'invalid.research_response_citation_provider',
    area: 'interchange',
    schema: 'research_response',
    valid: false,
    expected_issue_path: '/results/0/citations/0/provenance/provider',
    path: 'fixtures/invalid/research-response-citation-provider.json',
    payload: invalidSharedCitationProvider,
  },
  ...(
    [
      ['pending', invalidSharedPendingStatus],
      ['cancelled', invalidSharedCancelledStatus],
      ['unsuccessful', invalidSharedUnsuccessfulStatus],
      ['submitted', invalidSharedSubmittedStatus],
      ['running', invalidSharedRunningStatus],
    ] as const
  ).map(([status, payload]) => ({
    id: `invalid.research_response_${status}_status`,
    area: 'interchange' as const,
    schema: 'research_response' as const,
    valid: false as const,
    expected_issue_path: '/status',
    path: `fixtures/invalid/research-response-${status}-status.json`,
    payload,
  })),
] as const;

const schemaTargets = {
  provider_identity: {
    schema_path: 'schema/domain.schema.json',
    schema_ref: '#/$defs/provider_identity',
  },
  interchange_request: {
    schema_path: 'schema/artifacts.schema.json',
    schema_ref: '#/$defs/execution_request',
  },
  interchange_response: {
    schema_path: 'schema/artifacts.schema.json',
    schema_ref: '#/$defs/execution_response',
  },
  research_response: {
    schema_path: 'schema/interchange.schema.json',
    schema_ref: '#/$defs/research_response',
  },
  lifecycle_trace: {
    schema_path: 'schema/artifacts.schema.json',
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
  sources_artifact: {
    schema_path: 'schema/artifacts.schema.json',
    schema_ref: '#/$defs/sources',
  },
} as const;

const semanticFixtureRules: Record<string, string> = {
  'invalid.target_configurable_missing_kind':
    'target.selection_coherence',
  'invalid.target_configurable_missing_id': 'target.selection_coherence',
  'invalid.target_fixed_missing_kind': 'target.selection_coherence',
  'invalid.target_fixed_missing_id': 'target.selection_coherence',
  'invalid.target_provider_managed_id': 'target.selection_coherence',
  'invalid.target_not_applicable_kind': 'target.selection_coherence',
  'invalid.target_not_applicable_id': 'target.selection_coherence',
  'invalid.target_underlying_primary_model': 'target.underlying_coherence',
  'invalid.target_underlying_provider_managed':
    'target.underlying_coherence',
  'invalid.target_underlying_nested_agent': 'target.underlying_coherence',
  'invalid.async_non_durable_profile': 'request.preflight_plan_compatibility',
  'invalid.incompatible_fallback': 'request.preflight_plan_compatibility',
  'invalid.secret_extension': 'extensions.bounded_namespaced_json',
  'invalid.nested_camel_case_secret': 'extensions.bounded_namespaced_json',
  'invalid.compound_secret_extension': 'extensions.bounded_namespaced_json',
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
  'invalid.citation_provider_target': 'citation.provider_identity_binding',
  'invalid.response_selected_attempt_status': 'response.lossless_references',
  'invalid.response_effective_profile': 'response.lossless_references',
  'invalid.response_effective_profile_target': 'response.lossless_references',
  'invalid.response_requested_profile_target': 'response.lossless_references',
  'invalid.response_collection_provider': 'response.lossless_references',
  'invalid.response_collection_provider_target': 'response.lossless_references',
  'invalid.response_replacement_provenance': 'response.lossless_references',
  'invalid.response_replacement_of_succeeded':
    'response.fallback_replacement_policy',
  'invalid.response_attempt_handle_provider':
    'durable_handle.profile_identity_binding',
  'invalid.response_attempt_handle_target':
    'durable_handle.profile_identity_binding',
  'invalid.response_semantic_facts': 'response.semantic_profile_coherence',
  'invalid.response_observation_mode': 'response.semantic_profile_coherence',
  'invalid.response_measured_surface': 'response.semantic_profile_coherence',
  'invalid.response_required_grounding': 'response.semantic_profile_coherence',
  'invalid.response_none_grounding': 'response.semantic_profile_coherence',
  'invalid.response_effective_target_kind':
    'response.effective_target_coherence',
  'invalid.response_not_applicable_effective_target':
    'response.effective_target_coherence',
  'invalid.response_fallback_candidate_reuse':
    'response.fallback_consumption',
  'invalid.response_mixed_unsuccessful_status': 'response.status_coherence',
  'invalid.custom_provider_result_identifiers':
    'custom_provider.result_binding',
  'invalid.custom_provider_citation_target':
    'citation.provider_identity_binding',
  'invalid.custom_provider_status_handle_binding':
    'custom_provider.task_binding',
  'invalid.run_manifest_slot_order': 'artifacts.run_manifest_execution_plan',
  'invalid.run_manifest_fallback_candidate':
    'artifacts.run_manifest_execution_plan',
  'invalid.run_manifest_primary_profile':
    'artifacts.run_manifest_execution_plan',
  'invalid.run_manifest_fallback_candidate_reuse':
    'artifacts.run_manifest_execution_plan',
  'invalid.fallback_surface_lane': 'surface_observation.fallback_lane',
  'invalid.fallback_surface_identity': 'surface_observation.fallback_lane',
  'invalid.surface_profile_missing_identity':
    'surface_observation.profile_invariants',
  'invalid.surface_snapshot_retrieval':
    'surface_observation.profile_invariants',
  'invalid.surface_snapshot_access':
    'surface_observation.profile_invariants',
  'invalid.sources_dangling_citation': 'artifacts.sources_reference_integrity',
  'invalid.sources_duplicate_identity': 'artifacts.sources_reference_integrity',
  'invalid.sources_duplicate_citation_identity':
    'artifacts.sources_reference_integrity',
  'invalid.sources_duplicate_reference':
    'artifacts.sources_reference_integrity',
  'invalid.research_response_collection_provider':
    'research_response.result_provenance',
  'invalid.research_response_duplicate_citation_source':
    'research_response.source_integrity',
  'invalid.research_response_dangling_citation_source':
    'research_response.source_integrity',
  'invalid.research_response_unowned_citation':
    'research_response.source_integrity',
  'invalid.research_response_terminal_shape':
    'research_response.terminal_shape',
  'invalid.research_response_semantic_profile':
    'research_response.semantic_profile_coherence',
  'invalid.research_response_effective_target':
    'research_response.effective_target_coherence',
  'invalid.research_response_citation_provider':
    'citation.provider_identity_binding',
};

const internalFixtureDefinitions = fixtureDefinitions.map((fixture) =>
  fixture.area === 'interchange'
    ? { ...fixture, area: 'artifacts' as const }
    : fixture,
);
const allFixtureDefinitions = [
  ...internalFixtureDefinitions,
  ...sharedFixtureDefinitions,
];
const fixtureFiles = allFixtureDefinitions.map((fixture) =>
  write(fixture.path, fixture.payload),
);
const fixtureIndex = allFixtureDefinitions.map((fixture) => {
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
    interchange: RESEARCH_RESPONSE_CONTRACT_VERSION,
  },
  semantic_rules: [
    {
      rule_id: 'target.selection_coherence',
      version: '1.0.0',
      description:
        'Configurable and fixed target slots identify a kind and target_id, provider-managed slots omit target_id until runtime, and not-applicable slots omit both.',
    },
    {
      rule_id: 'target.underlying_coherence',
      version: '1.0.0',
      description:
        'Underlying targets exist only beneath primary agents or presets and identify a configurable or fixed model without creating nested target identities.',
    },
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
      rule_id: 'response.fallback_replacement_policy',
      version: '1.0.0',
      description:
        'Fallback attempts replace only failed or timed-out attempts whose error explicitly permits fallback.',
    },
    {
      rule_id: 'response.fallback_consumption',
      version: '1.0.0',
      description:
        'Each fallback candidate and exact provider profile target executes at most once across a response.',
    },
    {
      rule_id: 'response.semantic_profile_coherence',
      version: '1.0.0',
      description:
        'Result semantic facts remain within and identify the effective execution profile.',
    },
    {
      rule_id: 'response.effective_target_coherence',
      version: '1.0.0',
      description:
        'Optional runtime effective targets are provider-reported facts whose kind matches a declared primary or underlying profile target.',
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
      rule_id: 'citation.provider_identity_binding',
      version: '1.0.0',
      description:
        'Every citation identifies the same exact provider profile target as the producing effective execution profile.',
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
      rule_id: 'durable_handle.profile_identity_binding',
      version: '1.0.0',
      description:
        'Attempt durable handles identify the same provider profile as their owning attempt.',
    },
    {
      rule_id: 'artifacts.run_manifest_execution_plan',
      version: '1.0.0',
      description:
        'Run manifest response slots and attempts exactly implement the request primary and eligible ordered fallback plan.',
    },
    {
      rule_id: 'surface_observation.fallback_lane',
      version: '1.0.0',
      description:
        'Surface-snapshot fallbacks preserve observation mode, collector lane, and measured surface.',
    },
    {
      rule_id: 'surface_observation.profile_invariants',
      version: '1.0.0',
      description:
        'Surface observations identify their measured surface, while snapshots use an identified surface collector.',
    },
    {
      rule_id: 'artifacts.sources_reference_integrity',
      version: '1.0.0',
      description:
        'Source and citation identities are unique, and every source citation reference resolves.',
    },
    {
      rule_id: 'verification.consumer_owned_policy',
      version: '1.0.0',
      description:
        'Evidence facts cross the boundary without a universal verified boolean or threshold.',
    },
    {
      rule_id: 'research_response.terminal_shape',
      version: '1.0.0',
      description:
        'Shared responses contain only terminal succeeded, partial, or failed outcomes with coherent results and errors.',
    },
    {
      rule_id: 'research_response.producer_receipt',
      version: '1.0.0',
      description:
        'Every shared response identifies its actual producing package and independent SemVer 2 package release.',
    },
    {
      rule_id: 'research_response.result_provenance',
      version: '1.0.0',
      description:
        'A terminal result collection identifies the effective producing profile without exposing execution attempts.',
    },
    {
      rule_id: 'research_response.semantic_profile_coherence',
      version: '1.0.0',
      description:
        'Terminal result facts remain within and identify the effective profile.',
    },
    {
      rule_id: 'research_response.effective_target_coherence',
      version: '1.0.0',
      description:
        'Provider-reported effective targets match a declared effective profile target kind.',
    },
    {
      rule_id: 'research_response.source_integrity',
      version: '1.0.0',
      description:
        'Every terminal response citation belongs to exactly one normalized source, and every source reference resolves.',
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
        new Set(
          allFixtureDefinitions.map((fixture) => fixture.area),
        ),
      ).sort(),
    },
    ...fixtureFiles.map((path) => ({
      path,
      role: 'fixture',
      areas: [
        allFixtureDefinitions.find((fixture) => fixture.path === path)!.area,
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
assertExactSnapshotInventory([...filesToChecksum, 'checksums.sha256']);

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
