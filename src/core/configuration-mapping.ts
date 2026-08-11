import {
  normalizeProviderName,
  PROVIDER_ID_ALIASES,
  type ProviderNameEntry,
  resolveProviderToken,
} from '../constants.js';
import { OpaqueIdSchema } from '../contracts/common.js';
import type { Config, ProviderConfig } from '../types.js';
import { customWorkflowId } from './builtin-workflows.js';
import { compareCanonicalStrings } from './catalog-fingerprint.js';
import type { CredentialContext } from './credentials.js';
import {
  type AdapterProfileBinding,
  adapterProfileBinding,
  adapterProfileBindings,
  buildProfileBindings,
  TargetSelectionError,
} from './profile-bindings.js';
import {
  buildProviderCatalog,
  type CatalogProfileTarget,
  type CustomCatalogProfile,
  type ProviderCatalog,
} from './profile-catalog.js';
import { BUILTIN_PROVIDER_DEFINITIONS } from './provider-descriptor.js';
import {
  BUILTIN_PROVIDER_CATALOG,
  type ProviderCatalogEntry,
} from './provider-profiles.js';
import type { V1RequestDeadlineMigrationContext } from './request-deadline-migration.js';
import type {
  PreparationIssue,
  PreparationNotice,
} from './research-request.js';
import {
  comparePreparationDiagnostics,
  RESEARCH_REQUEST_LIMITS,
} from './research-request.js';
import { RESERVED_BUILTIN_PROVIDER_IDS } from './reserved-provider-ids.js';
import type {
  CanonicalTransportDefaults,
  ConfigurationTransportInput,
  UnresolvedV1TransportDefaults,
} from './transport-normalization.js';
import { exactUsdBudgets } from './transport-normalization.js';

/** Dependencies are injected so mapping stays pure and network-free. */
export interface ConfigurationMappingOptions {
  /**
   * An explicit canonical total deadline. When omitted, mapping exposes only
   * the validated v1 migration context; a caller must derive the total after
   * concrete primary/reserve selection and perform final schema validation.
   */
  readonly requestDeadlineMs?: number;
  /** Required to prevent injected v1 DEFAULT_GROUPS entering the catalog. */
  readonly authoredGroups: AuthoredGroupProvenance;
  readonly credentials?: CredentialContext;
  readonly catalog?: readonly ProviderCatalogEntry[];
}

export interface AuthoredGroupProvenance {
  readonly global: Readonly<Record<string, readonly string[]>>;
  readonly project: Readonly<Record<string, readonly string[]>>;
}

export interface ConfigurationPreflight {
  readonly notices: readonly PreparationNotice[];
  readonly issues: readonly PreparationIssue[];
}

/**
 * Pure v1-config to v2-catalog mapping. No registry construction, provider
 * imports, subprocesses, network, or filesystem access occurs here.
 */
export interface ConfigurationMappingResult {
  readonly catalog: ProviderCatalog;
  /** Omitted until the caller supplies a valid explicit request limit. */
  readonly transport_defaults?: CanonicalTransportDefaults;
  /**
   * Validated timing facts for the later two-phase deadline migration. This is
   * not a canonical policy and cannot be dispatched without plan derivation
   * and final schema validation.
   */
  readonly deadline_migration?: V1RequestDeadlineMigrationContext;
  /** Private two-phase defaults which intentionally omit unresolved limits. */
  readonly unresolved_transport_defaults?: UnresolvedV1TransportDefaults;
  readonly transport_input: ConfigurationTransportInput;
  readonly groups: Readonly<Record<string, readonly string[]>>;
  /** v1 group spelling to the exact catalog group id. */
  readonly group_aliases: Readonly<Record<string, string>>;
  readonly reserve: readonly CatalogProfileTarget[];
  readonly reserve_only_adapter_ids: readonly string[];
  /** Trust-filtered, closure-free custom bindings used by private ingress. */
  readonly custom_profile_bindings: readonly CustomCatalogProfile[];
  readonly preflight: ConfigurationPreflight;
}

export type ConfigurationProfileTokenResolution =
  | {
      readonly kind: 'exact';
      readonly token: string;
      readonly target: CatalogProfileTarget;
      /** Present only for a retired provider-id alias. */
      readonly alias?: {
        readonly from: string;
        readonly adapter_id: string;
      };
    }
  | {
      readonly kind: 'ambiguous';
      readonly token: string;
      readonly candidates: readonly CatalogProfileTarget[];
    }
  | {
      readonly kind: 'unknown';
      readonly token: string;
      readonly suggestions: readonly string[];
    };

const PROVIDER_NAME_ENTRIES: readonly ProviderNameEntry[] =
  BUILTIN_PROVIDER_DEFINITIONS.map((definition) => ({
    id: definition.id,
    displayName: definition.display.name,
  }));

/** Internal config-derived maps must never inherit JSON-authored keys. */
function safeRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** Return an ordinary public record while retaining an own `__proto__` key. */
function publicRecord<T>(
  record: Readonly<Record<string, T>>,
): Record<string, T> {
  return Object.fromEntries(Object.entries(record));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function ownCustomProfiles(
  profiles: readonly CustomCatalogProfile[],
): readonly CustomCatalogProfile[] {
  return deepFreeze(structuredClone(profiles));
}

function ownValue<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function canonicalProviderId(id: string): string {
  return Object.hasOwn(PROVIDER_ID_ALIASES, id) ? PROVIDER_ID_ALIASES[id]! : id;
}

/**
 * Purely resolve a legacy provider/display/qualified token to one exact
 * catalog identity. An unqualified provider with more than one profile is
 * deliberately ambiguous; callers must preserve the exact strategy.
 */
export function resolveConfigurationProfileToken(
  token: string,
  customProfiles: readonly CustomCatalogProfile[] = [],
): ConfigurationProfileTokenResolution {
  const trimmed = token.trim();
  const qualified = trimmed.split('/');
  if (qualified.length === 2 && qualified[0] && qualified[1]) {
    const target = {
      provider_id: qualified[0],
      profile_id: qualified[1],
    };
    const known = [
      ...adapterProfileBindings().values(),
      ...customProfiles.map(customProfileBinding),
    ].some((binding) => sameProfile(binding, target));
    return known
      ? { kind: 'exact', token: trimmed, target }
      : { kind: 'unknown', token: trimmed, suggestions: [] };
  }
  if (qualified.length !== 1) {
    return { kind: 'unknown', token: trimmed, suggestions: [] };
  }

  const direct = adapterProfileBinding(trimmed);
  if (direct) return exactToken(trimmed, direct);

  const directCustom = customProfiles.find(
    (profile) => profile.adapter_id === trimmed,
  );
  if (directCustom)
    return exactToken(trimmed, customProfileBinding(directCustom));

  const catalogMatches = [
    ...adapterProfileBindings().values(),
    ...customProfiles.map(customProfileBinding),
  ]
    .filter((binding) => binding.provider_id === trimmed)
    .sort((left, right) =>
      compareCanonicalStrings(profileKey(left), profileKey(right)),
    );
  if (catalogMatches.length === 1)
    return exactToken(trimmed, catalogMatches[0]);
  if (catalogMatches.length > 1) {
    return {
      kind: 'ambiguous',
      token: trimmed,
      candidates: catalogMatches.map((binding) => ({
        provider_id: binding.provider_id,
        profile_id: binding.profile_id,
      })),
    };
  }

  // Retain every display-name match so a duplicate stays ambiguous instead of
  // selecting whichever descriptor happened to be declared first.
  const displayMatches = PROVIDER_NAME_ENTRIES.filter(
    (entry) =>
      normalizeProviderName(entry.displayName) ===
      normalizeProviderName(trimmed),
  );
  if (displayMatches.length === 1) {
    const [display] = exactTargetsForProviderEntries(displayMatches);
    if (display) return { kind: 'exact', token: trimmed, target: display };
  }
  if (displayMatches.length > 1) {
    return {
      kind: 'ambiguous',
      token: trimmed,
      candidates: exactTargetsForProviderEntries(displayMatches),
    };
  }

  const provider = resolveProviderToken(trimmed, [...PROVIDER_NAME_ENTRIES]);
  if (provider.kind === 'unknown') {
    return {
      kind: 'unknown',
      token: trimmed,
      suggestions: provider.suggestions.map((candidate) => candidate.id),
    };
  }
  if (provider.kind === 'ambiguous') {
    return {
      kind: 'ambiguous',
      token: trimmed,
      candidates: exactTargetsForProviderEntries(provider.candidates),
    };
  }
  const matches = [
    ...adapterProfileBindings().values(),
    ...customProfiles.map(customProfileBinding),
  ]
    .filter((binding) => binding.provider_id === provider.id)
    .sort((left, right) =>
      compareCanonicalStrings(profileKey(left), profileKey(right)),
    );
  if (matches.length === 1) {
    return exactToken(
      trimmed,
      matches[0],
      provider.kind === 'alias'
        ? { from: trimmed, adapter_id: provider.id }
        : undefined,
    );
  }
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      token: trimmed,
      candidates: matches.map((binding) => ({
        provider_id: binding.provider_id,
        profile_id: binding.profile_id,
      })),
    };
  }
  return { kind: 'unknown', token: trimmed, suggestions: [] };
}

function exactTargetsForProviderEntries(
  entries: readonly ProviderNameEntry[],
): CatalogProfileTarget[] {
  const targets = entries.flatMap((entry) => {
    const adapter = adapterProfileBinding(entry.id);
    if (adapter) {
      return [
        { provider_id: adapter.provider_id, profile_id: adapter.profile_id },
      ];
    }
    return [...adapterProfileBindings().values()]
      .filter((binding) => binding.provider_id === entry.id)
      .map((binding) => ({
        provider_id: binding.provider_id,
        profile_id: binding.profile_id,
      }));
  });
  return [
    ...new Map(
      targets.map((target) => [
        `${target.provider_id}/${target.profile_id}`,
        target,
      ]),
    ).values(),
  ].sort((left, right) =>
    compareCanonicalStrings(
      `${left.provider_id}/${left.profile_id}`,
      `${right.provider_id}/${right.profile_id}`,
    ),
  );
}

function exactToken(
  token: string,
  binding: Pick<
    AdapterProfileBinding,
    'adapter_id' | 'provider_id' | 'profile_id'
  >,
  alias?: { readonly from: string; readonly adapter_id: string },
): ConfigurationProfileTokenResolution {
  return {
    kind: 'exact',
    token,
    target: {
      provider_id: binding.provider_id,
      profile_id: binding.profile_id,
    },
    ...(alias && { alias }),
  };
}

function customProfileBinding(
  profile: CustomCatalogProfile,
): AdapterProfileBinding {
  return {
    adapter_id: profile.adapter_id,
    provider_id: profile.profile.identity.provider_id,
    profile_id: profile.profile.identity.profile_id,
  };
}

function customCatalogProfileCandidates(
  config: Config,
): CustomCatalogProfile[] {
  const trusted = new Set(config.trustedProviderIds);
  const candidates: CustomCatalogProfile[] = [];
  for (const [adapterId, source] of Object.entries(config.customProviders)) {
    if (
      RESERVED_BUILTIN_PROVIDER_IDS.has(adapterId) ||
      !trusted.has(adapterId) ||
      source.executionProfile === undefined
    ) {
      continue;
    }
    candidates.push({
      adapter_id: adapterId,
      binding_id: source.executionProfile.bindingId,
      profile: source.executionProfile.profile,
      ...(source.executionProfile.credential && {
        credential_env_var: source.executionProfile.credential.envVar,
      }),
    });
  }
  return candidates;
}

function validateCustomCatalogProfiles(
  candidates: readonly CustomCatalogProfile[],
  catalog: readonly ProviderCatalogEntry[] = BUILTIN_PROVIDER_CATALOG,
): {
  profiles: CustomCatalogProfile[];
  issues: PreparationIssue[];
} {
  const profiles: CustomCatalogProfile[] = [];
  const issues: PreparationIssue[] = [];
  const profileKeys = new Set(
    catalog.flatMap((entry) =>
      entry.profiles.map((profile) =>
        JSON.stringify([entry.provider_id, profile.profile_id]),
      ),
    ),
  );
  const bindingKeys = new Set<string>();

  for (const candidate of candidates) {
    const adapterId = candidate.adapter_id;
    const basePath = `/customProviders/${escapePointerSegment(adapterId)}/executionProfile`;
    let addressable = true;
    if (!OpaqueIdSchema.safeParse(adapterId).success) {
      addressable = false;
      issues.push({
        code: 'custom_provider_adapter_id_invalid',
        phase: 'migration',
        path: `/customProviders/${escapePointerSegment(adapterId)}`,
        message:
          'Custom-provider adapter ids must be non-empty, trimmed, control-free opaque identifiers.',
      });
    }
    if (adapterId.includes('/')) {
      addressable = false;
      issues.push({
        code: 'custom_provider_adapter_id_unaddressable',
        phase: 'migration',
        path: `/customProviders/${escapePointerSegment(adapterId)}`,
        message:
          'Custom-provider adapter ids cannot contain the "/" selector delimiter.',
      });
    }
    const providerId = candidate.profile.identity.provider_id;
    const profileId = candidate.profile.identity.profile_id;
    if (RESERVED_BUILTIN_PROVIDER_IDS.has(providerId)) {
      addressable = false;
      issues.push({
        code: 'custom_provider_profile_provider_id_reserved',
        phase: 'migration',
        path: `${basePath}/profile/identity/provider_id`,
        message:
          'A custom profile cannot claim a current, planned, or retired built-in provider id.',
      });
    }
    for (const [field, value] of [
      ['provider_id', providerId],
      ['profile_id', profileId],
    ] as const) {
      if (!value.includes('/')) continue;
      addressable = false;
      issues.push({
        code: 'custom_provider_profile_id_unaddressable',
        phase: 'migration',
        path: `${basePath}/profile/identity/${field}`,
        message: `Custom-provider profile ${field} cannot contain the "/" selector delimiter.`,
      });
    }
    if (!addressable) continue;
    if (!OpaqueIdSchema.safeParse(candidate.binding_id).success) {
      issues.push({
        code: 'custom_provider_binding_id_invalid',
        phase: 'migration',
        path: `${basePath}/bindingId`,
        message:
          'Custom-provider binding ids must be non-empty, trimmed, control-free opaque identifiers.',
      });
      continue;
    }
    if (candidate.profile.resumability === 'process_local') {
      issues.push({
        code: 'custom_provider_process_local_unsupported',
        phase: 'migration',
        path: `${basePath}/profile/resumability`,
        message:
          'Custom-provider shadow planning supports inline or durable background profiles; process-local resumability remains on the v1 runtime path.',
      });
      continue;
    }
    const profile = customProfileBinding(candidate);
    const identityTuple = JSON.stringify([
      profile.provider_id,
      profile.profile_id,
    ]);
    const identityDisplay = profileKey(profile);
    if (profileKeys.has(identityTuple)) {
      issues.push({
        code: 'custom_provider_profile_duplicate',
        phase: 'migration',
        path: `${basePath}/profile/identity`,
        message:
          'Each custom provider must declare a unique provider/profile identity.',
        profile_key: identityDisplay,
      });
      continue;
    }
    const bindingKey = JSON.stringify([adapterId, candidate.binding_id]);
    if (bindingKeys.has(bindingKey)) {
      issues.push({
        code: 'custom_provider_binding_duplicate',
        phase: 'migration',
        path: `${basePath}/bindingId`,
        message:
          'Each custom provider must declare a unique adapter/binding identity.',
        profile_key: identityDisplay,
      });
      continue;
    }
    profileKeys.add(identityTuple);
    bindingKeys.add(bindingKey);
    profiles.push(candidate);
  }
  return { profiles, issues };
}

function canonicalizeProviderConfigs(
  providers: Readonly<Record<string, ProviderConfig>>,
): {
  providerConfigs: Record<string, ProviderConfig>;
  notices: PreparationNotice[];
} {
  const providerConfigs = safeRecord<ProviderConfig>();
  const notices: PreparationNotice[] = [];
  const openAiCandidates = [
    'openai-deep',
    'openai-deep-o3',
    'openai-research',
  ].filter((id) => ownValue(providers, id) !== undefined);
  const selectedOpenAi = openAiCandidates.includes('openai-research')
    ? 'openai-research'
    : openAiCandidates.includes('openai-deep-o3')
      ? 'openai-deep-o3'
      : openAiCandidates.includes('openai-deep')
        ? 'openai-deep'
        : undefined;

  for (const [id, config] of Object.entries(providers)) {
    const adapterId = canonicalProviderId(id);
    const fallback = config.fallback
      ? canonicalProviderId(config.fallback)
      : undefined;
    if (adapterId !== id) {
      notices.push({
        code: 'configuration_provider_id_migrated',
        phase: 'migration',
        path: `/providers/${id}`,
        message:
          'A retired provider id was migrated to its canonical adapter id.',
      });
    }
    if (fallback !== config.fallback && config.fallback !== undefined) {
      notices.push({
        code: 'configuration_fallback_id_migrated',
        phase: 'migration',
        path: `/providers/${id}/fallback`,
        message:
          'A retired fallback id was migrated to its canonical adapter id.',
      });
    }
    const normalized = {
      ...config,
      ...(fallback !== undefined && { fallback }),
    };
    if (adapterId === 'openai-research' && id !== selectedOpenAi) {
      notices.push({
        code: 'configuration_provider_alias_collision',
        phase: 'migration',
        path: `/providers/${id}`,
        message:
          'A colliding OpenAI research alias was ignored by canonical precedence.',
      });
      continue;
    }
    if (!ownValue(providerConfigs, adapterId) || id === adapterId) {
      providerConfigs[adapterId] = normalized;
      continue;
    }
    notices.push({
      code: 'configuration_provider_alias_collision',
      phase: 'migration',
      path: `/providers/${id}`,
      message:
        'A colliding provider alias was ignored because its canonical adapter is configured.',
    });
  }
  return { providerConfigs: publicRecord(providerConfigs), notices };
}

function materializeProviderConfigs(config: Config): {
  providerConfigs: Record<string, ProviderConfig>;
  notices: PreparationNotice[];
} {
  const byAdapter = safeRecord<ProviderConfig>();
  const bindings = adapterProfileBindings();
  const normalized = canonicalizeProviderConfigs(config.providers);

  for (const [adapterId, providerConfig] of Object.entries(
    normalized.providerConfigs,
  )) {
    const binding = bindings.get(adapterId);
    const options = { ...(providerConfig.options ?? {}) };
    // v1 applies this global only to LLM/chat providers, and only when the
    // provider did not make an explicit per-provider choice.
    if (binding?.profile_id === 'chat' && options.webSearch === undefined) {
      options.webSearch = config.defaults.llmWebSearch;
    }
    byAdapter[adapterId] = {
      ...providerConfig,
      ...(Object.keys(options).length > 0 && { options }),
    };
  }

  return {
    providerConfigs: publicRecord(byAdapter),
    notices: normalized.notices,
  };
}

function authoredGroups(
  provenance: AuthoredGroupProvenance,
): Record<string, readonly string[]> {
  // Project authoring intentionally wins without reordering either layer.
  return Object.fromEntries([
    ...Object.entries(provenance.global),
    ...Object.entries(provenance.project),
  ]);
}

function canonicalizeGroups(
  groups: Readonly<Record<string, readonly string[]>>,
  customProfiles: readonly CustomCatalogProfile[] = [],
): {
  groups: Record<string, string[]>;
  notices: PreparationNotice[];
  issues: PreparationIssue[];
} {
  const mapped = safeRecord<string[]>();
  const notices: PreparationNotice[] = [];
  const issues: PreparationIssue[] = [];
  for (const [name, members] of Object.entries(groups)) {
    const exact: string[] = [];
    const seen = new Set<string>();
    for (const [index, member] of members.entries()) {
      const path = `/groups/${name}/${index}`;
      const resolution = resolveConfigurationProfileToken(
        member,
        customProfiles,
      );
      if (resolution.kind === 'unknown') {
        issues.push({
          code: 'configuration_group_member_unknown',
          phase: 'migration',
          path,
          message:
            'The group member does not resolve to an implemented exact provider profile.',
        });
        continue;
      }
      if (resolution.kind === 'ambiguous') {
        issues.push({
          code: 'configuration_group_member_ambiguous',
          phase: 'migration',
          path,
          message:
            'The group member resolves to multiple profiles. Use a qualified "provider/profile" reference.',
        });
        continue;
      }
      if (resolution.alias) {
        notices.push({
          code: 'configuration_provider_alias_migrated',
          phase: 'migration',
          path,
          message:
            'A retired provider alias was migrated to its exact profile.',
          profile_key: `${resolution.target.provider_id}/${resolution.target.profile_id}`,
        });
      }
      const key = `${resolution.target.provider_id}/${resolution.target.profile_id}`;
      if (!seen.has(key)) {
        seen.add(key);
        exact.push(key);
      }
    }
    mapped[name] = exact;
  }
  return { groups: publicRecord(mapped), notices, issues };
}

function groupAliases(
  groups: Readonly<Record<string, readonly string[]>>,
  catalog: ProviderCatalog,
): Record<string, string> {
  const customGroups = new Set(catalog.custom_group_ids);
  const aliases = safeRecord<string>();
  for (const name of Object.keys(groups)) {
    if (name.startsWith('custom:')) continue;
    const target = customWorkflowId(name);
    if (customGroups.has(target) && ownValue(groups, target) === undefined) {
      aliases[name] = target;
    }
  }
  return publicRecord(aliases);
}

function fallbackReserve(
  providerConfigs: Readonly<Record<string, ProviderConfig>>,
  customProfiles: readonly CustomCatalogProfile[] = [],
): {
  reserve: CatalogProfileTarget[];
  reserveOnlyAdapterIds: string[];
  notices: PreparationNotice[];
  issues: PreparationIssue[];
} {
  const reserve: CatalogProfileTarget[] = [];
  const reserveOnlyAdapterIds: string[] = [];
  const issues: PreparationIssue[] = [];
  const notices: PreparationNotice[] = [];
  const seen = new Set<string>();
  const reserveOnly = new Set<string>();
  const accepted: Array<{
    readonly adapterId: string;
    readonly fallback: string;
    readonly target: AdapterProfileBinding;
    readonly path: string;
  }> = [];

  for (const [adapterId, providerConfig] of Object.entries(providerConfigs)) {
    const fallback = (providerConfig as { fallback?: unknown }).fallback;
    if (fallback === undefined) continue;
    const path = `/providers/${adapterId}/fallback`;
    if (providerConfig.enabled !== true) {
      notices.push({
        code: 'configuration_fallback_disabled_source_omitted',
        phase: 'migration',
        path,
        message: 'A fallback from a disabled source adapter was omitted.',
      });
      continue;
    }
    if (typeof fallback !== 'string' || fallback.trim().length === 0) {
      issues.push({
        code: 'configuration_fallback_malformed',
        phase: 'migration',
        path,
        message:
          'A configured fallback must be a non-empty adapter id. Remove it or name an implemented adapter.',
      });
      continue;
    }

    const source =
      adapterProfileBinding(adapterId) ??
      customProfiles
        .filter((profile) => profile.adapter_id === adapterId)
        .map(customProfileBinding)[0];
    if (!source) {
      issues.push({
        code: 'configuration_fallback_unbound_source',
        phase: 'migration',
        path,
        message:
          'The configured source adapter has no exact executable profile binding, so its fallback cannot be migrated.',
      });
      continue;
    }
    const target =
      adapterProfileBinding(fallback) ??
      customProfiles
        .filter((profile) => profile.adapter_id === fallback)
        .map(customProfileBinding)[0];
    if (!target) {
      issues.push({
        code: ownValue(providerConfigs, fallback)
          ? 'configuration_fallback_unbound_target'
          : 'configuration_fallback_unknown_adapter',
        phase: 'migration',
        path,
        message: ownValue(providerConfigs, fallback)
          ? 'The fallback adapter has no exact executable profile binding.'
          : 'The fallback adapter is not a known implemented adapter.',
      });
      continue;
    }
    if (!ownValue(providerConfigs, fallback)) {
      issues.push({
        code: 'configuration_fallback_target_unconfigured',
        phase: 'migration',
        path,
        message:
          'The fallback adapter is implemented but is not explicitly configured.',
      });
      continue;
    }
    if (sameProfile(source, target)) {
      issues.push({
        code: 'configuration_fallback_self_reference',
        phase: 'migration',
        path,
        message:
          'The fallback resolves to the same exact profile as its configured source.',
        profile_key: profileKey(target),
      });
      continue;
    }

    accepted.push({ adapterId, fallback, target, path });
  }

  const acceptedSources = new Set(accepted.map((edge) => edge.adapterId));
  for (const edge of accepted) {
    if (acceptedSources.has(edge.fallback)) {
      notices.push({
        code: 'configuration_fallback_chain_flattened',
        phase: 'migration',
        path: edge.path,
        message:
          'A fallback chain was flattened into the ordered global fallback reserve.',
      });
    }

    const key = profileKey(edge.target);
    if (!seen.has(key)) {
      seen.add(key);
      reserve.push({
        provider_id: edge.target.provider_id,
        profile_id: edge.target.profile_id,
      });
    }
    if (
      ownValue(providerConfigs, edge.fallback)?.enabled === false &&
      !reserveOnly.has(edge.fallback)
    ) {
      reserveOnly.add(edge.fallback);
      reserveOnlyAdapterIds.push(edge.fallback);
    }
  }

  return { reserve, reserveOnlyAdapterIds, notices, issues };
}

/**
 * v1 keeps retired aliases until #2439, but model selection itself follows the
 * same exact binding policy as native v2 before any factory can run.
 */
function modelSelectionIssues(
  providerConfigs: Readonly<Record<string, ProviderConfig>>,
  catalog: readonly ProviderCatalogEntry[],
): PreparationIssue[] {
  const declarations = new Map(
    catalog.flatMap((entry) =>
      entry.profiles.map(
        (profile) =>
          [`${entry.provider_id}/${profile.profile_id}`, profile] as const,
      ),
    ),
  );
  const bindings = buildProfileBindings(declarations);
  const adapterBindings = adapterProfileBindings();
  const issues: PreparationIssue[] = [];

  for (const [adapterId, provider] of Object.entries(providerConfigs)) {
    const identity = adapterBindings.get(adapterId);
    if (!identity) continue;
    const binding = bindings.get(
      `${identity.provider_id}/${identity.profile_id}`,
    );
    try {
      binding?.validateModel(provider.model);
    } catch (error) {
      const diagnostic =
        error instanceof TargetSelectionError
          ? error
          : new TargetSelectionError(
              'config_model_invalid',
              error instanceof Error ? error.message : 'Invalid model.',
            );
      issues.push({
        code: diagnostic.code,
        phase: 'migration',
        path: `/providers/${escapePointerSegment(adapterId)}/model`,
        message: diagnostic.message,
      });
    }
  }
  return issues;
}

function sameProfile(
  left: Pick<AdapterProfileBinding, 'provider_id' | 'profile_id'>,
  right: Pick<AdapterProfileBinding, 'provider_id' | 'profile_id'>,
): boolean {
  return (
    left.provider_id === right.provider_id &&
    left.profile_id === right.profile_id
  );
}

function profileKey(binding: AdapterProfileBinding): string {
  return `${binding.provider_id}/${binding.profile_id}`;
}

function timingIntegerIssue(path: string, label: string): PreparationIssue {
  return {
    code: 'configuration_deadline_invalid_integer',
    phase: 'migration',
    path,
    message: `${label} must be a positive safe integer.`,
  };
}

function millisecondsFromV1Seconds(
  value: number,
  path: string,
  label: string,
  issues: PreparationIssue[],
): number | undefined {
  if (!Number.isSafeInteger(value) || value < 1) {
    issues.push(timingIntegerIssue(path, label));
    return undefined;
  }
  const exact = BigInt(value) * 1_000n;
  if (exact > BigInt(Number.MAX_SAFE_INTEGER)) {
    issues.push({
      code: 'configuration_deadline_arithmetic_overflow',
      phase: 'migration',
      path,
      message: `${label} cannot be represented exactly in milliseconds.`,
    });
    return undefined;
  }
  if (exact > BigInt(RESEARCH_REQUEST_LIMITS.maxDeadlineMs)) {
    issues.push({
      code: 'configuration_deadline_contract_maximum_exceeded',
      phase: 'migration',
      path,
      message: `${label} exceeds the ${RESEARCH_REQUEST_LIMITS.maxDeadlineMs}ms contract maximum.`,
    });
    return undefined;
  }
  return Number(exact);
}

function pollIntervalMillisecondsFromV1Seconds(
  value: number,
  issues: PreparationIssue[],
): number | undefined {
  const path = '/defaults/asyncPollInterval';
  if (!Number.isSafeInteger(value) || value < 1) {
    issues.push({
      code: 'configuration_poll_interval_invalid_integer',
      phase: 'migration',
      path,
      message:
        'Background poll interval must be a positive safe integer in seconds.',
    });
    return undefined;
  }
  const exact = BigInt(value) * 1_000n;
  if (exact > BigInt(Number.MAX_SAFE_INTEGER)) {
    issues.push({
      code: 'configuration_poll_interval_arithmetic_overflow',
      phase: 'migration',
      path,
      message:
        'Background poll interval cannot be represented exactly in milliseconds.',
    });
    return undefined;
  }
  if (
    exact < BigInt(RESEARCH_REQUEST_LIMITS.minPollIntervalMs) ||
    exact > BigInt(RESEARCH_REQUEST_LIMITS.maxPollIntervalMs)
  ) {
    issues.push({
      code: 'configuration_poll_interval_out_of_bounds',
      phase: 'migration',
      path,
      message: `Background poll interval must resolve within ${RESEARCH_REQUEST_LIMITS.minPollIntervalMs} through ${RESEARCH_REQUEST_LIMITS.maxPollIntervalMs} milliseconds.`,
    });
    return undefined;
  }
  return Number(exact);
}

function deadlineMigrationContext(
  config: Config,
  requestDeadlineMs: number | undefined,
  issues: PreparationIssue[],
): V1RequestDeadlineMigrationContext | undefined {
  const issueCount = issues.length;
  const maxParallel = config.defaults.maxParallel;
  if (
    !Number.isSafeInteger(maxParallel) ||
    maxParallel < RESEARCH_REQUEST_LIMITS.minConcurrency ||
    maxParallel > RESEARCH_REQUEST_LIMITS.maxConcurrency
  ) {
    issues.push({
      code: 'configuration_deadline_concurrency_out_of_bounds',
      phase: 'migration',
      path: '/defaults/maxParallel',
      message: `Deadline derivation concurrency must be an integer from ${RESEARCH_REQUEST_LIMITS.minConcurrency} through ${RESEARCH_REQUEST_LIMITS.maxConcurrency}.`,
    });
  }
  const inlineAttemptDeadlineMs = millisecondsFromV1Seconds(
    config.defaults.timeout,
    '/defaults/timeout',
    'Inline attempt timeout',
    issues,
  );
  const backgroundAttemptDeadlineMs = millisecondsFromV1Seconds(
    config.defaults.asyncTimeout,
    '/defaults/asyncTimeout',
    'Background attempt timeout',
    issues,
  );
  const pollIntervalMs = pollIntervalMillisecondsFromV1Seconds(
    config.defaults.asyncPollInterval,
    issues,
  );
  if (
    pollIntervalMs !== undefined &&
    backgroundAttemptDeadlineMs !== undefined &&
    pollIntervalMs > backgroundAttemptDeadlineMs
  ) {
    issues.push({
      code: 'configuration_poll_interval_exceeds_background_attempt',
      phase: 'migration',
      path: '/defaults/asyncPollInterval',
      message:
        'Background poll interval cannot exceed the background attempt timeout.',
    });
  }
  if (
    requestDeadlineMs !== undefined &&
    (!Number.isSafeInteger(requestDeadlineMs) ||
      requestDeadlineMs < RESEARCH_REQUEST_LIMITS.minDeadlineMs)
  ) {
    issues.push(
      timingIntegerIssue(
        '/defaults/requestDeadlineMs',
        `Explicit request deadline in milliseconds (minimum ${RESEARCH_REQUEST_LIMITS.minDeadlineMs})`,
      ),
    );
  } else if (
    requestDeadlineMs !== undefined &&
    requestDeadlineMs > RESEARCH_REQUEST_LIMITS.maxDeadlineMs
  ) {
    issues.push({
      code: 'configuration_deadline_contract_maximum_exceeded',
      phase: 'migration',
      path: '/defaults/requestDeadlineMs',
      message: `Explicit request deadline exceeds the ${RESEARCH_REQUEST_LIMITS.maxDeadlineMs}ms contract maximum.`,
    });
  }
  if (
    requestDeadlineMs !== undefined &&
    inlineAttemptDeadlineMs !== undefined &&
    backgroundAttemptDeadlineMs !== undefined &&
    (requestDeadlineMs < inlineAttemptDeadlineMs ||
      requestDeadlineMs < backgroundAttemptDeadlineMs)
  ) {
    issues.push({
      code: 'configuration_request_deadline_less_than_attempt_deadline',
      phase: 'migration',
      path: '/defaults/requestDeadlineMs',
      message:
        'The explicit request deadline cannot be shorter than either v1 attempt timeout.',
    });
  }

  if (
    issues.length !== issueCount ||
    inlineAttemptDeadlineMs === undefined ||
    backgroundAttemptDeadlineMs === undefined ||
    pollIntervalMs === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: 'v1_request_deadline_migration',
    max_parallel: maxParallel,
    inline_attempt_deadline_ms: inlineAttemptDeadlineMs,
    raw_background_attempt_deadline_ms: backgroundAttemptDeadlineMs,
    poll_interval_ms: pollIntervalMs,
    legacy_mode: config.defaults.mode,
    ...(requestDeadlineMs !== undefined && {
      explicit_request_deadline_ms: requestDeadlineMs,
    }),
  });
}

function canonicalDefaults(
  config: Config,
  deadlineMigration: V1RequestDeadlineMigrationContext | undefined,
  budgets: ReturnType<typeof exactUsdBudgets>['budgets'],
): CanonicalTransportDefaults | undefined {
  if (deadlineMigration?.explicit_request_deadline_ms === undefined) {
    return undefined;
  }
  return {
    mode: config.defaults.mode,
    limits: {
      max_concurrency: deadlineMigration.max_parallel,
      request_deadline_ms: deadlineMigration.explicit_request_deadline_ms,
      inline_attempt_deadline_ms: deadlineMigration.inline_attempt_deadline_ms,
      // Native explicit defaults retain the raw v1 timeout; the migrated
      // shadow path expands it with selected-provider transport overhead.
      background_attempt_deadline_ms:
        deadlineMigration.raw_background_attempt_deadline_ms,
      poll_interval_ms: deadlineMigration.poll_interval_ms,
    },
    fallback: { kind: 'configured' },
    refinement: { kind: 'disabled' },
    ...(budgets && { budgets }),
  };
}

/**
 * Map an already validated v1 Config into catalog policy and injected canonical
 * transport defaults. Diagnostics contain no credentials and are stable by
 * path/code ordering.
 */
export function mapConfiguration(
  config: Config,
  options: ConfigurationMappingOptions,
): ConfigurationMappingResult {
  const providerConfigMapping = materializeProviderConfigs(config);
  const providerConfigs = providerConfigMapping.providerConfigs;
  const customCandidates = customCatalogProfileCandidates(config);
  // Disabled custom providers are admitted only when a validated configured
  // fallback edge needs them as reserve-only targets. This preliminary pass
  // determines that eligibility; final diagnostics and reserve facts are
  // recomputed after semantic validation below.
  const preliminaryFallback = fallbackReserve(
    providerConfigs,
    customCandidates,
  );
  const reserveOnly = new Set(preliminaryFallback.reserveOnlyAdapterIds);
  const eligibleCustomCandidates = customCandidates.filter(
    (candidate) =>
      providerConfigs[candidate.adapter_id]?.enabled === true ||
      reserveOnly.has(candidate.adapter_id),
  );
  const custom = validateCustomCatalogProfiles(
    eligibleCustomCandidates,
    options.catalog ?? BUILTIN_PROVIDER_CATALOG,
  );
  const customProfiles = ownCustomProfiles(custom.profiles);
  const authored = authoredGroups(options.authoredGroups);
  const canonicalGroups = canonicalizeGroups(authored, customProfiles);
  const groups = canonicalGroups.groups;
  const fallback = fallbackReserve(providerConfigs, customProfiles);
  const issues = [
    ...custom.issues,
    ...canonicalGroups.issues,
    ...fallback.issues,
    ...modelSelectionIssues(
      providerConfigs,
      options.catalog ?? BUILTIN_PROVIDER_CATALOG,
    ),
  ];
  const deadlineMigration = deadlineMigrationContext(
    config,
    options.requestDeadlineMs,
    issues,
  );
  const budgetResult = exactUsdBudgets(
    config.defaults.maxCostUsd,
    config.defaults.maxEstimatedCostUsd,
    '/defaults',
  );
  issues.push(...budgetResult.issues);
  const unresolvedTransportDefaults =
    deadlineMigration && budgetResult.issues.length === 0
      ? deepFreeze({
          mode: config.defaults.mode,
          limits: {
            max_concurrency: deadlineMigration.max_parallel,
            inline_attempt_deadline_ms:
              deadlineMigration.inline_attempt_deadline_ms,
            poll_interval_ms: deadlineMigration.poll_interval_ms,
          },
          fallback: { kind: 'configured' as const },
          refinement: { kind: 'disabled' as const },
          ...(budgetResult.budgets && { budgets: budgetResult.budgets }),
        })
      : undefined;
  const transportDefaults =
    budgetResult.issues.length === 0
      ? canonicalDefaults(config, deadlineMigration, budgetResult.budgets)
      : undefined;
  const catalog = buildProviderCatalog({
    ...(options.catalog && { catalog: options.catalog }),
    providerConfigs,
    ...(options.credentials && { credentials: options.credentials }),
    groups,
    // Defaults intentionally stay catalog-owned. config.providers never
    // derives a v2 default roster.
    reserve: fallback.reserve,
    reserveOnlyAdapterIds: fallback.reserveOnlyAdapterIds,
    customProfiles,
  });
  const notices = [
    ...canonicalGroups.notices,
    ...providerConfigMapping.notices,
    ...fallback.notices,
    ...catalog.notices,
  ].sort(comparePreparationDiagnostics);
  const allIssues = [...issues, ...catalog.issues].sort(
    comparePreparationDiagnostics,
  );
  const aliases = groupAliases(groups, catalog);

  return {
    catalog,
    ...(transportDefaults && { transport_defaults: transportDefaults }),
    ...(deadlineMigration && { deadline_migration: deadlineMigration }),
    ...(unresolvedTransportDefaults && {
      unresolved_transport_defaults: unresolvedTransportDefaults,
    }),
    transport_input: {
      defaults: {
        mode: config.defaults.mode,
        maxParallel: config.defaults.maxParallel,
        timeout: config.defaults.timeout,
        asyncTimeout: config.defaults.asyncTimeout,
        asyncPollInterval: config.defaults.asyncPollInterval,
        maxCostUsd: config.defaults.maxCostUsd,
        maxEstimatedCostUsd: config.defaults.maxEstimatedCostUsd,
      },
    },
    groups,
    group_aliases: aliases,
    reserve: fallback.reserve,
    reserve_only_adapter_ids: fallback.reserveOnlyAdapterIds,
    custom_profile_bindings: customProfiles,
    preflight: { notices, issues: allIssues },
  };
}
