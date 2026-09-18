import { type ExecutionProfile, providerIdentityKey } from '../domain/index.js';
import type { EvidenceRequirements, RequestSlot } from './request.js';

export function profileKey(profile: ExecutionProfile): string {
  return providerIdentityKey(profile.identity);
}

export function compatibilityIssues(
  requirements: EvidenceRequirements,
  profile: ExecutionProfile,
): string[] {
  const issues: string[] = [];
  if (profile.result_kind !== requirements.result_kind) {
    issues.push('result_kind');
  }
  if (
    requirements.grounding_policy === 'required' &&
    profile.grounding_policy !== 'required'
  ) {
    issues.push('grounding_policy');
  }
  if (
    requirements.grounding_policy === 'optional' &&
    profile.grounding_policy === 'none'
  ) {
    issues.push('grounding_policy');
  }
  if (
    requirements.grounding_policy === 'none' &&
    profile.grounding_policy !== 'none'
  ) {
    issues.push('grounding_policy');
  }
  if (
    requirements.observation_mode &&
    profile.observation_mode !== requirements.observation_mode
  ) {
    issues.push('observation_mode');
  }
  for (const corpus of requirements.corpora) {
    if (!profile.corpora.includes(corpus)) {
      issues.push(`corpora:${corpus}`);
    }
  }
  if (
    requirements.retrieval_methods &&
    !requirements.retrieval_methods.includes(profile.retrieval_method)
  ) {
    issues.push('retrieval_method');
  }
  if (
    requirements.surface_id &&
    profile.surface_id !== requirements.surface_id
  ) {
    issues.push('surface_id');
  }
  if (requirements.surface_context_constraint) {
    const context = profile.surface_context;
    if (!context) {
      issues.push('surface_context');
    } else {
      for (const [field, expected] of Object.entries(
        requirements.surface_context_constraint,
      )) {
        if (
          expected !== undefined &&
          context[field as keyof typeof context] !== expected
        ) {
          issues.push(`surface_context.${field}`);
        }
      }
    }
  }
  return issues;
}

export function fallbackCompatibilityIssues(
  slot: RequestSlot,
  profile: ExecutionProfile,
): string[] {
  const issues = compatibilityIssues(slot.requirements, profile);

  if (
    slot.primary.result_kind === 'surface_observation' &&
    profile.observation_mode !== slot.primary.observation_mode
  ) {
    issues.push('observation_mode:primary');
  }
  if (
    slot.primary.result_kind === 'surface_observation' &&
    profile.surface_id !== slot.primary.surface_id
  ) {
    issues.push('surface_id:primary');
  }
  if (
    slot.primary.observation_mode === 'surface_snapshot' &&
    profile.retrieval_method !== slot.primary.retrieval_method
  ) {
    issues.push('retrieval_method:primary');
  }

  return issues;
}
