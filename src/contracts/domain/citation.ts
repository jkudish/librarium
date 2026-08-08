import { z } from 'zod/v4';
import {
  ExtensionsSchema,
  HttpUrlSchema,
  OpaqueIdSchema,
  Rfc3339UtcSchema,
  SnakeCaseNameSchema,
} from '../common.js';
import {
  CollectionProvenanceSchema,
  CorrelationKeysSchema,
} from './provenance.js';

export const SourceKindSchema = z.enum([
  'web_page',
  'news_article',
  'x_post',
  'file',
  'place',
  'video',
  'forum_post',
  'data_record',
  'unknown',
]);

export const SourceCategorySchema = SnakeCaseNameSchema;

export const CitationDerivationSchema = z.enum([
  'provider_reported',
  'collector_extracted',
  'librarium_inferred',
]);

export const CitationSchema = z
  .strictObject({
    citation_id: OpaqueIdSchema,
    source_kind: SourceKindSchema,
    source_category: SourceCategorySchema.optional(),
    dataset_id: OpaqueIdSchema.optional(),
    derivation: CitationDerivationSchema,
    url: HttpUrlSchema.optional(),
    title: z.string().min(1).max(1_024).optional(),
    snippet: z.string().min(1).max(8_192).optional(),
    provider_reference: OpaqueIdSchema.optional(),
    location: z.string().min(1).max(512).optional(),
    retrieved_at: Rfc3339UtcSchema.optional(),
    provenance: CollectionProvenanceSchema,
    extensions: ExtensionsSchema.optional(),
  })
  .superRefine((citation, ctx) => {
    if (!citation.url && !citation.provider_reference) {
      ctx.addIssue({
        code: 'custom',
        message: 'Citations require an HTTP(S) URL or provider_reference',
        path: ['url'],
      });
    }
  });

export const NormalizedSourceSchema = z
  .strictObject({
    source_id: OpaqueIdSchema,
    canonical_url: HttpUrlSchema.optional(),
    provider_reference: OpaqueIdSchema.optional(),
    source_kind: SourceKindSchema,
    source_category: SourceCategorySchema.optional(),
    dataset_id: OpaqueIdSchema.optional(),
    publisher_id: OpaqueIdSchema.optional(),
    publisher_name: z.string().min(1).max(512).optional(),
    citation_ids: z.array(OpaqueIdSchema).min(1).max(1_000),
    correlation_keys: CorrelationKeysSchema.optional(),
    extensions: ExtensionsSchema.optional(),
  })
  .superRefine((source, ctx) => {
    if (!source.canonical_url && !source.provider_reference) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Normalized sources require an HTTP(S) canonical_url or provider_reference',
        path: ['canonical_url'],
      });
    }
  });

export type Citation = z.infer<typeof CitationSchema>;
export type CitationDerivation = z.infer<typeof CitationDerivationSchema>;
export type NormalizedSource = z.infer<typeof NormalizedSourceSchema>;
export type SourceCategory = z.infer<typeof SourceCategorySchema>;
export type SourceKind = z.infer<typeof SourceKindSchema>;
