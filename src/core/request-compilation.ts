import type { Config } from '../types.js';
import {
  REMOVED_BUILTIN_WORKFLOW_IDS,
  resolveWorkflowSelection,
} from './builtin-workflows.js';
import {
  type AuthoredGroupProvenance,
  mapConfiguration,
  resolveConfigurationProfileToken,
} from './configuration-mapping.js';
import type { CredentialContext } from './credentials.js';
import type {
  PreparationDependencies,
  PreparedResearchExecution,
} from './execution-plan.js';
import {
  admitUnresolvedV1ResearchExecution,
  materializeResearchExecution,
} from './execution-plan.js';
import type { CustomCatalogProfile } from './profile-catalog.js';
import { deriveV1RequestDeadline } from './request-deadline-migration.js';
import type {
  PreparationIssue,
  PreparationNotice,
  ProfileTarget,
} from './research-request.js';
import {
  RESEARCH_REQUEST_LIMITS,
  sortPreparationDiagnostics,
} from './research-request.js';
import { RESERVED_BUILTIN_PROVIDER_IDS } from './reserved-provider-ids.js';
import {
  type CliTransportInput,
  type McpTransportInput,
  normalizeCliRequestUnresolved,
  normalizeMcpRequestUnresolved,
  normalizeSilentMcpRequestUnresolved,
  type TransportNormalizationResult,
  type UnresolvedV1TransportDefaults,
} from './transport-normalization.js';

/**
 * Worker-safe ingress shapes shared by production preflight and compiler
 * tests. The compiler owns mapping, exact target resolution, normalization,
 * and admission. Node transports own runtime setup only after this function
 * has admitted the request.
 */
type RawCliTransportInput = Omit<CliTransportInput, 'exactTargets'>;
type RawMcpTransportInput = Omit<McpTransportInput, 'exactTargets'>;

export type RequestCompilationTransport =
  | { readonly kind: 'cli'; readonly input: RawCliTransportInput }
  | { readonly kind: 'mcp'; readonly input: RawMcpTransportInput }
  | { readonly kind: 'silent_mcp'; readonly input: RawMcpTransportInput };

export interface RequestCompilationInput {
  /** An already schema-validated merged v1 configuration. */
  readonly config: Config;
  /** Preserves which group spellings were explicitly authored. */
  readonly authoredGroups: AuthoredGroupProvenance;
  /** Runtime credential view used by compiler tests and non-production callers. */
  readonly credentials?: CredentialContext;
  /**
   * Admit against opaque credential references without reading their values.
   * Node transports still verify credentials before legacy dispatch.
   */
  readonly assumeCredentialAvailability?: boolean;
  /**
   * Validate mapping, selector, and request structure without making
   * credential-dependent mode admission decisions. Production uses this only
   * for the first half of its two-phase ingress gate.
   */
  readonly structuralOnly?: boolean;
  /** Optional explicit total; otherwise the exact selected plan derives it. */
  readonly requestDeadlineMs?: number;
  readonly transport: RequestCompilationTransport;
  readonly preparation: PreparationDependencies;
}

export type RequestCompilationResult =
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

interface ResolvedProviderTokens {
  readonly targets: readonly ProfileTarget[];
  readonly notices: readonly PreparationNotice[];
  readonly issues: readonly PreparationIssue[];
}

function resolveProviderTokens(
  tokens: readonly string[] | undefined,
  missingCustomProviderIds: ReadonlySet<string>,
  customProfiles: readonly CustomCatalogProfile[],
): ResolvedProviderTokens {
  if (tokens === undefined) return { targets: [], notices: [], issues: [] };

  const targets: ProfileTarget[] = [];
  const notices: PreparationNotice[] = [];
  const issues: PreparationIssue[] = [];
  const seen = new Set<string>();

  const nonBlankTokens = tokens
    .map((token, index) => ({ token: token.trim(), index }))
    .filter(({ token }) => token.length > 0);
  if (nonBlankTokens.length === 0) {
    issues.push({
      code: 'transport_empty_provider_selection',
      phase: 'transport',
      path: '/providers',
      message:
        'A provider selection was given but contains no usable provider ids. Omit it to use the default selection or pass at least one id.',
    });
    return { targets, notices, issues };
  }

  for (const { index, token } of nonBlankTokens) {
    const path = `/providers/${index}`;
    if (missingCustomProviderIds.has(token)) {
      issues.push({
        code: 'custom_provider_profile_missing',
        phase: 'migration',
        path,
        message:
          'This trusted enabled custom provider has no execution-profile metadata, so request compilation cannot plan it safely.',
      });
      continue;
    }
    const resolution = resolveConfigurationProfileToken(token, customProfiles);
    if (resolution.kind === 'retired') {
      issues.push({
        code: 'request_provider_token_retired',
        phase: 'transport',
        path,
        message: `Provider "${resolution.token}" was removed; use "${resolution.replacement}".`,
      });
      continue;
    }
    if (resolution.kind === 'unknown') {
      issues.push({
        code: 'request_provider_token_unknown',
        phase: 'migration',
        path,
        message:
          'The provider token does not resolve to an implemented exact provider profile.',
      });
      continue;
    }
    if (resolution.kind === 'ambiguous') {
      issues.push({
        code: 'request_provider_token_ambiguous',
        phase: 'migration',
        path,
        message:
          'The provider token resolves to multiple profiles. Use an exact adapter id or qualified "provider/profile" reference.',
      });
      continue;
    }
    if (resolution.alias) {
      notices.push({
        code: 'configuration_provider_alias_migrated',
        phase: 'migration',
        path,
        message: 'A retired provider alias was migrated to its exact profile.',
        profile_key: `${resolution.target.provider_id}/${resolution.target.profile_id}`,
      });
    }
    const key = `${resolution.target.provider_id}/${resolution.target.profile_id}`;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(resolution.target);
    }
  }
  return { targets, notices, issues };
}

function canonicalGroup(
  group: string | undefined,
  aliases: Readonly<Record<string, string>>,
): {
  readonly group: string | undefined;
  readonly notices: readonly PreparationNotice[];
} {
  if (group === undefined) return { group, notices: [] };
  const token = group.trim();
  if (!Object.hasOwn(aliases, token)) return { group: token, notices: [] };
  const migrated = aliases[token]!;
  return {
    group: migrated,
    notices: [
      {
        code: 'configuration_group_alias_migrated',
        phase: 'migration',
        path: '/group',
        message:
          'The authored group name was migrated to its exact catalog group id.',
      },
    ],
  };
}

function groupSelectionDiagnostics(
  group: string | undefined,
  customGroupIds: readonly string[],
): readonly PreparationIssue[] {
  if (group === undefined) return [];
  if (group.length === 0) {
    return [
      {
        code: 'request_group_blank',
        phase: 'migration',
        path: '/group',
        message: 'A group selection must not be blank.',
      },
    ];
  }
  const selection = resolveWorkflowSelection(group, customGroupIds);
  if (selection.kind !== 'unknown') return [];
  return [
    {
      code: REMOVED_BUILTIN_WORKFLOW_IDS.includes(group)
        ? 'request_group_removed'
        : 'request_group_unknown',
      phase: 'migration',
      path: '/group',
      message: selection.message,
    },
  ];
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function customProviderIssues(
  config: Config,
  transport: RequestCompilationTransport,
  canonicalGroupId: string | undefined,
): readonly PreparationIssue[] {
  const configured = missingCustomProviderIds(config);
  if (configured.length === 0) return [];

  const rawProviders = transport.input.providers;
  const relevant =
    rawProviders !== undefined
      ? []
      : canonicalGroupId === undefined
        ? configured
        : configured.filter((id) => {
            const rawGroupId = canonicalGroupId.replace(/^custom:/, '');
            const members = Object.hasOwn(config.groups, canonicalGroupId)
              ? config.groups[canonicalGroupId]
              : Object.hasOwn(config.groups, rawGroupId)
                ? config.groups[rawGroupId]
                : undefined;
            return members?.includes(id) === true;
          });
  return relevant.map((id) => ({
    code: 'custom_provider_profile_missing',
    phase: 'migration',
    path:
      rawProviders !== undefined
        ? `/providers/${rawProviders.findIndex((token) => token.trim() === id)}`
        : canonicalGroupId === undefined
          ? `/customProviders/${escapePointerSegment(id)}`
          : '/group',
    message:
      'This trusted enabled custom provider has no execution-profile metadata, so request compilation cannot plan it safely.',
  }));
}

function missingCustomProviderIds(config: Config): readonly string[] {
  const trusted = new Set(config.trustedProviderIds);
  return Object.keys(config.customProviders).filter(
    (id) =>
      !RESERVED_BUILTIN_PROVIDER_IDS.has(id) &&
      trusted.has(id) &&
      Object.hasOwn(config.providers, id) &&
      config.providers[id]?.enabled === true &&
      config.customProviders[id]?.executionProfile === undefined,
  );
}

function exactTargetSmugglingIssues(
  transport: RequestCompilationTransport,
): readonly PreparationIssue[] {
  if (!Object.hasOwn(transport.input, 'exactTargets')) return [];
  return [
    {
      code: 'request_exact_targets_not_allowed',
      phase: 'transport',
      path: '/providers',
      message:
        'Raw request ingress cannot supply pre-resolved exact targets. Use provider tokens so configuration canonicalization remains authoritative.',
    },
  ];
}

function collisionGroupDiagnostics(
  group: string | undefined,
  issues: readonly PreparationIssue[],
): readonly PreparationIssue[] {
  if (
    group === undefined ||
    !issues.some(
      (issue) =>
        (issue.code === 'reserved_workflow_name_collision' ||
          issue.code === 'custom_group_name_collision') &&
        issue.path === `/groups/${group}`,
    )
  ) {
    return [];
  }
  return [
    {
      code: 'request_group_collision',
      phase: 'migration',
      path: '/group',
      message:
        'The requested group has a configuration naming collision and cannot be selected safely.',
    },
  ];
}

function normalizeTransport(
  transport: RequestCompilationTransport,
  defaults: UnresolvedV1TransportDefaults,
  targets: readonly ProfileTarget[] | undefined,
  group: string | undefined,
): TransportNormalizationResult {
  switch (transport.kind) {
    case 'cli': {
      const projected: CliTransportInput = {
        query: transport.input.query,
        mode: transport.input.mode,
        parallel: transport.input.parallel,
        timeoutSeconds: transport.input.timeoutSeconds,
        maxCostUsd: transport.input.maxCostUsd,
        maxEstimatedCostUsd: transport.input.maxEstimatedCostUsd,
        fallback: transport.input.fallback,
        refine: transport.input.refine,
        ...(targets !== undefined && { exactTargets: targets }),
        ...(group !== undefined && { group }),
      };
      return normalizeCliRequestUnresolved(projected, defaults);
    }
    case 'mcp': {
      const projected: McpTransportInput = {
        query: transport.input.query,
        mode: transport.input.mode,
        refine: transport.input.refine,
        ...(targets !== undefined && { exactTargets: targets }),
        ...(group !== undefined && { group }),
      };
      return normalizeMcpRequestUnresolved(projected, defaults);
    }
    case 'silent_mcp': {
      const projected: McpTransportInput = {
        query: transport.input.query,
        mode: transport.input.mode,
        refine: transport.input.refine,
        ...(targets !== undefined && { exactTargets: targets }),
        ...(group !== undefined && { group }),
      };
      return normalizeSilentMcpRequestUnresolved(projected, defaults);
    }
  }
}

/**
 * Compile a v1 configuration plus one transport-shaped input without touching
 * runtime execution, stores, bridges, files, imports, registries, credentials,
 * or network.
 */
export function compileRequest(
  input: RequestCompilationInput,
): RequestCompilationResult {
  const rawGroup = input.transport.input.group?.trim();
  const mapped = mapConfiguration(input.config, {
    authoredGroups: input.authoredGroups,
    ...(input.credentials && { credentials: input.credentials }),
    ...(input.assumeCredentialAvailability && {
      assumeCredentialAvailability: true,
    }),
    ...(input.requestDeadlineMs !== undefined && {
      requestDeadlineMs: input.requestDeadlineMs,
    }),
  });
  const mapperNotices = mapped.preflight.notices;
  const mapperIssues = mapped.preflight.issues;

  // Mapping is the gate: neither token conversion nor transport normalization
  // may run until collisions, catalog facts, and deadline policy are sound.
  if (
    mapperIssues.length > 0 ||
    mapped.deadline_migration === undefined ||
    mapped.unresolved_transport_defaults === undefined
  ) {
    return {
      ok: false,
      issues: sortPreparationDiagnostics([
        ...mapperIssues,
        ...collisionGroupDiagnostics(rawGroup, mapperIssues),
      ]),
      notices: sortPreparationDiagnostics(mapperNotices),
    };
  }

  const smugglingIssues = exactTargetSmugglingIssues(input.transport);
  if (smugglingIssues.length > 0) {
    return {
      ok: false,
      issues: sortPreparationDiagnostics(smugglingIssues),
      notices: sortPreparationDiagnostics(mapperNotices),
    };
  }

  const group = canonicalGroup(
    input.transport.input.group,
    mapped.group_aliases,
  );
  const rawProviders = input.transport.input.providers;
  // Providers own CLI/MCP selector precedence, so a competing group is
  // intentionally ignored rather than independently migrated.
  const effectiveGroupNotices =
    rawProviders === undefined ? group.notices : ([] as const);
  const resolved = resolveProviderTokens(
    rawProviders,
    new Set(missingCustomProviderIds(input.config)),
    mapped.custom_profile_bindings,
  );
  // A supplied provider selection owns selector precedence, even when its
  // tokens are invalid. Its error should not be obscured by an ignored group.
  const groupIssues =
    rawProviders === undefined
      ? groupSelectionDiagnostics(group.group, mapped.catalog.custom_group_ids)
      : [];
  const relevantCustomIssues = customProviderIssues(
    input.config,
    input.transport,
    group.group,
  );
  if (
    resolved.issues.length > 0 ||
    groupIssues.length > 0 ||
    relevantCustomIssues.length > 0
  ) {
    return {
      ok: false,
      issues: sortPreparationDiagnostics([
        ...resolved.issues,
        ...groupIssues,
        ...relevantCustomIssues,
      ]),
      notices: sortPreparationDiagnostics([
        ...mapperNotices,
        ...effectiveGroupNotices,
        ...resolved.notices,
      ]),
    };
  }

  const normalized = normalizeTransport(
    input.transport,
    mapped.unresolved_transport_defaults,
    rawProviders === undefined ? undefined : resolved.targets,
    group.group,
  );
  if (!normalized.ok) {
    return {
      ok: false,
      issues: normalized.issues,
      notices: sortPreparationDiagnostics([
        ...mapperNotices,
        ...effectiveGroupNotices,
        ...resolved.notices,
        ...normalized.notices,
      ]),
    };
  }

  const normalizedMode = normalized.request.mode;
  const canDeferModeAdmission =
    normalizedMode === 'sync' ||
    normalizedMode === 'async' ||
    normalizedMode === 'mixed';
  const admissionInput =
    input.structuralOnly && canDeferModeAdmission
      ? {
          ...normalized.request,
          mode: 'sync' as const,
          // Selection-dependent estimate coverage must wait for the
          // credential-aware pass, which may omit unavailable default/group
          // profiles. Mapping has already validated budget syntax and bounds.
          budgets: undefined,
        }
      : normalized.request;
  const admitted = admitUnresolvedV1ResearchExecution(
    admissionInput,
    mapped.catalog,
  );
  if (!admitted.ok) {
    return {
      ok: false,
      issues: admitted.issues,
      notices: sortPreparationDiagnostics([
        ...mapperNotices,
        ...effectiveGroupNotices,
        ...resolved.notices,
        ...normalized.notices,
        ...admitted.notices,
      ]),
    };
  }

  if (input.structuralOnly) {
    // The first production pass establishes only structural validity. Its
    // provisional plan includes credential-opaque default/group profiles, so
    // it must not derive selection-dependent deadlines or exact budgets. The
    // maximal request deadline keeps materialization schema-valid while the
    // credential-aware pass computes the executable plan's real limits.
    const compiled = materializeResearchExecution(
      admitted.admission,
      {
        max_concurrency: admitted.unresolved_limits.max_concurrency,
        request_deadline_ms: RESEARCH_REQUEST_LIMITS.maxDeadlineMs,
        inline_attempt_deadline_ms:
          admitted.unresolved_limits.inline_attempt_deadline_ms,
        background_attempt_deadline_ms:
          mapped.deadline_migration.raw_background_attempt_deadline_ms,
        poll_interval_ms: admitted.unresolved_limits.poll_interval_ms,
      },
      input.preparation,
    );
    const notices = sortPreparationDiagnostics([
      ...mapperNotices,
      ...effectiveGroupNotices,
      ...resolved.notices,
      ...normalized.notices,
      ...compiled.notices,
    ]);
    return compiled.ok
      ? { ok: true, prepared: compiled.prepared, notices }
      : {
          ok: false,
          issues: sortPreparationDiagnostics(compiled.issues),
          notices,
        };
  }

  const unresolvedMode = normalized.request.mode;
  const derived = deriveV1RequestDeadline(
    {
      ...mapped.deadline_migration,
      max_parallel: admitted.unresolved_limits.max_concurrency,
      inline_attempt_deadline_ms:
        admitted.unresolved_limits.inline_attempt_deadline_ms,
      poll_interval_ms: admitted.unresolved_limits.poll_interval_ms,
      legacy_mode:
        unresolvedMode === 'mixed' ? 'mixed' : admitted.admission.request.mode,
    },
    admitted.admission,
  );
  if (!derived.ok) {
    return {
      ok: false,
      issues: derived.issues,
      notices: sortPreparationDiagnostics([
        ...mapperNotices,
        ...effectiveGroupNotices,
        ...resolved.notices,
        ...normalized.notices,
        ...admitted.notices,
        ...derived.notices,
      ]),
    };
  }

  const compiled = materializeResearchExecution(
    admitted.admission,
    {
      max_concurrency: admitted.unresolved_limits.max_concurrency,
      request_deadline_ms: derived.request_deadline_ms,
      inline_attempt_deadline_ms:
        admitted.unresolved_limits.inline_attempt_deadline_ms,
      background_attempt_deadline_ms:
        derived.effective_background_attempt_deadline_ms,
      poll_interval_ms: admitted.unresolved_limits.poll_interval_ms,
    },
    input.preparation,
  );
  const notices = sortPreparationDiagnostics([
    ...mapperNotices,
    ...effectiveGroupNotices,
    ...resolved.notices,
    ...normalized.notices,
    ...derived.notices,
    ...compiled.notices,
  ]);
  return compiled.ok
    ? { ok: true, prepared: compiled.prepared, notices }
    : {
        ok: false,
        issues: sortPreparationDiagnostics(compiled.issues),
        notices,
      };
}
