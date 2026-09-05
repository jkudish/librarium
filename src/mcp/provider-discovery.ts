import { catalogFingerprint } from '../core/catalog-fingerprint.js';
import {
  type ConfigurationMappingResult,
  mapConfiguration,
} from '../core/configuration-mapping.js';
import {
  type CredentialContext,
  describeCredentialReference,
} from '../core/credentials.js';
import {
  type AdapterProfileBinding,
  executionAdapterProfileBindings,
} from '../core/profile-bindings.js';
import type { ResolvedCatalogProfile } from '../core/profile-catalog.js';
import { BUILTIN_PROVIDER_DEFINITIONS_IN_REGISTRATION_ORDER } from '../core/provider-descriptor.js';
import { catalogProfileKey } from '../core/provider-profiles.js';
import { INTERNAL_ADAPTER_PUBLIC_PROVIDER_IDS } from '../internal-adapter-ids.js';
import type { Config, ProviderTier } from '../types.js';

type CredentialPresence = 'present' | 'missing' | 'not-required' | 'unknown';
type CredentialSource =
  | 'env'
  | 'keychain'
  | 'literal'
  | 'missing'
  | 'none'
  | 'unknown';

interface DiscoveryCredentialStatus {
  readonly requirement: 'required' | 'not-required' | 'unknown';
  readonly presence: CredentialPresence;
  readonly source: CredentialSource;
  readonly authentication: 'not-checked';
}

interface ProviderSummary {
  readonly id: string;
  readonly name: string;
  readonly tier: ProviderTier | 'unknown';
  readonly source: 'builtin' | 'npm' | 'script';
  readonly enabled: boolean;
  readonly keyConfigured: boolean;
  readonly credentialSource: CredentialSource;
  readonly credentialStatus: DiscoveryCredentialStatus;
  readonly configured: boolean;
  readonly target?: ResolvedCatalogProfile['profile']['identity']['target'];
  readonly planningStatus: 'available' | 'unavailable' | 'unplannable';
  readonly reasons: readonly string[];
}

export interface ProviderDiscoveryInput {
  readonly provider?: string;
  readonly detail?: 'profiles';
}

export class ProviderDiscoveryError extends Error {}

function configuredAdapterId(adapterId: string): string {
  return (
    INTERNAL_ADAPTER_PUBLIC_PROVIDER_IDS[
      adapterId as keyof typeof INTERNAL_ADAPTER_PUBLIC_PROVIDER_IDS
    ] ?? adapterId
  );
}

function credentialStatus(
  requirement: 'required' | 'not-required' | 'unknown',
  reference: string | undefined,
  credentials: CredentialContext,
): DiscoveryCredentialStatus {
  if (requirement === 'unknown') {
    return {
      requirement,
      presence: 'unknown',
      source: 'unknown',
      authentication: 'not-checked',
    };
  }
  if (requirement === 'not-required') {
    return {
      requirement,
      presence: 'not-required',
      source: 'none',
      authentication: 'not-checked',
    };
  }

  const description = describeCredentialReference(reference);
  if (description.source === 'keychain') {
    return {
      requirement,
      presence: 'unknown',
      source: 'keychain',
      authentication: 'not-checked',
    };
  }
  if (description.source === 'env') {
    const value = description.name
      ? credentials.env?.[description.name]
      : undefined;
    return {
      requirement,
      presence: value ? 'present' : 'missing',
      source: 'env',
      authentication: 'not-checked',
    };
  }
  if (description.source === 'literal') {
    return {
      requirement,
      presence: 'present',
      source: 'literal',
      authentication: 'not-checked',
    };
  }
  return {
    requirement,
    presence: 'missing',
    source: 'unknown',
    authentication: 'not-checked',
  };
}

function tierForResult(resultKind: string): ProviderTier {
  switch (resultKind) {
    case 'search_results':
      return 'raw-search';
    case 'research_report':
      return 'deep-research';
    case 'model_answer':
      return 'llm';
    default:
      return 'ai-grounded';
  }
}

function compatibilityCredentialSource(
  credential: DiscoveryCredentialStatus,
): CredentialSource {
  return credential.presence === 'missing' ? 'missing' : credential.source;
}

function customIssueReasons(
  adapterId: string,
  mapped: ConfigurationMappingResult,
): string[] {
  const pointer = adapterId.replaceAll('~', '~0').replaceAll('/', '~1');
  return [
    ...new Set(
      mapped.preflight.issues
        .filter((issue) => issue.path.startsWith(`/customProviders/${pointer}`))
        .map((issue) => issue.code),
    ),
  ].sort();
}

function normalizeAvailability(
  profile: ResolvedCatalogProfile,
  credential: DiscoveryCredentialStatus,
) {
  let sawCredentialReason = false;
  const reasons = profile.availability.reasons.flatMap((reason) => {
    if (reason !== 'credential_missing') return [reason];
    sawCredentialReason = true;
    if (credential.presence === 'missing') return [reason];
    if (credential.presence === 'unknown') return ['credential_status_unknown'];
    return [];
  });
  if (
    profile.binding !== undefined &&
    !sawCredentialReason &&
    credential.presence === 'missing'
  ) {
    reasons.push('credential_missing');
  }
  if (
    profile.binding !== undefined &&
    !sawCredentialReason &&
    credential.presence === 'unknown'
  ) {
    reasons.push('credential_status_unknown');
  }
  return {
    enabled: profile.availability.enabled,
    reserve_only: profile.availability.reserve_only,
    configuration_valid: profile.availability.configuration_valid,
    selectable:
      profile.availability.enabled &&
      profile.availability.configuration_valid &&
      profile.binding !== undefined &&
      (credential.presence === 'present' ||
        credential.presence === 'not-required'),
    reasons,
  };
}

function bindingMatches(
  binding: AdapterProfileBinding,
  profile: ResolvedCatalogProfile,
): boolean {
  return (
    binding.provider_id === profile.profile.identity.provider_id &&
    binding.profile_id === profile.profile.identity.profile_id
  );
}

/** Static discovery only: no adapter construction, custom loading, or I/O. */
export function discoverProviders(
  config: Config,
  input: ProviderDiscoveryInput = {},
  credentials: CredentialContext = { env: process.env },
) {
  const mapped = mapConfiguration(config, {
    authoredGroups: { global: config.groups, project: {} },
    credentials: { env: credentials.env },
    includeDisabledCustomProfiles: true,
  });
  const bindings = executionAdapterProfileBindings();
  const resolvedByKey = new Map(
    mapped.catalog.resolved.map((profile) => [
      catalogProfileKey(
        profile.profile.identity.provider_id,
        profile.profile.identity.profile_id,
      ),
      profile,
    ]),
  );
  const customByKey = new Map(
    mapped.custom_profile_bindings.map((custom) => [
      catalogProfileKey(
        custom.profile.identity.provider_id,
        custom.profile.identity.profile_id,
      ),
      custom,
    ]),
  );
  const profileAdapterIds = new Map<string, string>();
  for (const [adapterId, binding] of bindings) {
    profileAdapterIds.set(
      catalogProfileKey(binding.provider_id, binding.profile_id),
      adapterId,
    );
  }
  for (const custom of mapped.custom_profile_bindings) {
    profileAdapterIds.set(
      catalogProfileKey(
        custom.profile.identity.provider_id,
        custom.profile.identity.profile_id,
      ),
      custom.adapter_id,
    );
  }

  const summaries: ProviderSummary[] = [];
  for (const definition of BUILTIN_PROVIDER_DEFINITIONS_IN_REGISTRATION_ORDER) {
    if (definition.internal === true) continue;
    const providerConfig = config.providers[definition.id];
    const binding = bindings.get(definition.id);
    const resolved = binding
      ? mapped.catalog.resolved.find((profile) =>
          bindingMatches(binding, profile),
        )
      : undefined;
    const credential = credentialStatus(
      definition.credential.required ? 'required' : 'not-required',
      providerConfig?.apiKey ??
        (definition.credential.envVar
          ? `$${definition.credential.envVar}`
          : undefined),
      credentials,
    );
    const reasons = resolved
      ? normalizeAvailability(resolved, credential).reasons
      : ['profile_not_implemented'];
    summaries.push({
      id: definition.id,
      name: definition.display.name,
      tier: definition.tier,
      source: 'builtin',
      enabled: providerConfig?.enabled ?? false,
      keyConfigured:
        credential.presence === 'present' ||
        credential.presence === 'not-required',
      credentialSource: compatibilityCredentialSource(credential),
      credentialStatus: credential,
      configured: providerConfig !== undefined,
      ...(resolved && { target: resolved.profile.identity.target }),
      planningStatus:
        resolved && normalizeAvailability(resolved, credential).selectable
          ? 'available'
          : 'unavailable',
      reasons,
    });
  }

  const trusted = new Set(config.trustedProviderIds);
  for (const [adapterId, source] of Object.entries(config.customProviders).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  )) {
    const providerConfig = config.providers[adapterId];
    const custom = mapped.custom_profile_bindings.find(
      (candidate) => candidate.adapter_id === adapterId,
    );
    const key = custom
      ? catalogProfileKey(
          custom.profile.identity.provider_id,
          custom.profile.identity.profile_id,
        )
      : undefined;
    const resolved = key ? resolvedByKey.get(key) : undefined;
    const credential = custom
      ? credentialStatus(
          custom.credential_env_var ? 'required' : 'not-required',
          providerConfig?.apiKey ??
            (custom.credential_env_var
              ? `$${custom.credential_env_var}`
              : undefined),
          credentials,
        )
      : credentialStatus('unknown', undefined, credentials);
    const reasons = custom
      ? normalizeAvailability(resolved!, credential).reasons
      : [
          ...(!trusted.has(adapterId) ? ['custom_provider_untrusted'] : []),
          ...(source.executionProfile === undefined
            ? ['custom_profile_declaration_missing']
            : []),
          ...customIssueReasons(adapterId, mapped),
        ];
    summaries.push({
      id: adapterId,
      name: adapterId,
      tier: custom ? tierForResult(custom.profile.result_kind) : 'unknown',
      source: source.type,
      enabled: providerConfig?.enabled ?? false,
      keyConfigured:
        credential.presence === 'present' ||
        credential.presence === 'not-required',
      credentialSource: compatibilityCredentialSource(credential),
      credentialStatus: credential,
      configured: providerConfig !== undefined,
      ...(resolved && { target: resolved.profile.identity.target }),
      planningStatus: custom
        ? normalizeAvailability(resolved!, credential).selectable
          ? 'available'
          : 'unavailable'
        : 'unplannable',
      reasons: [...new Set(reasons)].sort(),
    });
  }

  const profiles = mapped.catalog.resolved.map((resolved) => {
    const identity = resolved.profile.identity;
    const key = catalogProfileKey(identity.provider_id, identity.profile_id);
    const adapterId = profileAdapterIds.get(key);
    const configId = adapterId ? configuredAdapterId(adapterId) : undefined;
    const providerConfig = configId ? config.providers[configId] : undefined;
    const builtin = mapped.catalog.entries.find(
      (entry) => entry.provider_id === identity.provider_id,
    );
    const custom = customByKey.get(key);
    const credential = credentialStatus(
      builtin?.credential.required || custom?.credential_env_var
        ? 'required'
        : 'not-required',
      providerConfig?.apiKey ??
        (builtin?.credential.env_var
          ? `$${builtin.credential.env_var}`
          : custom?.credential_env_var
            ? `$${custom.credential_env_var}`
            : undefined),
      credentials,
    );
    return {
      provider_id: identity.provider_id,
      profile_id: identity.profile_id,
      selector: key,
      target: identity.target,
      status: resolved.declaration.status,
      source: builtin ? 'builtin_catalog' : 'trusted_custom_declaration',
      capabilities: {
        result_kind: resolved.profile.result_kind,
        grounding_policy: resolved.profile.grounding_policy ?? 'not_applicable',
        observation_mode: resolved.profile.observation_mode,
        corpora: resolved.profile.corpora,
        retrieval_method: resolved.profile.retrieval_method,
        access_mode: resolved.profile.access_mode,
        web_search: resolved.declaration.features?.web_search ?? 'unknown',
        json_schema_output:
          resolved.declaration.features?.json_schema_output ?? 'unknown',
        remote_cancellation:
          resolved.declaration.features?.remote_cancellation ?? 'unknown',
      },
      invocation: resolved.profile.invocation,
      resumability: resolved.profile.resumability,
      workflows: resolved.declaration.workflows,
      provenance: {
        operator_id: resolved.profile.operator_id,
        ...(resolved.profile.collector_id && {
          collector_id: resolved.profile.collector_id,
        }),
        ...(resolved.profile.surface_id && {
          surface_id: resolved.profile.surface_id,
        }),
      },
      credentialStatus: credential,
      availability: normalizeAvailability(resolved, credential),
    };
  });

  const revision = catalogFingerprint({ summaries, profiles });
  const filter = input.provider?.trim();
  const matchesFilter = (summary: ProviderSummary): boolean => {
    if (!filter) return true;
    if (summary.id === filter) return true;
    const binding = bindings.get(summary.id);
    return binding?.provider_id === filter;
  };
  const profileMatchesFilter = (
    profile: (typeof profiles)[number],
  ): boolean => {
    if (!filter) return true;
    const adapterId = profileAdapterIds.get(profile.selector);
    return (
      profile.provider_id === filter ||
      adapterId === filter ||
      (adapterId !== undefined && configuredAdapterId(adapterId) === filter)
    );
  };
  const filteredSummaries = summaries.filter(matchesFilter);
  const filteredProfiles = profiles.filter(profileMatchesFilter);
  if (
    filter &&
    filteredSummaries.length === 0 &&
    filteredProfiles.length === 0
  ) {
    throw new ProviderDiscoveryError('Unknown provider filter.');
  }

  if (input.detail !== 'profiles') {
    return { providers: filteredSummaries };
  }
  return {
    schemaVersion: 1,
    catalogRevision: revision,
    providers: filteredSummaries,
    profiles: filteredProfiles,
  };
}
