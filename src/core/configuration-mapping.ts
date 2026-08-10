import {
  normalizeProviderName,
  type ProviderNameEntry,
  resolveProviderId,
  resolveProviderToken,
} from '../constants.js';
import type { Config, ProviderConfig } from '../types.js';
import { customWorkflowId } from './builtin-workflows.js';
import type { CredentialContext } from './credentials.js';
import {
  type AdapterProfileBinding,
  adapterProfileBinding,
  adapterProfileBindings,
} from './profile-bindings.js';
import {
  buildProviderCatalog,
  type CatalogProfileTarget,
  type ProviderCatalog,
} from './profile-catalog.js';
import { BUILTIN_PROVIDER_DEFINITIONS } from './provider-descriptor.js';
import type { ProviderCatalogEntry } from './provider-profiles.js';
import type {
  PreparationIssue,
  PreparationNotice,
} from './research-request.js';
import { comparePreparationDiagnostics } from './research-request.js';
import type {
  CanonicalTransportDefaults,
  ConfigurationTransportInput,
} from './transport-normalization.js';
import { exactUsdBudgets } from './transport-normalization.js';

/** Dependencies are injected so mapping stays pure and network-free. */
export interface ConfigurationMappingOptions {
  /**
   * The v1 total request deadline has no approved conversion formula yet.
   * Callers must supply the already-approved canonical deadline explicitly.
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
  /** Omitted until the caller supplies the explicitly approved request limit. */
  readonly transport_defaults?: CanonicalTransportDefaults;
  readonly transport_input: ConfigurationTransportInput;
  readonly groups: Readonly<Record<string, readonly string[]>>;
  /** v1 group spelling to the exact catalog group id. */
  readonly group_aliases: Readonly<Record<string, string>>;
  readonly reserve: readonly CatalogProfileTarget[];
  readonly reserve_only_adapter_ids: readonly string[];
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

/**
 * Purely resolve a legacy provider/display/qualified token to one exact
 * catalog identity. An unqualified provider with more than one profile is
 * deliberately ambiguous; callers must preserve the exact strategy.
 */
export function resolveConfigurationProfileToken(
  token: string,
): ConfigurationProfileTokenResolution {
  const trimmed = token.trim();
  const qualified = trimmed.split('/');
  if (qualified.length === 2 && qualified[0] && qualified[1]) {
    const target = {
      provider_id: qualified[0],
      profile_id: qualified[1],
    };
    const known = [...adapterProfileBindings().values()].some((binding) =>
      sameProfile(binding, target),
    );
    return known
      ? { kind: 'exact', token: trimmed, target }
      : { kind: 'unknown', token: trimmed, suggestions: [] };
  }
  if (qualified.length !== 1) {
    return { kind: 'unknown', token: trimmed, suggestions: [] };
  }

  const direct = adapterProfileBinding(trimmed);
  if (direct) return exactToken(trimmed, direct);

  const catalogMatches = [...adapterProfileBindings().values()]
    .filter((binding) => binding.provider_id === trimmed)
    .sort((left, right) => profileKey(left).localeCompare(profileKey(right)));
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
  const matches = [...adapterProfileBindings().values()]
    .filter((binding) => binding.provider_id === provider.id)
    .sort((left, right) => profileKey(left).localeCompare(profileKey(right)));
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
    `${left.provider_id}/${left.profile_id}`.localeCompare(
      `${right.provider_id}/${right.profile_id}`,
    ),
  );
}

function exactToken(
  token: string,
  binding: AdapterProfileBinding,
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

function canonicalizeProviderConfigs(
  providers: Readonly<Record<string, ProviderConfig>>,
): {
  providerConfigs: Record<string, ProviderConfig>;
  notices: PreparationNotice[];
} {
  const providerConfigs: Record<string, ProviderConfig> = {};
  const notices: PreparationNotice[] = [];
  const openAiCandidates = [
    'openai-deep',
    'openai-deep-o3',
    'openai-research',
  ].filter((id) => providers[id] !== undefined);
  const selectedOpenAi = openAiCandidates.includes('openai-research')
    ? 'openai-research'
    : openAiCandidates.includes('openai-deep-o3')
      ? 'openai-deep-o3'
      : openAiCandidates.includes('openai-deep')
        ? 'openai-deep'
        : undefined;

  for (const [id, config] of Object.entries(providers)) {
    const adapterId = resolveProviderId(id);
    const fallback = config.fallback
      ? resolveProviderId(config.fallback)
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
    if (!providerConfigs[adapterId] || id === adapterId) {
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
  return { providerConfigs, notices };
}

function materializeProviderConfigs(config: Config): {
  providerConfigs: Record<string, ProviderConfig>;
  notices: PreparationNotice[];
} {
  const byAdapter: Record<string, ProviderConfig> = {};
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

  return { providerConfigs: byAdapter, notices: normalized.notices };
}

function authoredGroups(
  provenance: AuthoredGroupProvenance,
): Record<string, readonly string[]> {
  // Project authoring intentionally wins without reordering either layer.
  return { ...provenance.global, ...provenance.project };
}

function canonicalizeGroups(
  groups: Readonly<Record<string, readonly string[]>>,
): {
  groups: Record<string, string[]>;
  notices: PreparationNotice[];
  issues: PreparationIssue[];
} {
  const mapped: Record<string, string[]> = {};
  const notices: PreparationNotice[] = [];
  const issues: PreparationIssue[] = [];
  for (const [name, members] of Object.entries(groups)) {
    const exact: string[] = [];
    const seen = new Set<string>();
    for (const [index, member] of members.entries()) {
      const path = `/groups/${name}/${index}`;
      const resolution = resolveConfigurationProfileToken(member);
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
  return { groups: mapped, notices, issues };
}

function groupAliases(
  groups: Readonly<Record<string, readonly string[]>>,
  catalog: ProviderCatalog,
): Record<string, string> {
  const customGroups = new Set(catalog.custom_group_ids);
  const aliases: Record<string, string> = {};
  for (const name of Object.keys(groups)) {
    if (name.startsWith('custom:')) continue;
    const target = customWorkflowId(name);
    if (customGroups.has(target) && !groups[target]) {
      aliases[name] = target;
    }
  }
  return aliases;
}

function fallbackReserve(
  providerConfigs: Readonly<Record<string, ProviderConfig>>,
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

    const source = adapterProfileBinding(adapterId);
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
    const target = adapterProfileBinding(fallback);
    if (!target) {
      issues.push({
        code: providerConfigs[fallback]
          ? 'configuration_fallback_unbound_target'
          : 'configuration_fallback_unknown_adapter',
        phase: 'migration',
        path,
        message: providerConfigs[fallback]
          ? 'The fallback adapter has no exact executable profile binding.'
          : 'The fallback adapter is not a known implemented adapter.',
      });
      continue;
    }
    if (!providerConfigs[fallback]) {
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
      providerConfigs[edge.fallback]?.enabled === false &&
      !reserveOnly.has(edge.fallback)
    ) {
      reserveOnly.add(edge.fallback);
      reserveOnlyAdapterIds.push(edge.fallback);
    }
  }

  return { reserve, reserveOnlyAdapterIds, notices, issues };
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

function canonicalDefaults(
  config: Config,
  requestDeadlineMs: number | undefined,
  issues: PreparationIssue[],
): CanonicalTransportDefaults | undefined {
  if (requestDeadlineMs === undefined) {
    issues.push({
      code: 'configuration_request_deadline_required',
      phase: 'migration',
      path: '/defaults/requestDeadlineMs',
      message:
        'The v1 total request-deadline conversion is not approved. Supply requestDeadlineMs explicitly when mapping this configuration.',
    });
    return undefined;
  }
  const budgets = exactUsdBudgets(
    config.defaults.maxCostUsd,
    config.defaults.maxEstimatedCostUsd,
    '/defaults',
  );
  issues.push(...budgets.issues);
  if (budgets.issues.length > 0) return undefined;
  return {
    mode: config.defaults.mode,
    limits: {
      max_concurrency: config.defaults.maxParallel,
      request_deadline_ms: requestDeadlineMs,
      inline_attempt_deadline_ms: config.defaults.timeout * 1_000,
      background_attempt_deadline_ms: config.defaults.asyncTimeout * 1_000,
      poll_interval_ms: config.defaults.asyncPollInterval * 1_000,
    },
    fallback: { kind: 'configured' },
    refinement: { kind: 'disabled' },
    ...(budgets.budgets && { budgets: budgets.budgets }),
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
  const authored = authoredGroups(options.authoredGroups);
  const canonicalGroups = canonicalizeGroups(authored);
  const groups = canonicalGroups.groups;
  const fallback = fallbackReserve(providerConfigs);
  const issues = [...canonicalGroups.issues, ...fallback.issues];
  const transportDefaults = canonicalDefaults(
    config,
    options.requestDeadlineMs,
    issues,
  );
  const catalog = buildProviderCatalog({
    ...(options.catalog && { catalog: options.catalog }),
    providerConfigs,
    ...(options.credentials && { credentials: options.credentials }),
    groups,
    // Defaults intentionally stay catalog-owned. config.providers never
    // derives a v2 default roster.
    reserve: fallback.reserve,
    reserveOnlyAdapterIds: fallback.reserveOnlyAdapterIds,
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
    preflight: { notices, issues: allIssues },
  };
}
