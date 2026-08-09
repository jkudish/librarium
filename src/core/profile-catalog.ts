import type {
  ExecutionProfile,
  ProviderIdentity,
} from '../contracts/domain/index.js';
import type { ProviderConfig } from '../types.js';
import {
  BUILTIN_WORKFLOW_IDS,
  type BuiltinWorkflowId,
  CURATED_WORKFLOW_ROSTERS,
  customWorkflowId,
  isCustomWorkflowId,
  migrateUserWorkflowNames,
  RESERVED_WORKFLOW_IDS,
} from './builtin-workflows.js';
import { catalogFingerprint } from './catalog-fingerprint.js';
import { type CredentialContext, hasCredential } from './credentials.js';
import type {
  FrozenPlanningCatalog,
  NetworkFreeEstimate,
  PlanningProfile,
} from './execution-plan.js';
import {
  buildProfileBindings,
  type ProfileBinding,
} from './profile-bindings.js';
import {
  BUILTIN_PROVIDER_CATALOG,
  catalogProfileKey,
  catalogProfileRefs,
  declaredExecutionProfile,
  type ExecutableProfileDeclaration,
  type ProviderCatalogEntry,
} from './provider-profiles.js';
import type {
  PreparationIssue,
  PreparationNotice,
} from './research-request.js';

export class ProviderCatalogError extends Error {}

/** Why a declaration is not selectable. One reason per distinct cause. */
export type AvailabilityReason =
  | 'profile_not_implemented'
  | 'profile_disabled'
  | 'credential_missing'
  | 'configuration_invalid';

export interface ResolvedCatalogProfile {
  readonly declaration: ExecutableProfileDeclaration;
  readonly profile: ExecutionProfile;
  readonly binding?: ProfileBinding;
  readonly estimate?: NetworkFreeEstimate;
  readonly availability: {
    readonly enabled: boolean;
    readonly credential_valid: boolean;
    readonly configuration_valid: boolean;
    readonly selectable: boolean;
    readonly reasons: readonly string[];
  };
}

/** A `provider_id/profile_id` reference used by configured rosters. */
export interface CatalogProfileTarget {
  readonly provider_id: string;
  readonly profile_id: string;
}

export interface ProviderCatalogOptions {
  readonly catalog?: readonly ProviderCatalogEntry[];
  /** v1 provider configuration, keyed by adapter id. */
  readonly providerConfigs?: Readonly<Record<string, ProviderConfig>>;
  readonly credentials?: CredentialContext;
  /** User-defined groups; reserved names are migrated to `custom:<name>`. */
  readonly groups?: Readonly<Record<string, readonly string[]>>;
  /** Ordered configured-default identities for `selector: default`. */
  readonly defaults?: readonly CatalogProfileTarget[];
  /** The ordered global reserve for `fallback: configured`. */
  readonly reserve?: readonly CatalogProfileTarget[];
}

export interface WorkflowOmission {
  readonly profile_key: string;
  readonly reason: string;
}

export interface WorkflowResolutionResult {
  readonly workflow_id: BuiltinWorkflowId;
  readonly members: readonly ProviderIdentity[];
  readonly omitted: readonly WorkflowOmission[];
}

export interface ProviderCatalog extends FrozenPlanningCatalog {
  readonly entries: readonly ProviderCatalogEntry[];
  /** Every declaration, implemented and planned, in deterministic order. */
  readonly resolved: readonly ResolvedCatalogProfile[];
  readonly notices: readonly PreparationNotice[];
  /** Group-name collisions #2558's config migration must settle. */
  readonly issues: readonly PreparationIssue[];
  /** Selectable custom group ids, already namespaced as `custom:<name>`. */
  readonly custom_group_ids: readonly string[];
  get(
    providerId: string,
    profileId: string,
  ): ResolvedCatalogProfile | undefined;
  workflow(workflowId: BuiltinWorkflowId): WorkflowResolutionResult;
}

/**
 * Take catalog ownership of plain data.
 *
 * Caller-supplied entries, configs, and rosters are cloned rather than frozen
 * in place: the catalog must be immutable after construction without reaching
 * back into objects the caller still owns. Only JSON-shaped catalog facts pass
 * through here -- adapter bindings hold zod schemas and closures and are kept
 * by reference.
 */
function ownFrozen<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function profileKeyOf(profile: ResolvedCatalogProfile): string {
  return catalogProfileKey(
    profile.profile.identity.provider_id,
    profile.declaration.profile_id,
  );
}

function bindingConfig(
  options: ProviderCatalogOptions,
  adapterId: string,
): ProviderConfig | undefined {
  return options.providerConfigs?.[adapterId];
}

function resolveDeclaration(
  entry: ProviderCatalogEntry,
  declaration: ExecutableProfileDeclaration,
  binding: ProfileBinding | undefined,
  options: ProviderCatalogOptions,
): ResolvedCatalogProfile {
  const declared = declaredExecutionProfile(entry.provider_id, declaration);
  const reasons: string[] = [];

  if (declaration.status !== 'implemented' || !binding) {
    // Planned declarations stay discoverable so the catalog can describe the
    // roadmap truthfully, but they can never be selected for execution.
    reasons.push('profile_not_implemented');
    return Object.freeze({
      declaration: ownFrozen(declaration),
      profile: ownFrozen(declared),
      availability: ownFrozen({
        enabled: false,
        credential_valid: false,
        configuration_valid: true,
        selectable: false,
        reasons,
      }),
    });
  }

  const providerConfig = bindingConfig(options, binding.adapter_id);
  const enabled = providerConfig?.enabled === true;
  const credentialReference =
    providerConfig?.apiKey ??
    (entry.credential.env_var ? `$${entry.credential.env_var}` : undefined);
  const credentialValid = entry.credential.required
    ? hasCredential(credentialReference, options.credentials ?? {})
    : true;

  let profile = declared;
  let estimate: NetworkFreeEstimate | undefined;
  let configurationValid = true;
  try {
    const resolution = binding.resolve(providerConfig?.options ?? {});
    profile = resolution.profile;
    estimate = resolution.estimate;
  } catch {
    configurationValid = false;
  }

  if (!enabled) reasons.push('profile_disabled');
  if (!credentialValid) reasons.push('credential_missing');
  if (!configurationValid) reasons.push('configuration_invalid');

  return Object.freeze({
    declaration: ownFrozen(declaration),
    profile: ownFrozen(profile),
    binding,
    ...(estimate && { estimate: ownFrozen(estimate) }),
    availability: ownFrozen({
      enabled,
      credential_valid: credentialValid,
      configuration_valid: configurationValid,
      selectable: enabled && credentialValid && configurationValid,
      reasons,
    }),
  });
}

/**
 * Catalog construction is network-free, deterministic, and total: a missing,
 * duplicated, or orphaned binding fails here rather than at execution time.
 */
export function buildProviderCatalog(
  options: ProviderCatalogOptions = {},
): ProviderCatalog {
  const entries = options.catalog ?? BUILTIN_PROVIDER_CATALOG;
  const refs = catalogProfileRefs(entries);

  const declarationsByKey = new Map<string, ExecutableProfileDeclaration>();
  for (const { entry, declaration } of refs) {
    const key = catalogProfileKey(entry.provider_id, declaration.profile_id);
    if (declarationsByKey.has(key)) {
      throw new ProviderCatalogError(
        `Duplicate provider profile declaration: ${key}`,
      );
    }
    declarationsByKey.set(key, declaration);
  }

  const bindings = buildProfileBindings(declarationsByKey);
  for (const [key, declaration] of declarationsByKey) {
    if (declaration.status === 'implemented' && !bindings.has(key)) {
      throw new ProviderCatalogError(
        `Implemented profile declaration has no binding: ${key}`,
      );
    }
  }

  const resolved: ResolvedCatalogProfile[] = refs.map(
    ({ entry, declaration }) =>
      resolveDeclaration(
        entry,
        declaration,
        bindings.get(
          catalogProfileKey(entry.provider_id, declaration.profile_id),
        ),
        options,
      ),
  );
  const byKey = new Map(resolved.map((item) => [profileKeyOf(item), item]));

  const migration = migrateUserWorkflowNames(options.groups ?? {});
  const notices: PreparationNotice[] = [...migration.notices];
  const issues: PreparationIssue[] = [...migration.issues];

  const workflowMembers = (
    workflowId: BuiltinWorkflowId,
  ): WorkflowResolutionResult => {
    const ordered: ResolvedCatalogProfile[] =
      workflowId === 'quick' || workflowId === 'visibility'
        ? CURATED_WORKFLOW_ROSTERS[workflowId].flatMap((member) => {
            const found = byKey.get(
              catalogProfileKey(member.provider_id, member.profile_id),
            );
            if (!found) {
              throw new ProviderCatalogError(
                `Workflow "${workflowId}" references an unknown profile: ${catalogProfileKey(member.provider_id, member.profile_id)}`,
              );
            }
            return [found];
          })
        : workflowId === 'deep'
          ? resolved.filter(
              (item) => item.profile.result_kind === 'research_report',
            )
          : resolved;

    const members: ProviderIdentity[] = [];
    const omitted: WorkflowOmission[] = [];
    for (const item of ordered) {
      if (item.availability.selectable) {
        members.push(item.profile.identity);
        continue;
      }
      for (const reason of item.availability.reasons) {
        omitted.push({ profile_key: profileKeyOf(item), reason });
      }
    }
    return { workflow_id: workflowId, members, omitted };
  };

  // Every user-defined group is selected as `custom:<name>`. Raw storage names
  // stay raw -- mapping them is #2558's config migration, not selection
  // semantics. A reserved key only survives migration when it collided with an
  // existing `custom:<name>`; it stays bound to the built-in workflow and is
  // deliberately not reachable as a custom group.
  const customGroups = new Map<string, readonly string[]>();
  for (const [name, members] of Object.entries(migration.groups)) {
    if (RESERVED_WORKFLOW_IDS.has(name)) continue;
    customGroups.set(
      isCustomWorkflowId(name) ? name : customWorkflowId(name),
      members,
    );
  }

  const customGroupIdentities = (
    groupId: string,
  ): ProviderIdentity[] | undefined => {
    const members = customGroups.get(groupId);
    if (!members) return undefined;
    const identities: ProviderIdentity[] = [];
    for (const member of members) {
      const [providerId, profileId] = member.includes('/')
        ? member.split('/', 2)
        : [member, undefined];
      const matches = resolved.filter(
        (item) =>
          item.profile.identity.provider_id === providerId &&
          (profileId === undefined ||
            item.declaration.profile_id === profileId),
      );
      for (const match of matches) {
        if (match.availability.selectable)
          identities.push(match.profile.identity);
      }
    }
    return identities;
  };

  const targetIdentities = (
    targets: readonly CatalogProfileTarget[],
    requireSelectable: boolean,
  ): ProviderIdentity[] => {
    const identities: ProviderIdentity[] = [];
    const seen = new Set<string>();
    for (const target of targets) {
      const key = catalogProfileKey(target.provider_id, target.profile_id);
      const found = byKey.get(key);
      // Planned declarations never reach the planner: the frozen port only
      // carries implemented profiles, so an unknown reference is dropped here
      // instead of failing the whole plan.
      if (!found?.binding || seen.has(key)) continue;
      if (requireSelectable && !found.availability.selectable) continue;
      seen.add(key);
      identities.push(found.profile.identity);
    }
    return identities;
  };

  const planningProfiles: PlanningProfile[] = resolved
    .filter(
      (item): item is ResolvedCatalogProfile & { binding: ProfileBinding } =>
        item.binding !== undefined,
    )
    .map((item) => ({
      profile: item.profile,
      binding: {
        adapter_id: item.binding.adapter_id,
        binding_id: item.binding.binding_id,
      },
      ...(item.estimate && { estimate: item.estimate }),
      enabled: item.availability.enabled,
      credentialed: item.availability.credential_valid,
      configuration_valid: item.availability.configuration_valid,
    }));

  const revision = catalogFingerprint(
    entries.map((entry) => ({
      provider_id: entry.provider_id,
      order: entry.order,
      aliases: entry.aliases,
      credential: entry.credential,
      profiles: entry.profiles,
    })),
  );
  const digest = catalogFingerprint({
    revision,
    profiles: planningProfiles,
    workflows: BUILTIN_WORKFLOW_IDS.map((id) => ({
      workflow_id: id,
      members: workflowMembers(id).members,
    })),
    groups: Object.fromEntries(
      [...customGroups].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
    defaults: options.defaults ?? [],
    reserve: options.reserve ?? [],
  });

  const catalog: ProviderCatalog = {
    entries: ownFrozen(entries),
    resolved: Object.freeze(resolved),
    notices: ownFrozen(notices),
    issues: ownFrozen(issues),
    custom_group_ids: ownFrozen([...customGroups.keys()].sort()),
    revision,
    digest,
    profiles: ownFrozen(planningProfiles),
    get(providerId, profileId) {
      return byKey.get(catalogProfileKey(providerId, profileId));
    },
    workflow(workflowId) {
      return workflowMembers(workflowId);
    },
    resolveGroup(groupId) {
      if (RESERVED_WORKFLOW_IDS.has(groupId)) {
        return workflowMembers(groupId as BuiltinWorkflowId).members;
      }
      return customGroupIdentities(groupId);
    },
    resolveDefault() {
      // An explicit default roster wins; otherwise v1 behaviour is preserved as
      // the ordered set of enabled, selectable profiles -- never `quick` and
      // never `all` by name.
      if (options.defaults && options.defaults.length > 0) {
        return targetIdentities(options.defaults, true);
      }
      return resolved
        .filter((item) => item.availability.selectable)
        .map((item) => item.profile.identity);
    },
    resolveConfiguredReserve(primaries) {
      const primaryKeys = new Set(
        primaries.map((identity) =>
          catalogProfileKey(identity.provider_id, identity.profile_id),
        ),
      );
      // Availability, exclusion, and slot compatibility are the planner's
      // notices to emit, so unavailable members are passed through rather than
      // silently dropped. Only duplicates of a primary are removed here, since
      // an identity may appear at most once globally.
      return targetIdentities(options.reserve ?? [], false).filter(
        (identity) =>
          !primaryKeys.has(
            catalogProfileKey(identity.provider_id, identity.profile_id),
          ),
      );
    },
  };

  return Object.freeze(catalog);
}
