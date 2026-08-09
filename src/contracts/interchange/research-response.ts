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

const compareRfc3339Utc = (left: string, right: string): number => {
  const [leftSecond, leftFraction = ''] = left.slice(0, -1).split('.');
  const [rightSecond, rightFraction = ''] = right.slice(0, -1).split('.');
  if (leftSecond !== rightSecond) return leftSecond < rightSecond ? -1 : 1;

  const width = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeft = leftFraction.padEnd(width, '0');
  const normalizedRight = rightFraction.padEnd(width, '0');
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
};

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
    const citationsById = new Map<
      string,
      z.infer<typeof ResearchResultSchema>['citations'][number]
    >();
    response.results.forEach((result, resultIndex) => {
      if (compareRfc3339Utc(result.completed_at, response.completed_at) > 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'Response completed_at cannot precede a result completed_at',
          path: ['results', resultIndex, 'completed_at'],
        });
      }
      if (resultIds.has(result.result_id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'result_id values must be unique',
          path: ['results', resultIndex, 'result_id'],
        });
      }
      resultIds.add(result.result_id);
      result.citations.forEach((citation, citationIndex) => {
        if (citationsById.has(citation.citation_id)) {
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
        citationsById.set(citation.citation_id, citation);
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
        if (!citationsById.has(citationId)) {
          ctx.addIssue({
            code: 'custom',
            message: 'Source citation_ids must reference a response citation',
            path: ['sources', sourceIndex, 'citation_ids', citationIndex],
          });
        }
        const citation = citationsById.get(citationId);
        if (citation) {
          if (source.source_kind !== citation.source_kind)
            ctx.addIssue({
              code: 'custom',
              message: 'Source source_kind must match its citation',
              path: ['sources', sourceIndex, 'source_kind'],
            });
          for (const field of [
            'source_category',
            'dataset_id',
            'provider_reference',
          ] as const) {
            if (
              source[field] !== undefined &&
              citation[field] !== undefined &&
              source[field] !== citation[field]
            )
              ctx.addIssue({
                code: 'custom',
                message: `Source ${field} must match its citation when both are present`,
                path: ['sources', sourceIndex, field],
              });
          }
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
