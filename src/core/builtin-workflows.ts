import type {
  PreparationIssue,
  PreparationNotice,
} from './research-request.js';

/**
 * The single source of built-in workflow policy for v2.
 *
 * Exactly four names are reserved. `quick` and `visibility` are curated ordered
 * rosters; `deep` and `all` are derived from catalog facts at resolution time.
 * The migration helpers below are deliberately standalone so #2558 can own the
 * public config migration without re-deriving this policy.
 */

export const BUILTIN_WORKFLOW_IDS = [
  'quick',
  'deep',
  'visibility',
  'all',
] as const;

export type BuiltinWorkflowId = (typeof BUILTIN_WORKFLOW_IDS)[number];

/** Workflows a profile can declare membership in. `all` is always dynamic. */
export type DeclarableWorkflowId = Exclude<BuiltinWorkflowId, 'all'>;

export const RESERVED_WORKFLOW_IDS: ReadonlySet<string> = new Set(
  BUILTIN_WORKFLOW_IDS,
);

/** Built-in group names that v2 removes. */
export const REMOVED_BUILTIN_WORKFLOW_IDS: readonly string[] = [
  'raw',
  'fast',
  'llm',
  'models',
  'comprehensive',
  'social',
  'xai',
];

const REMOVED_WORKFLOW_ID_SET: ReadonlySet<string> = new Set(
  REMOVED_BUILTIN_WORKFLOW_IDS,
);

export const CUSTOM_WORKFLOW_PREFIX = 'custom:';

export function customWorkflowId(name: string): string {
  return `${CUSTOM_WORKFLOW_PREFIX}${name}`;
}

export function isCustomWorkflowId(id: string): boolean {
  return id.startsWith(CUSTOM_WORKFLOW_PREFIX);
}

/** `provider_id/profile_id` members of a curated roster, in policy order. */
export interface WorkflowRosterMember {
  readonly provider_id: string;
  readonly profile_id: string;
}

/** Curated low-latency discovery and cited answers. */
export const QUICK_WORKFLOW_ROSTER: readonly WorkflowRosterMember[] = [
  { provider_id: 'gemini-grounded', profile_id: 'grounded' },
  { provider_id: 'openrouter', profile_id: 'grounded' },
  { provider_id: 'brave-answers', profile_id: 'grounded' },
  { provider_id: 'exa', profile_id: 'search' },
  { provider_id: 'kagi-fastgpt', profile_id: 'grounded' },
];

/**
 * Consumer-surface observations first, then clearly labelled first-party API
 * comparison baselines. The last three are API answers from the same vendors,
 * not snapshots of their consumer surfaces, and the catalog keeps them
 * structurally distinct (`api_output` vs `surface_snapshot`).
 */
export const VISIBILITY_WORKFLOW_ROSTER: readonly WorkflowRosterMember[] = [
  { provider_id: 'searchapi-chatgpt', profile_id: 'surface' },
  { provider_id: 'searchapi-gemini', profile_id: 'surface' },
  { provider_id: 'searchapi-perplexity', profile_id: 'surface' },
  { provider_id: 'searchapi-google-ai-mode', profile_id: 'surface' },
  { provider_id: 'searchapi-bing-copilot', profile_id: 'surface' },
  { provider_id: 'searchapi-google-ai-overview', profile_id: 'surface' },
  { provider_id: 'perplexity-sonar-pro', profile_id: 'grounded' },
  { provider_id: 'gemini-grounded', profile_id: 'grounded' },
  { provider_id: 'grok', profile_id: 'web' },
];

/** The curated rosters, by workflow. `deep` and `all` are always derived. */
export const CURATED_WORKFLOW_ROSTERS: Readonly<
  Record<'quick' | 'visibility', readonly WorkflowRosterMember[]>
> = {
  quick: QUICK_WORKFLOW_ROSTER,
  visibility: VISIBILITY_WORKFLOW_ROSTER,
};

export interface WorkflowMigrationResult {
  /** Group names rewritten so no user definition shadows a reserved name. */
  readonly groups: Readonly<Record<string, readonly string[]>>;
  readonly notices: readonly PreparationNotice[];
  /** Collisions this helper refuses to resolve destructively. */
  readonly issues: readonly PreparationIssue[];
}

function sortedRecord(
  record: Record<string, readonly string[]>,
): Record<string, readonly string[]> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

/**
 * Rewrite user-defined groups that collide with reserved built-in workflow
 * names to `custom:<name>`. Names that were only ever built-ins and are now
 * removed are not rewritten here -- they simply stop resolving, and
 * `resolveWorkflowSelection` explains that actionably.
 *
 * When both `<name>` and `custom:<name>` already exist, renaming would destroy
 * one of the user's two groups. That case is never resolved by guessing: both
 * definitions are preserved untouched and the collision is reported as an
 * issue for #2558's public config migration to settle. Output is key-sorted, so
 * the result does not depend on the order the groups were declared in.
 */
export function migrateUserWorkflowNames(
  groups: Readonly<Record<string, readonly string[]>>,
): WorkflowMigrationResult {
  const migrated = Object.create(null) as Record<string, readonly string[]>;
  const notices: PreparationNotice[] = [];
  const issues: PreparationIssue[] = [];

  for (const [name, members] of Object.entries(groups)) {
    if (!RESERVED_WORKFLOW_IDS.has(name)) {
      migrated[name] = members;
      continue;
    }

    const renamed = customWorkflowId(name);
    if (Object.hasOwn(groups, renamed)) {
      // Preserve both definitions verbatim; the reserved key keeps resolving to
      // the built-in workflow and `custom:<name>` keeps the user's group.
      migrated[name] = members;
      issues.push({
        code: 'reserved_workflow_name_collision',
        phase: 'migration',
        path: `/groups/${name}`,
        message: `"${name}" is a reserved built-in workflow and "${renamed}" already exists. Rename one of them; Librarium will not overwrite either group.`,
      });
      continue;
    }

    migrated[renamed] = members;
    notices.push({
      code: 'reserved_workflow_name_migrated',
      phase: 'migration',
      path: `/groups/${name}`,
      message: `"${name}" is a reserved built-in workflow. The user-defined group was migrated to "${renamed}".`,
    });
  }

  const compareByPath = (
    left: PreparationNotice,
    right: PreparationNotice,
  ): number => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  return {
    groups: sortedRecord(migrated),
    notices: notices.sort(compareByPath),
    issues: issues.sort(compareByPath),
  };
}

export type WorkflowResolution =
  | { readonly kind: 'builtin'; readonly workflow_id: BuiltinWorkflowId }
  | { readonly kind: 'custom'; readonly group_id: string }
  | { readonly kind: 'unknown'; readonly message: string };

/**
 * Resolve a requested workflow/group name against v2 selection syntax.
 *
 * Only the four reserved names and explicit `custom:<name>` references select
 * anything. A bare custom name is rejected with the correct spelling rather
 * than silently accepted, and removed built-in names reject with their
 * replacement spelled out. Mapping raw storage names belongs to #2558's config
 * migration, not to selection semantics.
 */
export function resolveWorkflowSelection(
  name: string,
  customGroupIds: Iterable<string> = [],
): WorkflowResolution {
  if (RESERVED_WORKFLOW_IDS.has(name)) {
    return { kind: 'builtin', workflow_id: name as BuiltinWorkflowId };
  }

  const custom = new Set(customGroupIds);

  if (isCustomWorkflowId(name)) {
    if (custom.has(name)) return { kind: 'custom', group_id: name };
    return {
      kind: 'unknown',
      message: `Unknown custom group "${name}". Define it in config, or select one of ${BUILTIN_WORKFLOW_IDS.join(', ')}.`,
    };
  }

  const prefixed = customWorkflowId(name);
  if (custom.has(prefixed)) {
    return {
      kind: 'unknown',
      message: `Custom groups must be selected as "${prefixed}", not "${name}".`,
    };
  }

  if (REMOVED_WORKFLOW_ID_SET.has(name)) {
    return {
      kind: 'unknown',
      message: `"${name}" is no longer a built-in workflow. Use one of ${BUILTIN_WORKFLOW_IDS.join(', ')}, or define a group and select it as "${prefixed}".`,
    };
  }

  return {
    kind: 'unknown',
    message: `Unknown workflow "${name}". Built-in workflows are ${BUILTIN_WORKFLOW_IDS.join(', ')}.`,
  };
}
