import { z } from 'zod/v4';
import { isForbiddenExtensionKey, Rfc3339UtcSchema } from '../common.js';

const OpenStringSchema = z.string().min(1);
export const TerminalIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Wire IDs exclude controls.
    /^(?!\s)(?!.*\s$)[^\0-\x1f\x7f]+$/,
    'Identifiers cannot have surrounding whitespace or control characters',
  );
const DecimalSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/, 'Expected a decimal string');

export const SourceKindSchema = z.enum([
  'web_page',
  'news_article',
  'x_post',
  'file',
  'place',
  'video',
  'forum_post',
  'unknown',
]);

/** An embedded, untrusted source identifier. */
export const SourceSchema = z
  .strictObject({
    kind: SourceKindSchema,
    url: OpenStringSchema.optional(),
    provider_reference: TerminalIdSchema.optional(),
    title: OpenStringSchema.optional(),
    publisher: OpenStringSchema.optional(),
    published_at: Rfc3339UtcSchema.optional(),
  })
  .superRefine((source, ctx) => {
    if (!source.url && !source.provider_reference) {
      ctx.addIssue({
        code: 'custom',
        message: 'Sources require a URL or provider_reference',
        path: ['url'],
      });
    }
  });

export const CitationSchema = z.strictObject({
  id: TerminalIdSchema,
  derivation: z.enum([
    'provider_reported',
    'collector_extracted',
    'librarium_inferred',
  ]),
  source: SourceSchema,
  excerpt: OpenStringSchema.optional(),
  locator: OpenStringSchema.optional(),
});

export const UsageSchema = z
  .strictObject({
    prompt_tokens: z.number().int().safe().nonnegative().optional(),
    completion_tokens: z.number().int().safe().nonnegative().optional(),
    cache_write_input_tokens: z.number().int().safe().nonnegative().optional(),
    cache_read_input_tokens: z.number().int().safe().nonnegative().optional(),
    reasoning_tokens: z.number().int().safe().nonnegative().optional(),
    actual_cost: DecimalSchema.optional(),
    estimated_cost: DecimalSchema.optional(),
    currency: OpenStringSchema.optional(),
  })
  .superRefine((usage, ctx) => {
    if ((usage.actual_cost || usage.estimated_cost) && !usage.currency) {
      ctx.addIssue({
        code: 'custom',
        message: 'Costs require currency',
        path: ['currency'],
      });
    }
  });

const ProviderMetaValueSchema = z.json();
const rawKey = (key: string): boolean => {
  const normalized = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z\d]+/g, '_');
  return (
    /(?:^|_)raw(?:_|$)/.test(normalized) ||
    /(?:^|_)provider_(?:response|payload|body)(?:_|$)/.test(normalized)
  );
};
const completeRawContainer = (key: string, value: unknown): boolean => {
  const normalized = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
  if (
    !['response', 'payload', 'body'].includes(normalized) ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    return false;
  const keys = Object.keys(value);
  return (
    keys.includes('headers') &&
    (keys.includes('status') || keys.includes('status_code'))
  );
};
const inspectProviderMeta = (
  value: unknown,
  path: PropertyKey[],
  ctx: z.RefinementCtx,
): void => {
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      inspectProviderMeta(child, [...path, index], ctx);
    });
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (
      isForbiddenExtensionKey(key) ||
      rawKey(key) ||
      completeRawContainer(key, child)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'provider_meta cannot contain credential or raw-response fields',
        path: [...path, key],
      });
    }
    inspectProviderMeta(child, [...path, key], ctx);
  }
};

/** Provider-specific public metadata; producers must allowlist and redact it. */
export const ProviderMetaSchema = z
  .record(z.string().min(1), ProviderMetaValueSchema)
  .superRefine((value, ctx) => inspectProviderMeta(value, [], ctx));

const ContextSchema = z.strictObject({
  locale: OpenStringSchema.optional(),
  country: OpenStringSchema.optional(),
  device: OpenStringSchema.optional(),
  authentication: z
    .enum(['anonymous', 'authenticated', 'managed', 'unknown'])
    .optional(),
});

export const ResultProvenanceSchema = z
  .strictObject({
    result_kind: z.enum([
      'search_results',
      'grounded_answer',
      'research_report',
      'model_answer',
    ]),
    retrieval_methods: z.array(
      z.enum([
        'search_endpoint',
        'model_search_tool',
        'research_agent',
        'model_only',
      ]),
    ),
    corpora: z.array(z.enum(['web', 'news', 'x', 'files', 'places'])),
    observed_at: Rfc3339UtcSchema,
    collector: OpenStringSchema.optional(),
    surface: OpenStringSchema.optional(),
    context: ContextSchema.optional(),
  })
  .superRefine((provenance, ctx) => {
    if (provenance.surface && !provenance.collector) {
      ctx.addIssue({
        code: 'custom',
        message: 'Surface requires collector',
        path: ['collector'],
      });
    }
  });

const ResultBase = {
  id: TerminalIdSchema,
  requested_profile: OpenStringSchema,
  provider: OpenStringSchema,
  profile: OpenStringSchema,
  provenance: ResultProvenanceSchema,
  citations: z.array(CitationSchema),
  completed_at: Rfc3339UtcSchema,
  model: OpenStringSchema.optional(),
  fallback_reason: OpenStringSchema.optional(),
  usage: UsageSchema.optional(),
  provider_meta: ProviderMetaSchema.optional(),
};

/** One terminal result with exactly one structurally-discriminated payload. */
export const ResearchResultSchema = z.union([
  z.strictObject({
    ...ResultBase,
    content_format: z.literal('markdown'),
    content: z.string(),
  }),
  z.strictObject({
    ...ResultBase,
    content_format: z.literal('text'),
    content: z.string(),
  }),
  z.strictObject({
    ...ResultBase,
    content_format: z.literal('json'),
    content: z.union([z.record(z.string(), z.json()), z.array(z.json())]),
  }),
]);

export type Citation = z.infer<typeof CitationSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type ResultProvenance = z.infer<typeof ResultProvenanceSchema>;
export type ResearchResult = z.infer<typeof ResearchResultSchema>;
