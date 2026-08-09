import { z } from 'zod/v4';
import {
  ExtensionsSchema,
  OpaqueIdSchema,
  PackageIdentitySchema,
  PackageReleaseSchema,
  Rfc3339UtcSchema,
} from '../common.js';
import {
  NormalizedSourceSchema,
  ProviderIdentitySchema,
  StructuredErrorSchema,
  UsageSchema,
} from '../domain/index.js';
import { ResearchResultSchema } from './research-result.js';

/** Development snapshot family, deliberately independent of execution schemas. */
export const RESEARCH_RESPONSE_CONTRACT_VERSION = '1.0.0' as const;

export const ResearchErrorSchema = z.strictObject({
  provider: ProviderIdentitySchema.optional(),
  error: StructuredErrorSchema,
  usage: UsageSchema.optional(),
  extensions: ExtensionsSchema.optional(),
});

export const ResearchResponseSchema = z
  .strictObject({
    generator: PackageIdentitySchema,
    generator_version: PackageReleaseSchema,
    request_id: OpaqueIdSchema,
    status: z.enum(['succeeded', 'partial', 'failed']),
    completed_at: Rfc3339UtcSchema,
    results: z.array(ResearchResultSchema).max(64),
    errors: z.array(ResearchErrorSchema).max(64),
    sources: z.array(NormalizedSourceSchema).max(100_000),
    usage: UsageSchema.optional(),
    extensions: ExtensionsSchema.optional(),
  })
  .superRefine((response, ctx) => {
    if (response.status === 'succeeded' && response.errors.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Succeeded responses cannot contain terminal errors',
        path: ['errors'],
      });
    }
    if (response.status === 'succeeded' && response.results.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Succeeded responses require at least one result',
        path: ['results'],
      });
    }
    if (
      response.status === 'partial' &&
      (response.results.length === 0 || response.errors.length === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Partial responses require both results and terminal errors',
        path: response.results.length === 0 ? ['results'] : ['errors'],
      });
    }
    if (
      response.status === 'failed' &&
      (response.results.length !== 0 || response.errors.length === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Failed responses require errors and cannot contain results',
        path: response.results.length !== 0 ? ['results'] : ['errors'],
      });
    }

    const resultIds = new Set<string>();
    const citationIds = new Set<string>();
    response.results.forEach((result, resultIndex) => {
      if (resultIds.has(result.result_id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'result_id values must be unique',
          path: ['results', resultIndex, 'result_id'],
        });
      }
      resultIds.add(result.result_id);
      result.citations.forEach((citation, citationIndex) => {
        if (citationIds.has(citation.citation_id)) {
          ctx.addIssue({
            code: 'custom',
            message: 'citation_id values must be unique across a response',
            path: [
              'results',
              resultIndex,
              'citations',
              citationIndex,
              'citation_id',
            ],
          });
        }
        citationIds.add(citation.citation_id);
      });
    });

    const sourceIds = new Set<string>();
    const referencedCitationIds = new Set<string>();
    response.sources.forEach((source, sourceIndex) => {
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
        if (referencedCitationIds.has(citationId)) {
          ctx.addIssue({
            code: 'custom',
            message: 'Each response citation must belong to exactly one source',
            path: ['sources', sourceIndex, 'citation_ids', citationIndex],
          });
        }
        referencedCitationIds.add(citationId);
        if (!citationIds.has(citationId)) {
          ctx.addIssue({
            code: 'custom',
            message: 'Source citation_ids must reference a response citation',
            path: ['sources', sourceIndex, 'citation_ids', citationIndex],
          });
        }
      });
    });
    response.results.forEach((result, resultIndex) => {
      result.citations.forEach((citation, citationIndex) => {
        if (!referencedCitationIds.has(citation.citation_id)) {
          ctx.addIssue({
            code: 'custom',
            message: 'Each response citation must belong to exactly one source',
            path: [
              'results',
              resultIndex,
              'citations',
              citationIndex,
              'citation_id',
            ],
          });
        }
      });
    });
  });

export type ResearchError = z.infer<typeof ResearchErrorSchema>;
export type ResearchResponse = z.infer<typeof ResearchResponseSchema>;
