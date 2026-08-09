import {
  CONTRACT_LIMITS,
  OpaqueIdSchema,
  SnakeCaseNameSchema,
} from '../contracts/common.js';
import {
  type ExecutionProfile,
  ExecutionProfileSchema,
  type ProviderIdentity,
  providerIdentityKey,
} from '../contracts/domain/index.js';
import {
  compatibilityIssues,
  fallbackCompatibilityIssues,
  profileKey,
} from '../contracts/interchange/compatibility.js';
/*
 * Keep the schema import above at runtime: a typed catalog port is not a trust
 * boundary, and every catalog profile is validated before selection.
 */
import type {
  EvidenceRequirements,
  InterchangeRequest,
  RequestSlot,
} from '../contracts/interchange/request.js';
import {
  INTERCHANGE_VERSION,
  InterchangeRequestSchema,
} from '../contracts/interchange/request.js';
import {
  type CanonicalResearchRequest,
  CanonicalResearchRequestSchema,
  migrateLegacyResearchRequest,
  type PreparationIssue,
  type PreparationNotice,
  type ProfileTarget,
  RESEARCH_REQUEST_LIMITS,
} from './research-request.js';

export interface AdapterBindingIdentity {
  readonly adapter_id: string;
  readonly binding_id: string;
}

export interface NetworkFreeEstimate {
  readonly estimated_cost_microusd?: string;
  readonly billable_units?: readonly {
    readonly unit: string;
    readonly quantity: string;
  }[];
}

export interface PlanningProfile {
  readonly profile: ExecutionProfile;
  readonly binding: AdapterBindingIdentity;
  readonly estimate?: NetworkFreeEstimate;
  readonly enabled: boolean;
  readonly credentialed: boolean;
  readonly configuration_valid: boolean;
}

/**
 * A frozen, network-free view of profiles and selection policy. Production
 * catalog population belongs to #2556. Implementations must not perform
 * Librarium-controlled network calls. Building a snapshot from an explicitly
 * trusted npm or script provider may execute user code before this port exists.
 */
export interface FrozenPlanningCatalog<
  TProfile extends PlanningProfile = PlanningProfile,
> {
  readonly revision: string;
  readonly digest: string;
  readonly profiles: readonly TProfile[];
  resolveGroup(groupId: string): readonly ProviderIdentity[] | undefined;
  resolveDefault(): readonly ProviderIdentity[];
  resolveConfiguredReserve(
    primaries: readonly ProviderIdentity[],
  ): readonly ProviderIdentity[];
}

export interface PreparationClock {
  now(): number;
}

export interface PreparationIdGenerator {
  next(scope: 'request' | 'slot' | 'fallback_candidate'): string;
}

export interface PreparationDependencies {
  readonly clock: PreparationClock;
  readonly ids: PreparationIdGenerator;
}

export interface PreparedProfilePlan {
  readonly profile_key: string;
  readonly identity: ProviderIdentity;
  readonly binding: AdapterBindingIdentity;
  readonly estimate?: NetworkFreeEstimate;
}

export interface PrivateExecutionPolicy {
  readonly limits: CanonicalResearchRequest['limits'];
  readonly budgets?: CanonicalResearchRequest['budgets'];
  readonly fallback: CanonicalResearchRequest['fallback'];
  readonly exclusions: readonly ProfileTarget[];
  readonly refinement: CanonicalResearchRequest['refinement'];
}

export interface PreparedResearchExecution {
  readonly request: InterchangeRequest;
  readonly policy: PrivateExecutionPolicy;
  readonly profile_plans_by_identity: Readonly<
    Record<string, PreparedProfilePlan>
  >;
  readonly catalog: {
    readonly revision: string;
    readonly digest: string;
  };
  readonly notices: readonly PreparationNotice[];
}

export type PreparationResult =
  | {
      readonly ok: true;
      readonly prepared: PreparedResearchExecution;
      readonly notices: readonly PreparationNotice[];
    }
  | {
      readonly ok: false;
      readonly issues: readonly PreparationIssue[];
      readonly notices: readonly PreparationNotice[];
    };

interface SelectedProfile {
  readonly entry: PlanningProfile;
  readonly path: string;
  readonly requirements?: EvidenceRequirements;
}

const PHASE_ORDER = {
  transport: 0,
  migration: 1,
  canonicalization: 2,
  selection: 3,
  validation: 4,
  compilation: 5,
} as const;

function escapeJsonPointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

function jsonPointer(path: readonly PropertyKey[]): string {
  return path.length === 0
    ? ''
    : `/${path.map((part) => escapeJsonPointerToken(String(part))).join('/')}`;
}

function canonicalIssueCode(path: string, message: string): string {
  if (
    message === 'Inline attempt deadline cannot exceed the request deadline'
  ) {
    return 'inline_attempt_deadline_exceeds_request_deadline';
  }
  if (
    message === 'Background attempt deadline cannot exceed the request deadline'
  ) {
    return 'background_attempt_deadline_exceeds_request_deadline';
  }
  if (
    message === 'Poll interval cannot exceed the background attempt deadline'
  ) {
    return 'poll_interval_exceeds_background_attempt_deadline';
  }
  if (path === '/query' || path.startsWith('/query/')) return 'invalid_query';
  if (path === '/mode' || path.startsWith('/mode/')) return 'invalid_mode';
  if (path === '/selector' || path.startsWith('/selector/')) {
    return 'invalid_selector';
  }
  if (path === '/fallback' || path.startsWith('/fallback/')) {
    return 'invalid_fallback_intent';
  }
  if (path === '/limits/max_concurrency') {
    return 'concurrency_out_of_bounds';
  }
  if (
    path === '/limits/request_deadline_ms' ||
    path === '/limits/inline_attempt_deadline_ms' ||
    path === '/limits/background_attempt_deadline_ms'
  ) {
    return 'deadline_out_of_bounds';
  }
  if (path === '/limits/poll_interval_ms') {
    return 'poll_interval_out_of_bounds';
  }
  if (path === '/budgets' || path.startsWith('/budgets/')) {
    return 'invalid_exact_budget';
  }
  if (path === '/exclusions' || path.startsWith('/exclusions/')) {
    return 'invalid_exclusion';
  }
  if (path === '/refinement' || path.startsWith('/refinement/')) {
    return 'invalid_refinement_intent';
  }
  return 'invalid_canonical_request';
}

function sortDiagnostics<T extends PreparationIssue | PreparationNotice>(
  diagnostics: readonly T[],
): T[] {
  const compareText = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  return [...diagnostics].sort(
    (left, right) =>
      PHASE_ORDER[left.phase] - PHASE_ORDER[right.phase] ||
      compareText(left.path, right.path) ||
      compareText(left.code, right.code) ||
      compareText(left.profile_key ?? '', right.profile_key ?? ''),
  );
}

function profileIdentityKey(identity: ProviderIdentity): string {
  return providerIdentityKey(identity);
}

function targetKey(target: ProfileTarget): string {
  return JSON.stringify([target.provider_id, target.profile_id ?? null]);
}

function duplicateTargetIssues(
  targets: readonly ProfileTarget[],
  path: string,
  code: string,
  message: string,
): PreparationIssue[] {
  const issues: PreparationIssue[] = [];
  const seen = new Set<string>();
  for (const [index, target] of targets.entries()) {
    const key = targetKey(target);
    if (seen.has(key)) {
      issues.push({
        code,
        phase: 'validation',
        path: `${path}/${index}`,
        message,
      });
    }
    seen.add(key);
  }
  return issues;
}

function canonicalSetIssues(
  request: CanonicalResearchRequest,
): PreparationIssue[] {
  const issues = duplicateTargetIssues(
    request.exclusions,
    '/exclusions',
    'duplicate_exclusion',
    'Each exclusion may be declared only once.',
  );
  if (request.selector.kind === 'targets') {
    issues.push(
      ...duplicateTargetIssues(
        request.selector.targets,
        '/selector/targets',
        'duplicate_explicit_target',
        'Each explicit provider/profile target may be declared only once.',
      ),
    );
  }
  if (request.fallback.kind === 'explicit') {
    issues.push(
      ...duplicateTargetIssues(
        request.fallback.reserve,
        '/fallback/reserve',
        'duplicate_explicit_reserve_target',
        'Each explicit reserve target may be declared only once.',
      ),
    );
  }
  return issues;
}

function identityMatchesTarget(
  identity: ProviderIdentity,
  target: ProfileTarget,
): boolean {
  return (
    identity.provider_id === target.provider_id &&
    (target.profile_id === undefined ||
      identity.profile_id === target.profile_id)
  );
}

function requirementsForProfile(
  profile: ExecutionProfile,
): EvidenceRequirements {
  return {
    result_kind: profile.result_kind,
    grounding_policy:
      profile.result_kind === 'search_results'
        ? undefined
        : profile.grounding_policy,
    observation_mode: profile.observation_mode,
    corpora: [...profile.corpora],
    retrieval_methods: [profile.retrieval_method],
    surface_id: profile.surface_id,
  };
}

function isExcluded(
  identity: ProviderIdentity,
  exclusions: readonly ProfileTarget[],
): boolean {
  return exclusions.some((target) => identityMatchesTarget(identity, target));
}

function findCatalogEntry(
  byKey: ReadonlyMap<string, PlanningProfile>,
  identity: ProviderIdentity,
): PlanningProfile | undefined {
  return byKey.get(profileIdentityKey(identity));
}

function resolveTargets(
  targets: readonly ProfileTarget[],
  catalog: FrozenPlanningCatalog,
  basePath: string,
  issues: PreparationIssue[],
): SelectedProfile[] {
  const selected: SelectedProfile[] = [];
  for (const [index, target] of targets.entries()) {
    const path = `${basePath}/${index}`;
    const matches = catalog.profiles.filter(({ profile }) =>
      identityMatchesTarget(profile.identity, target),
    );
    if (matches.length === 0) {
      issues.push({
        code: 'profile_not_found',
        phase: 'selection',
        path,
        message: `No catalog profile matches provider ${target.provider_id}${target.profile_id ? ` and profile ${target.profile_id}` : ''}.`,
      });
      continue;
    }
    if (matches.length > 1) {
      // An explicit target must name one exact executable strategy. A bare
      // provider id that spans several profiles is rejected rather than
      // silently fanned out.
      issues.push({
        code: 'ambiguous_profile_target',
        phase: 'selection',
        path,
        message: `Provider ${target.provider_id} exposes ${matches.length} profiles (${matches
          .map(({ profile }) => profile.identity.profile_id)
          .sort()
          .join(', ')}). Qualify the target with a profile_id.`,
      });
      continue;
    }
    selected.push(...matches.map((entry) => ({ entry, path })));
  }
  return selected;
}

function resolveIdentities(
  identities: readonly ProviderIdentity[],
  byKey: ReadonlyMap<string, PlanningProfile>,
  path: string,
  issues: PreparationIssue[],
): SelectedProfile[] {
  const selected: SelectedProfile[] = [];
  for (const identity of identities) {
    const entry = findCatalogEntry(byKey, identity);
    if (!entry) {
      issues.push({
        code: 'catalog_profile_not_found',
        phase: 'selection',
        path,
        message: `Catalog selection references an unknown profile ${identity.provider_id}/${identity.profile_id}.`,
        profile_key: profileIdentityKey(identity),
      });
      continue;
    }
    selected.push({ entry, path });
  }
  return selected;
}

function profileAvailabilityIssues(
  selection: SelectedProfile,
  mode: CanonicalResearchRequest['mode'],
): PreparationIssue[] {
  const { entry, path } = selection;
  const key = profileIdentityKey(entry.profile.identity);
  const issues: PreparationIssue[] = [];
  if (!entry.enabled) {
    issues.push({
      code: 'profile_disabled',
      phase: 'validation',
      path,
      message: 'The selected profile is disabled.',
      profile_key: key,
    });
  }
  if (!entry.credentialed) {
    issues.push({
      code: 'profile_uncredentialed',
      phase: 'validation',
      path,
      message: 'The selected profile has no usable credentials.',
      profile_key: key,
    });
  }
  if (!entry.configuration_valid) {
    issues.push({
      code: 'profile_misconfigured',
      phase: 'validation',
      path,
      message: 'The selected profile configuration is invalid.',
      profile_key: key,
    });
  }
  if (mode === 'async' && entry.profile.resumability !== 'durable') {
    issues.push({
      code: 'async_requires_durable_profile',
      phase: 'validation',
      path,
      message: 'Async execution requires a durable profile.',
      profile_key: key,
    });
  }
  return issues;
}

function isUsableCapabilityMatch(
  entry: PlanningProfile,
  request: CanonicalResearchRequest,
  requirements: EvidenceRequirements,
): boolean {
  return (
    entry.enabled &&
    entry.credentialed &&
    entry.configuration_valid &&
    (request.mode !== 'async' || entry.profile.resumability === 'durable') &&
    !isExcluded(entry.profile.identity, request.exclusions) &&
    compatibilityIssues(requirements, entry.profile).length === 0
  );
}

function selectPrimaries(
  request: CanonicalResearchRequest,
  catalog: FrozenPlanningCatalog,
  byKey: ReadonlyMap<string, PlanningProfile>,
  issues: PreparationIssue[],
): SelectedProfile[] {
  let selected: SelectedProfile[];
  switch (request.selector.kind) {
    case 'targets':
      selected = resolveTargets(
        request.selector.targets,
        catalog,
        '/selector/targets',
        issues,
      );
      break;
    case 'group': {
      const identities = catalog.resolveGroup(request.selector.group_id);
      if (!identities) {
        issues.push({
          code: 'group_not_found',
          phase: 'selection',
          path: '/selector/group_id',
          message: `Unknown profile group ${request.selector.group_id}.`,
        });
        return [];
      }
      selected = resolveIdentities(identities, byKey, '/selector', issues);
      break;
    }
    case 'capabilities': {
      const selector = request.selector;
      selected = catalog.profiles
        .filter((entry) =>
          isUsableCapabilityMatch(entry, request, selector.requirements),
        )
        .map((entry) => ({
          entry,
          path: '/selector/requirements',
          requirements: selector.requirements,
        }));
      if (
        selector.result_count !== undefined &&
        selected.length < selector.result_count
      ) {
        issues.push({
          code: 'capability_result_count_unavailable',
          phase: 'selection',
          path: '/selector/result_count',
          message: `Capability selection requested ${selector.result_count} profiles but only ${selected.length} are eligible.`,
        });
      } else if (selector.result_count !== undefined) {
        selected = selected.slice(0, selector.result_count);
      }
      break;
    }
    case 'default':
      selected = resolveIdentities(
        catalog.resolveDefault(),
        byKey,
        '/selector',
        issues,
      );
      break;
  }

  if (request.selector.kind !== 'capabilities') {
    const retained: SelectedProfile[] = [];
    for (const selection of selected) {
      if (isExcluded(selection.entry.profile.identity, request.exclusions)) {
        if (request.selector.kind === 'targets') {
          issues.push({
            code: 'explicit_profile_excluded',
            phase: 'validation',
            path: selection.path,
            message: 'An explicitly selected profile is also excluded.',
            profile_key: profileIdentityKey(selection.entry.profile.identity),
          });
        }
        continue;
      }
      retained.push(selection);
      issues.push(...profileAvailabilityIssues(selection, request.mode));
    }
    selected = retained;
  }

  if (selected.length === 0 && issues.length === 0) {
    issues.push({
      code: 'selection_empty',
      phase: 'selection',
      path: '/selector',
      message: 'The selector did not resolve any usable profiles.',
    });
  }

  const seen = new Set<string>();
  for (const selection of selected) {
    const key = profileKey(selection.entry.profile);
    if (seen.has(key)) {
      issues.push({
        code: 'profile_selected_more_than_once',
        phase: 'validation',
        path: selection.path,
        message: 'Each provider profile may be selected only once.',
        profile_key: profileIdentityKey(selection.entry.profile.identity),
      });
    }
    seen.add(key);
  }
  return selected;
}

const EXACT_INTEGER_STRING_PATTERN = /^(?:0|[1-9]\d*)$/;
const BILLABLE_QUANTITY_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;
// Mirrors the UsageSchema billable_units bound; also caps validation work per
// catalog entry so a hostile catalog cannot amplify iteration.
const MAX_BILLABLE_UNITS = 32;

function isExactBoundedIntegerString(value: string): boolean {
  return (
    value.length <= RESEARCH_REQUEST_LIMITS.exactIntegerLength &&
    EXACT_INTEGER_STRING_PATTERN.test(value)
  );
}

/**
 * Hardens runtime catalog metadata before any BigInt conversion or budget
 * arithmetic. Every diagnostic is stable and index-addressed so a broken
 * catalog entry can be located without positional guessing.
 */
function validatePlanningMetadata(
  entries: readonly PlanningProfile[],
  issues: PreparationIssue[],
): void {
  const keys = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const entryPath = `/catalog/profiles/${index}`;
    const parsedProfile = ExecutionProfileSchema.safeParse(entry.profile);
    if (!parsedProfile.success) {
      for (const issue of parsedProfile.error.issues) {
        issues.push({
          code: 'invalid_catalog_execution_profile',
          phase: 'validation',
          path: `${entryPath}/profile${jsonPointer(issue.path)}`,
          message: issue.message,
        });
      }
      continue;
    }
    const key = profileIdentityKey(entry.profile.identity);
    if (keys.has(key)) {
      issues.push({
        code: 'catalog_profile_duplicate',
        phase: 'validation',
        path: `${entryPath}/profile/identity`,
        message: 'The frozen catalog contains a duplicate provider profile.',
        profile_key: key,
      });
    }
    keys.add(key);
    const bindingFields = [
      ['adapter_id', entry.binding.adapter_id],
      ['binding_id', entry.binding.binding_id],
    ] as const;
    for (const [field, value] of bindingFields) {
      if (!OpaqueIdSchema.safeParse(value).success) {
        issues.push({
          code: 'invalid_adapter_binding_identity',
          phase: 'validation',
          path: `${entryPath}/binding/${field}`,
          message: `Adapter binding identities must be non-empty, trimmed, control-free opaque identifiers of at most ${CONTRACT_LIMITS.identifierLength} characters.`,
          profile_key: key,
        });
      }
    }
    const estimatedCost = entry.estimate?.estimated_cost_microusd;
    if (
      estimatedCost !== undefined &&
      !isExactBoundedIntegerString(estimatedCost)
    ) {
      issues.push({
        code: 'invalid_network_free_estimate',
        phase: 'validation',
        path: `${entryPath}/estimate/estimated_cost_microusd`,
        message: `Estimated cost must be an exact non-negative integer string of at most ${RESEARCH_REQUEST_LIMITS.exactIntegerLength} characters.`,
        profile_key: key,
      });
    }
    const billableUnits = entry.estimate?.billable_units ?? [];
    if (billableUnits.length > MAX_BILLABLE_UNITS) {
      issues.push({
        code: 'invalid_billable_unit_estimate',
        phase: 'validation',
        path: `${entryPath}/estimate/billable_units`,
        message: `At most ${MAX_BILLABLE_UNITS} billable units may be declared per estimate.`,
        profile_key: key,
      });
      continue;
    }
    for (const [unitIndex, unit] of billableUnits.entries()) {
      const unitPath = `${entryPath}/estimate/billable_units/${unitIndex}`;
      if (!SnakeCaseNameSchema.safeParse(unit.unit).success) {
        issues.push({
          code: 'invalid_billable_unit_estimate',
          phase: 'validation',
          path: `${unitPath}/unit`,
          message: 'Billable units must use bounded snake_case unit names.',
          profile_key: key,
        });
      }
      if (
        unit.quantity.length > CONTRACT_LIMITS.decimalStringLength ||
        !BILLABLE_QUANTITY_PATTERN.test(unit.quantity)
      ) {
        issues.push({
          code: 'invalid_billable_unit_estimate',
          phase: 'validation',
          path: `${unitPath}/quantity`,
          message:
            'Billable unit quantities must be bounded non-negative decimal strings.',
          profile_key: key,
        });
      }
    }
  }
}

function validateCatalogIdentity(
  catalog: FrozenPlanningCatalog,
  issues: PreparationIssue[],
): { readonly revision: string; readonly digest: string } | undefined {
  const revision = OpaqueIdSchema.safeParse(catalog.revision);
  if (!revision.success) {
    issues.push({
      code: 'invalid_catalog_revision',
      phase: 'validation',
      path: '/catalog/revision',
      message:
        'Catalog revision must be a bounded, trimmed, control-free opaque identifier.',
    });
  }
  const digest = OpaqueIdSchema.safeParse(catalog.digest);
  if (!digest.success) {
    issues.push({
      code: 'invalid_catalog_digest',
      phase: 'validation',
      path: '/catalog/digest',
      message:
        'Catalog digest must be a bounded, trimmed, control-free opaque identifier.',
    });
  }
  return revision.success && digest.success
    ? { revision: revision.data, digest: digest.data }
    : undefined;
}

function resolveReserve(
  request: CanonicalResearchRequest,
  catalog: FrozenPlanningCatalog,
  byKey: ReadonlyMap<string, PlanningProfile>,
  primaries: readonly SelectedProfile[],
  slots: readonly RequestSlot[],
  issues: PreparationIssue[],
  notices: PreparationNotice[],
): SelectedProfile[] {
  if (request.fallback.kind === 'disabled') return [];

  const fallback = request.fallback;
  const explicit = fallback.kind === 'explicit';
  const reserve =
    fallback.kind === 'explicit'
      ? resolveTargets(fallback.reserve, catalog, '/fallback/reserve', issues)
      : resolveIdentities(
          catalog.resolveConfiguredReserve(
            primaries.map(({ entry }) => entry.profile.identity),
          ),
          byKey,
          '/fallback',
          issues,
        );

  const used = new Set(primaries.map(({ entry }) => profileKey(entry.profile)));
  const retained: SelectedProfile[] = [];
  for (const selection of reserve) {
    const key = profileKey(selection.entry.profile);
    const diagnosticKey = profileIdentityKey(selection.entry.profile.identity);
    if (used.has(key)) {
      // A profile may appear only once across the primary and reserve plan.
      // Asking for it twice explicitly is an error; a configured reserve that
      // happens to overlap is omitted with a notice, like every other
      // configured-reserve omission.
      const diagnostic = {
        code: explicit
          ? 'profile_reused_in_fallback'
          : 'configured_fallback_duplicate',
        phase: 'validation' as const,
        path: selection.path,
        message:
          'A provider profile may appear only once in the primary and reserve plan.',
        profile_key: diagnosticKey,
      };
      if (explicit) issues.push(diagnostic);
      else notices.push(diagnostic);
      continue;
    }
    used.add(key);

    if (isExcluded(selection.entry.profile.identity, request.exclusions)) {
      if (explicit) {
        issues.push({
          code: 'explicit_fallback_excluded',
          phase: 'validation',
          path: selection.path,
          message: 'An explicit fallback profile is also excluded.',
          profile_key: diagnosticKey,
        });
      }
      continue;
    }

    const availability = profileAvailabilityIssues(selection, request.mode);
    if (availability.length > 0) {
      if (explicit) {
        issues.push(...availability);
      } else {
        notices.push({
          code: 'configured_fallback_unavailable',
          phase: 'validation',
          path: selection.path,
          message: 'An unavailable configured fallback was omitted.',
          profile_key: diagnosticKey,
        });
      }
      continue;
    }

    const eligible = slots.filter(
      (slot) =>
        fallbackCompatibilityIssues(slot, selection.entry.profile).length === 0,
    );
    if (eligible.length === 0) {
      const diagnostic = {
        code: explicit
          ? 'fallback_profile_incompatible'
          : 'configured_fallback_incompatible',
        phase: 'validation' as const,
        path: selection.path,
        message:
          'The fallback profile is incompatible with every selected evidence lane.',
        profile_key: diagnosticKey,
      };
      if (explicit) issues.push(diagnostic);
      else notices.push(diagnostic);
      continue;
    }
    retained.push(selection);
  }
  return retained;
}

function profilePlan(entry: PlanningProfile): PreparedProfilePlan {
  return {
    profile_key: profileIdentityKey(entry.profile.identity),
    identity: { ...entry.profile.identity },
    binding: {
      adapter_id: entry.binding.adapter_id,
      binding_id: entry.binding.binding_id,
    },
    estimate: entry.estimate
      ? {
          estimated_cost_microusd: entry.estimate.estimated_cost_microusd,
          billable_units: entry.estimate.billable_units?.map((unit) => ({
            unit: unit.unit,
            quantity: unit.quantity,
          })),
        }
      : undefined,
  };
}

function validatePrimaryBudgetAdmission(
  request: CanonicalResearchRequest,
  primaries: readonly SelectedProfile[],
  reserve: readonly SelectedProfile[],
  issues: PreparationIssue[],
): void {
  if (!request.budgets) return;
  let total = 0n;
  for (const selection of [...primaries, ...reserve]) {
    const estimate = selection.entry.estimate?.estimated_cost_microusd;
    if (estimate === undefined) {
      issues.push({
        code: 'budget_estimate_required',
        phase: 'validation',
        path: selection.path,
        message:
          'A hard request budget requires a bounded network-free estimate for every planned profile.',
        profile_key: profileIdentityKey(selection.entry.profile.identity),
      });
      continue;
    }
    if (primaries.includes(selection)) total += BigInt(estimate);
  }
  if (issues.some((issue) => issue.code === 'budget_estimate_required')) {
    return;
  }
  const totalText = total.toString();
  for (const [field, limit] of Object.entries(request.budgets)) {
    if (limit !== undefined && BigInt(totalText) > BigInt(limit)) {
      issues.push({
        code: 'primary_plan_budget_exceeded',
        phase: 'validation',
        path: `/budgets/${field}`,
        message:
          'The complete primary plan exceeds this hard budget before execution.',
      });
    }
  }
}

export function prepareResearchExecution(
  input: unknown,
  catalog: FrozenPlanningCatalog,
  dependencies: PreparationDependencies,
): PreparationResult {
  const migration = migrateLegacyResearchRequest(input);
  const notices: PreparationNotice[] = [...migration.notices];
  const canonical = CanonicalResearchRequestSchema.safeParse(migration.input);
  if (!canonical.success) {
    const issues = canonical.error.issues.map((issue) => {
      const path = jsonPointer(issue.path);
      return {
        code: canonicalIssueCode(path, issue.message),
        phase: 'canonicalization' as const,
        path,
        message: issue.message,
      };
    });
    return {
      ok: false,
      issues: sortDiagnostics(issues),
      notices: sortDiagnostics(notices),
    };
  }

  const request = canonical.data;
  const issues = canonicalSetIssues(request);
  if (issues.length > 0) {
    return {
      ok: false,
      issues: sortDiagnostics(issues),
      notices: sortDiagnostics(notices),
    };
  }
  const catalogIdentity = validateCatalogIdentity(catalog, issues);
  validatePlanningMetadata(catalog.profiles, issues);
  if (issues.length > 0) {
    return {
      ok: false,
      issues: sortDiagnostics(issues),
      notices: sortDiagnostics(notices),
    };
  }
  if (!catalogIdentity) {
    throw new Error('Catalog identity validation did not produce metadata.');
  }
  const byKey = new Map(
    catalog.profiles.map((entry) => [
      profileIdentityKey(entry.profile.identity),
      entry,
    ]),
  );
  const primaries = selectPrimaries(request, catalog, byKey, issues);

  const requestedAt = new Date(dependencies.clock.now()).toISOString();
  const slots: RequestSlot[] = primaries.map((selection, position) => ({
    slot_id: dependencies.ids.next('slot'),
    position,
    requirements:
      selection.requirements ?? requirementsForProfile(selection.entry.profile),
    primary: selection.entry.profile,
  }));
  const reserve = resolveReserve(
    request,
    catalog,
    byKey,
    primaries,
    slots,
    issues,
    notices,
  );

  validatePrimaryBudgetAdmission(request, primaries, reserve, issues);

  if (issues.length > 0) {
    return {
      ok: false,
      issues: sortDiagnostics(issues),
      notices: sortDiagnostics(notices),
    };
  }

  const fallbackReserve = reserve.map((selection, position) => ({
    candidate_id: dependencies.ids.next('fallback_candidate'),
    position,
    profile: selection.entry.profile,
    eligible_slot_ids: slots
      .filter(
        (slot) =>
          fallbackCompatibilityIssues(slot, selection.entry.profile).length ===
          0,
      )
      .map((slot) => slot.slot_id),
  }));
  const compiled = InterchangeRequestSchema.safeParse({
    interchange_version: INTERCHANGE_VERSION,
    message_type: 'request',
    request_id: dependencies.ids.next('request'),
    requested_at: requestedAt,
    mode: request.mode,
    query: request.query,
    slots,
    fallback_reserve: fallbackReserve,
  });
  if (!compiled.success) {
    return {
      ok: false,
      issues: sortDiagnostics(
        compiled.error.issues.map((issue) => ({
          code: 'compiled_request_invalid',
          phase: 'compilation' as const,
          path: jsonPointer(issue.path),
          message: issue.message,
        })),
      ),
      notices: sortDiagnostics(notices),
    };
  }

  const profilePlans = Object.fromEntries(
    [...primaries, ...reserve].map(({ entry }) => {
      const plan = profilePlan(entry);
      return [plan.profile_key, plan];
    }),
  );
  const sortedNotices = sortDiagnostics(notices);
  const prepared: PreparedResearchExecution = {
    request: compiled.data,
    policy: {
      limits: request.limits,
      budgets: request.budgets,
      fallback: request.fallback,
      exclusions: request.exclusions,
      refinement: request.refinement,
    },
    profile_plans_by_identity: profilePlans,
    catalog: catalogIdentity,
    notices: sortedNotices,
  };
  return { ok: true, prepared, notices: sortedNotices };
}

export { profileIdentityKey };
