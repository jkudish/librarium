import { z } from 'zod/v4';
import {
  ExtensionsSchema,
  jsonValuesEqual,
  OpaqueIdSchema,
  Rfc3339UtcSchema,
} from '../common.js';
import {
  CitationSchema,
  CollectionProvenanceSchema,
  ResearchProfileSchema,
  RuntimeEffectiveTargetSchema,
  SemanticFactsSchema,
  UsageSchema,
} from '../domain/index.js';

/**
 * Descriptive, terminal provenance that is safe to exchange between runtimes.
 * Request correlation belongs to the enclosing ResearchResponse; execution
 * attempts, slots, and replacements are deliberately TypeScript-internal.
 */
export const ResearchResultProvenanceSchema = z.strictObject({
  requested_profile: ResearchProfileSchema,
  effective_profile: ResearchProfileSchema,
  effective_target: RuntimeEffectiveTargetSchema.optional(),
  collection: CollectionProvenanceSchema,
  extensions: ExtensionsSchema.optional(),
});

export const ResearchResultSchema = z
  .strictObject({
    result_id: OpaqueIdSchema,
    content_format: z.enum(['plain_text', 'markdown']),
    content: z.string().min(1).max(2_000_000),
    semantic_facts: SemanticFactsSchema,
    citations: z.array(CitationSchema).max(10_000),
    provenance: ResearchResultProvenanceSchema,
    usage: UsageSchema.optional(),
    completed_at: Rfc3339UtcSchema,
    extensions: ExtensionsSchema.optional(),
  })
  .superRefine((result, ctx) => {
    const facts = result.semantic_facts;
    const profile = result.provenance.effective_profile;
    const effectiveTarget = result.provenance.effective_target;
    const configuredTargetKinds = new Set(
      [
        profile.identity.target.primary.kind,
        profile.identity.target.underlying?.kind,
      ].filter(
        (kind): kind is 'model' | 'agent' | 'preset' => kind !== undefined,
      ),
    );

    const requested = result.provenance.requested_profile;
    const effective = result.provenance.effective_profile;
    if (requested.result_kind !== effective.result_kind) {
      ctx.addIssue({
        code: 'custom',
        message: 'Effective profile must preserve requested result_kind',
        path: ['provenance', 'effective_profile', 'result_kind'],
      });
    }
    if (requested.observation_mode !== effective.observation_mode) {
      ctx.addIssue({
        code: 'custom',
        message: 'Effective profile must preserve requested observation_mode',
        path: ['provenance', 'effective_profile', 'observation_mode'],
      });
    }
    const groundingCompatible =
      requested.grounding_policy === 'optional'
        ? effective.grounding_policy === 'optional' ||
          effective.grounding_policy === 'required'
        : requested.grounding_policy === effective.grounding_policy;
    if (!groundingCompatible) {
      ctx.addIssue({
        code: 'custom',
        message: 'Effective profile must satisfy requested grounding policy',
        path: ['provenance', 'effective_profile', 'grounding_policy'],
      });
    }
    requested.corpora.forEach((corpus, index) => {
      if (!effective.corpora.includes(corpus))
        ctx.addIssue({
          code: 'custom',
          message: 'Effective profile must include every requested corpus',
          path: ['provenance', 'effective_profile', 'corpora', index],
        });
    });
    if (
      requested.result_kind === 'surface_observation' &&
      requested.surface_id !== effective.surface_id
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Effective surface observation must preserve surface_id',
        path: ['provenance', 'effective_profile', 'surface_id'],
      });
    }
    if (
      requested.observation_mode === 'surface_snapshot' &&
      requested.retrieval_method !== effective.retrieval_method
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Effective surface snapshot must preserve retrieval_method',
        path: ['provenance', 'effective_profile', 'retrieval_method'],
      });
    }

    if (
      effectiveTarget !== undefined &&
      profile.identity.target.primary.model_selection === 'not_applicable'
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Runtime effective targets are inapplicable when the profile target is not_applicable',
        path: ['provenance', 'effective_target'],
      });
    } else if (
      effectiveTarget !== undefined &&
      configuredTargetKinds.size > 0 &&
      !configuredTargetKinds.has(effectiveTarget.kind)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Runtime effective target kind must match a declared profile target',
        path: ['provenance', 'effective_target', 'kind'],
      });
    }

    const profileFields = [
      ['provider', profile.identity],
      ['access_mode', profile.access_mode],
      ['operator_id', profile.operator_id],
      ['collector_id', profile.collector_id],
      ['surface_id', profile.surface_id],
      ['surface_context', profile.surface_context],
    ] as const;
    const bindCollection = (
      collection: typeof result.provenance.collection,
      path: PropertyKey[],
    ) =>
      profileFields.forEach(([field, expected]) => {
        if (!jsonValuesEqual(collection[field], expected))
          ctx.addIssue({
            code: 'custom',
            message: `Collection ${field} must match the producing effective profile`,
            path: [...path, field],
          });
      });
    bindCollection(result.provenance.collection, ['provenance', 'collection']);
    result.citations.forEach((citation, index) => {
      bindCollection(citation.provenance, ['citations', index, 'provenance']);
    });

    if (!facts.result_kinds.includes(profile.result_kind)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Result semantic facts must include the effective profile result kind',
        path: ['semantic_facts', 'result_kinds'],
      });
    }
    if (!facts.retrieval_methods.includes(profile.retrieval_method)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Result semantic facts must include the effective profile retrieval method',
        path: ['semantic_facts', 'retrieval_methods'],
      });
    }
    for (const [index, corpus] of facts.corpora.entries()) {
      if (!profile.corpora.includes(corpus)) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Result semantic facts cannot claim corpora outside the effective profile',
          path: ['semantic_facts', 'corpora', index],
        });
      }
    }
    if (facts.observation_mode !== profile.observation_mode) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Result observation mode must match the effective profile observation mode',
        path: ['semantic_facts', 'observation_mode'],
      });
    }
    if (
      profile.surface_id !== undefined &&
      facts.measured_surface_id !== profile.surface_id
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Result measured surface must match the effective profile surface',
        path: ['semantic_facts', 'measured_surface_id'],
      });
    }
    if (
      profile.surface_id === undefined &&
      facts.measured_surface_id !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Result semantic facts cannot claim a measured surface absent from the effective profile',
        path: ['semantic_facts', 'measured_surface_id'],
      });
    }
    if (
      (profile.grounding_policy === 'required' &&
        facts.grounding_outcome !== 'used') ||
      (profile.grounding_policy === 'none' &&
        facts.grounding_outcome === 'used')
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Result grounding outcome must satisfy the effective profile grounding policy',
        path: ['semantic_facts', 'grounding_outcome'],
      });
    }
  });

export type ResearchResult = z.infer<typeof ResearchResultSchema>;
export type ResearchResultProvenance = z.infer<
  typeof ResearchResultProvenanceSchema
>;
