import { OpaqueIdSchema } from '../contracts/common.js';
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
import { RESERVED_BUILTIN_PROVIDER_IDS } from './reserved-provider-ids.js';

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
  readonly binding?: CatalogProfileBinding;
  readonly estimate?: NetworkFreeEstimate;
  readonly availability: {
    readonly enabled: boolean;
    readonly reserve_only: boolean;
    readonly credential_valid: boolean;
    readonly configuration_valid: boolean;
    readonly selectable: boolean;
    readonly reasons: readonly string[];
  };
}

/** Closure-free identity used by the planner for built-in and custom adapters. */
export interface CatalogProfileBinding {
  readonly provider_id: string;
  readonly profile_id: string;
  readonly adapter_id: string;
  readonly binding_id: string;
}

/**
 * A trusted custom provider's planning-only declaration. Runtime code loading
 * and operation validation remain outside this Worker-safe catalog boundary.
 */
export interface CustomCatalogProfile {
  readonly adapter_id: string;
  readonly binding_id: string;
  readonly profile: ExecutionProfile;
  readonly credential_env_var?: string;
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
  /** Adapter ids which are disabled for primary selection but valid reserve. */
  readonly reserveOnlyAdapterIds?: readonly string[];
  /** Already trust-filtered custom profiles; untrusted/disabled code stays out. */
  readonly customProfiles?: readonly CustomCatalogProfile[];
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
        reserve_only: false,
        credential_valid: false,
        configuration_valid: true,
        selectable: false,
        reasons,
      }),
    });
  }

  const providerConfig = bindingConfig(options, binding.adapter_id);
  const enabled = providerConfig?.enabled === true;
  const reserveOnly =
    !enabled &&
    options.reserveOnlyAdapterIds?.includes(binding.adapter_id) === true;
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
    // The whole provider config is handed over, not just `options`: the
    // identifier an adapter actually sends comes from top-level `model`, and a
    // resolved configurable target that ignored it would misdescribe the exact
    // executable strategy.
    const resolution = binding.resolve({
      ...(providerConfig?.model !== undefined && {
        model: providerConfig.model,
      }),
      options: providerConfig?.options ?? {},
    });
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
      reserve_only: reserveOnly,
      credential_valid: credentialValid,
      configuration_valid: configurationValid,
      selectable: enabled && credentialValid && configurationValid,
      reasons,
    }),
  });
}

function customDeclaration(
  profile: ExecutionProfile,
  selectionOrder: number,
): ExecutableProfileDeclaration {
  const { identity, extensions: _extensions, ...facts } = profile;
  return {
    ...facts,
    profile_id: identity.profile_id,
    target: identity.target,
    selection_order: selectionOrder,
    status: 'implemented',
    workflows: [],
  };
}

function resolveCustomProfile(
  custom: CustomCatalogProfile,
  selectionOrder: number,
  options: ProviderCatalogOptions,
): ResolvedCatalogProfile {
  const providerConfig = bindingConfig(options, custom.adapter_id);
  const enabled = providerConfig?.enabled === true;
  const reserveOnly =
    !enabled &&
    options.reserveOnlyAdapterIds?.includes(custom.adapter_id) === true;
  const credentialReference =
    providerConfig?.apiKey ??
    (custom.credential_env_var ? `$${custom.credential_env_var}` : undefined);
  const credentialValid = custom.credential_env_var
    ? hasCredential(credentialReference, options.credentials ?? {})
    : true;
  const reasons: string[] = [];
  if (!enabled) reasons.push('profile_disabled');
  if (!credentialValid) reasons.push('credential_missing');
  const profile = ownFrozen(custom.profile);
  const binding = ownFrozen<CatalogProfileBinding>({
    provider_id: profile.identity.provider_id,
    profile_id: profile.identity.profile_id,
    adapter_id: custom.adapter_id,
    binding_id: custom.binding_id,
  });
  return Object.freeze({
    declaration: ownFrozen(customDeclaration(profile, selectionOrder)),
    profile,
    binding,
    availability: ownFrozen({
      enabled,
      reserve_only: reserveOnly,
      credential_valid: credentialValid,
      configuration_valid: true,
      selectable: enabled && credentialValid,
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

  const declaredCustomProfiles = ownFrozen(
    [...(options.customProfiles ?? [])].sort((left, right) => {
      const leftKey = JSON.stringify([
        left.profile.identity.provider_id,
        left.profile.identity.profile_id,
        left.adapter_id,
        left.binding_id,
      ]);
      const rightKey = JSON.stringify([
        right.profile.identity.provider_id,
        right.profile.identity.profile_id,
        right.adapter_id,
        right.binding_id,
      ]);
      return leftKey.localeCompare(rightKey);
    }),
  );
  const customProfiles = declaredCustomProfiles.filter((custom) => {
    const enabled = bindingConfig(options, custom.adapter_id)?.enabled === true;
    return (
      enabled ||
      options.reserveOnlyAdapterIds?.includes(custom.adapter_id) === true
    );
  });
  const profileKeys = new Set(
    refs.map(({ entry, declaration }) =>
      JSON.stringify([entry.provider_id, declaration.profile_id]),
    ),
  );
  const adapterBindingKeys = new Set(
    [...bindings.values()].map((binding) =>
      JSON.stringify([binding.adapter_id, binding.binding_id]),
    ),
  );
  const builtinAdapterIds = new Set(
    [...bindings.values()].map((binding) => binding.adapter_id),
  );
  for (const custom of customProfiles) {
    for (const [field, value] of [
      ['adapter id', custom.adapter_id],
      ['binding id', custom.binding_id],
    ] as const) {
      if (!OpaqueIdSchema.safeParse(value).success) {
        throw new ProviderCatalogError(
          `Custom provider ${field} must be a canonical opaque identifier: ${JSON.stringify(value)}`,
        );
      }
    }
    if (
      builtinAdapterIds.has(custom.adapter_id) ||
      RESERVED_BUILTIN_PROVIDER_IDS.has(custom.adapter_id)
    ) {
      throw new ProviderCatalogError(
        `Custom provider adapter id is reserved: ${custom.adapter_id}`,
      );
    }
    if (
      RESERVED_BUILTIN_PROVIDER_IDS.has(custom.profile.identity.provider_id)
    ) {
      throw new ProviderCatalogError(
        `Custom provider profile provider id is reserved: ${custom.profile.identity.provider_id}`,
      );
    }
    for (const [field, value] of [
      ['adapter id', custom.adapter_id],
      ['provider id', custom.profile.identity.provider_id],
      ['profile id', custom.profile.identity.profile_id],
    ] as const) {
      if (value.includes('/')) {
        throw new ProviderCatalogError(
          `Custom provider ${field} cannot contain the selector delimiter "/": ${value}`,
        );
      }
    }
    const profileTuple = JSON.stringify([
      custom.profile.identity.provider_id,
      custom.profile.identity.profile_id,
    ]);
    const profileDisplay = catalogProfileKey(
      custom.profile.identity.provider_id,
      custom.profile.identity.profile_id,
    );
    if (profileKeys.has(profileTuple)) {
      throw new ProviderCatalogError(
        `Duplicate provider profile declaration: ${profileDisplay}`,
      );
    }
    profileKeys.add(profileTuple);
    if (custom.profile.resumability === 'process_local') {
      throw new ProviderCatalogError(
        `Custom provider profiles cannot use process_local resumability: ${custom.adapter_id}`,
      );
    }
    const bindingKey = JSON.stringify([custom.adapter_id, custom.binding_id]);
    if (adapterBindingKeys.has(bindingKey)) {
      throw new ProviderCatalogError(
        `Duplicate adapter binding declaration: ${bindingKey}`,
      );
    }
    adapterBindingKeys.add(bindingKey);
  }

  const resolved: ResolvedCatalogProfile[] = [
    ...refs.map(({ entry, declaration }) =>
      resolveDeclaration(
        entry,
        declaration,
        bindings.get(
          catalogProfileKey(entry.provider_id, declaration.profile_id),
        ),
        options,
      ),
    ),
    ...customProfiles.map((custom, index) =>
      resolveCustomProfile(custom, refs.length + index + 1, options),
    ),
  ];
  const byKey = new Map(resolved.map((item) => [profileKeyOf(item), item]));

  // The catalog owns its selection policy from here on. Groups, defaults, and
  // the reserve are cloned and frozen before migration, digesting, and closure
  // capture, so mutating the caller's objects afterwards can never change what
  // an already-constructed catalog resolves -- or make the digest describe
  // behaviour the catalog no longer has.
  const configuredGroups = ownFrozen(options.groups ?? {});
  const configuredDefaults = ownFrozen(options.defaults ?? []);
  const configuredReserve = ownFrozen(options.reserve ?? []);

  const migration = migrateUserWorkflowNames(configuredGroups);
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
  //
  // Normalising `<name>` onto an already-explicit `custom:<name>` would destroy
  // one of the user's two definitions, so the explicitly canonical spelling is
  // taken first and always wins. The raw definition is left exactly as the
  // caller wrote it and the collision is reported instead of resolved by
  // guessing, which makes the outcome independent of declaration order.
  const customGroups = new Map<
    string,
    { readonly source_name: string; readonly members: readonly string[] }
  >();
  const migratedNames = Object.keys(migration.groups).filter(
    (name) => !RESERVED_WORKFLOW_IDS.has(name),
  );
  for (const name of migratedNames.filter(isCustomWorkflowId)) {
    customGroups.set(name, {
      source_name: name,
      members: migration.groups[name] ?? [],
    });
  }
  for (const name of migratedNames.filter(
    (item) => !isCustomWorkflowId(item),
  )) {
    const groupId = customWorkflowId(name);
    const existing = customGroups.get(groupId);
    if (existing) {
      issues.push({
        code: 'custom_group_name_collision',
        phase: 'migration',
        path: `/groups/${name}`,
        message: `"${name}" is selected as "${groupId}", which is already defined explicitly. Rename or consolidate one of them; Librarium will not overwrite "${existing.source_name}".`,
      });
      continue;
    }
    customGroups.set(groupId, {
      source_name: name,
      members: migration.groups[name] ?? [],
    });
  }

  /** Split a group member into its provider and optional profile reference. */
  const parseGroupMember = (
    member: string,
  ):
    | { readonly provider_id: string; readonly profile_id?: string }
    | undefined => {
    const parts = member.split('/');
    if (parts.length > 2) return undefined;
    const [providerId, profileId] = parts;
    if (!providerId) return undefined;
    if (parts.length === 2 && !profileId) return undefined;
    return {
      provider_id: providerId,
      ...(profileId !== undefined && { profile_id: profileId }),
    };
  };

  const groupMemberMatches = (member: string): ResolvedCatalogProfile[] => {
    const parsed = parseGroupMember(member);
    if (!parsed) return [];
    // A bare provider id is a roster entry, not an explicit target: it
    // intentionally fans out to that provider's profiles for legacy group
    // compatibility. Ambiguity is only rejected by the explicit-target selector.
    return resolved.filter(
      (item) =>
        item.profile.identity.provider_id === parsed.provider_id &&
        (parsed.profile_id === undefined ||
          item.declaration.profile_id === parsed.profile_id),
    );
  };

  const customGroupIdentities = (
    groupId: string,
  ): ProviderIdentity[] | undefined => {
    const group = customGroups.get(groupId);
    if (!group) return undefined;
    const identities: ProviderIdentity[] = [];
    for (const member of group.members) {
      for (const match of groupMemberMatches(member)) {
        if (match.availability.selectable)
          identities.push(match.profile.identity);
      }
    }
    return identities;
  };

  /**
   * A configured reference that names nothing the catalog can ever execute is a
   * configuration error, not an availability outcome. Both cases still resolve
   * to an omission so the planner keeps behaving exactly as before, but neither
   * disappears without an actionable, path-addressed diagnostic.
   *
   * A profile that exists and is bound but is disabled, uncredentialed, or
   * misconfigured is deliberately *not* reported here: that is availability,
   * and the planner already explains it.
   */
  const referenceIssue = (
    kind: 'default' | 'reserve',
    path: string,
    key: string,
  ): PreparationIssue | undefined => {
    const found = byKey.get(key);
    if (found?.binding) return undefined;
    return found
      ? {
          code: `configured_${kind}_unbound_profile`,
          phase: 'validation',
          path,
          message: `Configured ${kind} "${key}" is a planned profile with no implementation and can never be selected. Remove it or choose an implemented profile.`,
          profile_key: key,
        }
      : {
          code: `configured_${kind}_unknown_profile`,
          phase: 'validation',
          path,
          message: `Configured ${kind} "${key}" is not a known provider profile. Check the provider and profile ids.`,
          profile_key: key,
        };
  };

  configuredDefaults.forEach((target, index) => {
    const issue = referenceIssue(
      'default',
      `/defaults/${index}`,
      catalogProfileKey(target.provider_id, target.profile_id),
    );
    if (issue) issues.push(issue);
  });

  configuredReserve.forEach((target, index) => {
    const issue = referenceIssue(
      'reserve',
      `/reserve/${index}`,
      catalogProfileKey(target.provider_id, target.profile_id),
    );
    if (issue) issues.push(issue);
  });

  for (const group of customGroups.values()) {
    group.members.forEach((member, index) => {
      const path = `/groups/${group.source_name}/${index}`;
      if (!parseGroupMember(member)) {
        issues.push({
          code: 'custom_group_member_malformed',
          phase: 'validation',
          path,
          message: `Group member "${member}" is not a provider id or a "provider/profile" reference.`,
        });
        return;
      }
      const matches = groupMemberMatches(member);
      if (matches.length === 0) {
        issues.push({
          code: 'custom_group_member_unknown_profile',
          phase: 'validation',
          path,
          message: `Group member "${member}" does not match any known provider profile. Check the provider and profile ids.`,
          profile_key: member,
        });
        return;
      }
      if (!matches.some((match) => match.binding)) {
        issues.push({
          code: 'custom_group_member_unbound_profile',
          phase: 'validation',
          path,
          message: `Group member "${member}" only matches planned profiles with no implementation and can never be selected. Remove it or choose an implemented profile.`,
          profile_key: member,
        });
      }
    });
  }

  issues.sort((left, right) =>
    left.path === right.path
      ? left.code < right.code
        ? -1
        : left.code > right.code
          ? 1
          : 0
      : left.path < right.path
        ? -1
        : 1,
  );

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
      (
        item,
      ): item is ResolvedCatalogProfile & { binding: CatalogProfileBinding } =>
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
      reserve_only: item.availability.reserve_only,
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
    custom_profiles: customProfiles,
    profiles: planningProfiles,
    workflows: BUILTIN_WORKFLOW_IDS.map((id) => ({
      workflow_id: id,
      members: workflowMembers(id).members,
    })),
    groups: Object.fromEntries(
      [...customGroups]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([groupId, group]) => [groupId, group.members]),
    ),
    defaults: configuredDefaults,
    reserve: configuredReserve,
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
      if (configuredDefaults.length > 0) {
        return targetIdentities(configuredDefaults, true);
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
      return targetIdentities(configuredReserve, false).filter(
        (identity) =>
          !primaryKeys.has(
            catalogProfileKey(identity.provider_id, identity.profile_id),
          ),
      );
    },
  };

  return Object.freeze(catalog);
}
