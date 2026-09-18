import { z } from 'zod/v4';
import {
  ExtensionsSchema,
  OpaqueIdSchema,
  Rfc3339UtcSchema,
  SemverSchema,
} from '../common.js';
import {
  CitationSchema,
  ExecutionProfileSchema,
  executionProfilesEqual,
  NormalizedSourceSchema,
  ProviderIdentitySchema,
  providerIdentityKey,
  StructuredErrorSchema,
} from '../domain/index.js';
import {
  AttemptSchema,
  InterchangeRequestSchema,
  InterchangeResponseSchema,
  InterchangeResultSchema,
  LifecycleEventSchema,
} from '../interchange/internal.js';
import { ARTIFACT_VERSIONS } from './versions.js';

const artifactHeader = {
  generated_at: Rfc3339UtcSchema,
  extensions: ExtensionsSchema.optional(),
};

export const ArtifactProducerSchema = z.strictObject({
  id: OpaqueIdSchema,
  version: OpaqueIdSchema,
});

export const RunManifestArtifactSchema = z
  .strictObject({
    ...artifactHeader,
    artifact_name: z.literal('run_manifest'),
    artifact_version: z.literal(ARTIFACT_VERSIONS.run_manifest),
    producer: ArtifactProducerSchema,
    request: InterchangeRequestSchema,
    response: InterchangeResponseSchema,
  })
  .superRefine((manifest, ctx) => {
    const consumedCandidateIds = new Set<string>();
    const executedProfileKeys = new Set<string>();

    if (manifest.request.request_id !== manifest.response.request_id) {
      ctx.addIssue({
        code: 'custom',
        message: 'Run manifest request and response identifiers must match',
        path: ['response', 'request_id'],
      });
    }

    if (manifest.request.slots.length !== manifest.response.slots.length) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Run manifest response slots must exactly match the requested slot set and order',
        path: ['response', 'slots'],
      });
    }

    manifest.request.slots.forEach((requestedSlot, slotIndex) => {
      const responseSlot = manifest.response.slots[slotIndex];
      if (responseSlot?.slot_id !== requestedSlot.slot_id) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Run manifest response slots must exactly match the requested slot set and order',
          path: ['response', 'slots', slotIndex, 'slot_id'],
        });
      }

      const slotAttempts = manifest.response.attempts.filter(
        (attempt) => attempt.slot_id === requestedSlot.slot_id,
      );
      let previousCandidatePosition = -1;
      slotAttempts.forEach((attempt, attemptIndex) => {
        const responseAttemptIndex =
          manifest.response.attempts.indexOf(attempt);
        const executedProfileKey = providerIdentityKey(
          attempt.profile.identity,
        );
        if (executedProfileKeys.has(executedProfileKey)) {
          ctx.addIssue({
            code: 'custom',
            message:
              'Each exact provider profile target may execute at most once across the run manifest',
            path: [
              'response',
              'attempts',
              responseAttemptIndex,
              'profile',
              'identity',
            ],
          });
        }
        executedProfileKeys.add(executedProfileKey);

        if (attempt.candidate_id !== undefined) {
          if (consumedCandidateIds.has(attempt.candidate_id)) {
            ctx.addIssue({
              code: 'custom',
              message:
                'Each fallback candidate may be consumed at most once across all slots',
              path: [
                'response',
                'attempts',
                responseAttemptIndex,
                'candidate_id',
              ],
            });
          }
          consumedCandidateIds.add(attempt.candidate_id);
        }

        if (attempt.attempt_number !== attemptIndex + 1) {
          ctx.addIssue({
            code: 'custom',
            message:
              'Run manifest attempt numbers must be contiguous within each slot',
            path: [
              'response',
              'attempts',
              responseAttemptIndex,
              'attempt_number',
            ],
          });
        }

        if (attemptIndex === 0) {
          if (
            attempt.candidate_id !== undefined ||
            attempt.replaces_attempt_id !== undefined ||
            !executionProfilesEqual(attempt.profile, requestedSlot.primary)
          ) {
            ctx.addIssue({
              code: 'custom',
              message:
                'The first attempt for a slot must execute its requested primary profile',
              path: ['response', 'attempts', responseAttemptIndex],
            });
          }
          return;
        }

        const previousAttempt = slotAttempts[attemptIndex - 1];
        const candidate = manifest.request.fallback_reserve.find(
          (entry) => entry.candidate_id === attempt.candidate_id,
        );
        const candidateMatches = candidate
          ? candidate.eligible_slot_ids.includes(requestedSlot.slot_id) &&
            executionProfilesEqual(attempt.profile, candidate.profile)
          : false;
        if (!candidateMatches) {
          ctx.addIssue({
            code: 'custom',
            message:
              'Replacement attempts must use an eligible fallback candidate with the matching profile',
            path: [
              'response',
              'attempts',
              responseAttemptIndex,
              'candidate_id',
            ],
          });
        }
        if (attempt.replaces_attempt_id !== previousAttempt?.attempt_id) {
          ctx.addIssue({
            code: 'custom',
            message:
              'Replacement attempts must replace the immediately preceding attempt in their slot',
            path: [
              'response',
              'attempts',
              responseAttemptIndex,
              'replaces_attempt_id',
            ],
          });
        }
        if (candidate && candidate.position <= previousCandidatePosition) {
          ctx.addIssue({
            code: 'custom',
            message:
              'Fallback candidates must be selected in increasing reserve order',
            path: [
              'response',
              'attempts',
              responseAttemptIndex,
              'candidate_id',
            ],
          });
        }
        if (candidate) previousCandidatePosition = candidate.position;
      });
    });
  });

export const ProviderMetadataEntrySchema = z.strictObject({
  provider: ProviderIdentitySchema,
  display_name: z.string().min(1).max(256),
  profiles: z.array(ExecutionProfileSchema).min(1).max(64),
  availability: z.enum([
    'available',
    'disabled',
    'uncredentialed',
    'misconfigured',
  ]),
  configuration_error: StructuredErrorSchema.optional(),
  extensions: ExtensionsSchema.optional(),
});

export const ProviderMetadataArtifactSchema = z.strictObject({
  ...artifactHeader,
  artifact_name: z.literal('provider_metadata'),
  artifact_version: z.literal(ARTIFACT_VERSIONS.provider_metadata),
  providers: z.array(ProviderMetadataEntrySchema).max(1_000),
});

export const SourcesArtifactSchema = z
  .strictObject({
    ...artifactHeader,
    artifact_name: z.literal('sources'),
    artifact_version: z.literal(ARTIFACT_VERSIONS.sources),
    request_id: OpaqueIdSchema,
    sources: z.array(NormalizedSourceSchema).max(100_000),
    citations: z.array(CitationSchema).max(100_000),
  })
  .superRefine((artifact, ctx) => {
    const citationIds = new Set<string>();
    artifact.citations.forEach((citation, index) => {
      if (citationIds.has(citation.citation_id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'citation_id values must be unique',
          path: ['citations', index, 'citation_id'],
        });
      }
      citationIds.add(citation.citation_id);
    });

    const sourceIds = new Set<string>();
    artifact.sources.forEach((source, sourceIndex) => {
      if (sourceIds.has(source.source_id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'source_id values must be unique',
          path: ['sources', sourceIndex, 'source_id'],
        });
      }
      sourceIds.add(source.source_id);

      const sourceCitationIds = new Set<string>();
      source.citation_ids.forEach((citationId, citationIndex) => {
        if (sourceCitationIds.has(citationId)) {
          ctx.addIssue({
            code: 'custom',
            message: 'Source citation_ids must be unique',
            path: ['sources', sourceIndex, 'citation_ids', citationIndex],
          });
        }
        sourceCitationIds.add(citationId);
        if (!citationIds.has(citationId)) {
          ctx.addIssue({
            code: 'custom',
            message: 'Source citation_ids must reference an artifact citation',
            path: ['sources', sourceIndex, 'citation_ids', citationIndex],
          });
        }
      });
    });
  });

const jsonlHeader = {
  ...artifactHeader,
  artifact_name: z.literal('jsonl_record'),
  artifact_version: z.literal(ARTIFACT_VERSIONS.jsonl_record),
  request_id: OpaqueIdSchema,
};

export const JsonlArtifactRecordSchema = z
  .discriminatedUnion('record_type', [
    z.strictObject({
      ...jsonlHeader,
      record_type: z.literal('request'),
      payload: InterchangeRequestSchema,
    }),
    z.strictObject({
      ...jsonlHeader,
      record_type: z.literal('attempt'),
      payload: AttemptSchema,
    }),
    z.strictObject({
      ...jsonlHeader,
      record_type: z.literal('result'),
      payload: InterchangeResultSchema,
    }),
    z.strictObject({
      ...jsonlHeader,
      record_type: z.literal('lifecycle_event'),
      payload: LifecycleEventSchema,
    }),
  ])
  .superRefine((record, ctx) => {
    const payloadRequestId =
      record.record_type === 'request' ||
      record.record_type === 'lifecycle_event'
        ? record.payload.request_id
        : record.record_type === 'result'
          ? record.payload.provenance.request_id
          : undefined;
    if (payloadRequestId && payloadRequestId !== record.request_id) {
      ctx.addIssue({
        code: 'custom',
        message: 'JSONL payload request_id must match its record envelope',
        path: ['payload'],
      });
    }
  });

export const HistoricalArtifactReaderSchema = z
  .strictObject({
    artifact_name: z.enum([
      'run_manifest',
      'provider_metadata',
      'sources',
      'jsonl_record',
    ]),
    current_version: SemverSchema,
    readable_versions: z.array(SemverSchema).min(1).max(32),
    unknown_version_policy: z.literal('reject'),
    migration_policy: z.enum(['none', 'lossless_explicit']),
  })
  .superRefine((reader, ctx) => {
    if (!reader.readable_versions.includes(reader.current_version)) {
      ctx.addIssue({
        code: 'custom',
        message: 'readable_versions must include current_version',
        path: ['readable_versions'],
      });
    }
  });

export const ArtifactSchema = z.discriminatedUnion('artifact_name', [
  RunManifestArtifactSchema,
  ProviderMetadataArtifactSchema,
  SourcesArtifactSchema,
  JsonlArtifactRecordSchema,
]);

export type Artifact = z.infer<typeof ArtifactSchema>;
export type ArtifactProducer = z.infer<typeof ArtifactProducerSchema>;
export type HistoricalArtifactReader = z.infer<
  typeof HistoricalArtifactReaderSchema
>;
export type JsonlArtifactRecord = z.infer<typeof JsonlArtifactRecordSchema>;
export type ProviderMetadataArtifact = z.infer<
  typeof ProviderMetadataArtifactSchema
>;
export type ProviderMetadataEntry = z.infer<typeof ProviderMetadataEntrySchema>;
export type RunManifestArtifact = z.infer<typeof RunManifestArtifactSchema>;
export type SourcesArtifact = z.infer<typeof SourcesArtifactSchema>;
