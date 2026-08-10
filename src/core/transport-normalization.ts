import type { EvidenceRequirements } from '../contracts/interchange/request.js';
import {
  type FrozenPlanningCatalog,
  type PreparationDependencies,
  type PreparedResearchExecution,
  prepareResearchExecution,
} from './execution-plan.js';
import type {
  ExactBudgetLimits,
  FallbackIntent,
  PreparationIssue,
  PreparationNotice,
  ProfileTarget,
  RefinementIntent,
  ResearchExecutionLimits,
} from './research-request.js';
import { sortPreparationDiagnostics } from './research-request.js';

/**
 * Shadow-only transport normalization for the v2 request pipeline
 * (Checkpoint A). Nothing in this module is wired into the production CLI,
 * MCP, or configuration surfaces, and it is not exported from any package
 * entrypoint: it exists so semantically equivalent raw inputs from every
 * transport provably compile to identical PreparedResearchExecution values.
 *
 * One common normalizer owns selector precedence; each source contributes only a thin
 * projection of the Checkpoint A semantic fields (query, mode including
 * legacy mixed, exactly one selector, fallback intent, limits, exact budgets,
 * exclusions, refinement). Presentation, output, and filesystem fields are
 * deliberately out of scope.
 *
 * Canonical defaults are NOT chosen here: no default policy values have been
 * approved, so every normalizer requires an injected
 * CanonicalTransportDefaults context. Selecting the built-in canonical values
 * is an explicit maintainer decision that remains open.
 *
 * Approved selector policy: CLI/MCP/silent-MCP preserve the v1 compatibility
 * rule that explicit providers beat a group and emit a deterministic notice.
 * Library and configuration surfaces reject that ambiguity. A canonical
 * request still always contains exactly one selector.
 */

export type TransportSource =
  | 'library'
  | 'cli'
  | 'mcp'
  | 'configuration'
  | 'silent_mcp';

/** Injected per-caller context; this module ships no default policy values. */
export interface CanonicalTransportDefaults {
  /** `mixed` reaches the existing legacy migration boundary unchanged. */
  readonly mode: 'sync' | 'async' | 'mixed';
  readonly limits: ResearchExecutionLimits;
  readonly fallback: FallbackIntent;
  readonly refinement: RefinementIntent;
  readonly budgets?: ExactBudgetLimits;
}

/** @internal Private two-phase v1 defaults; never a canonical request. */
export interface UnresolvedV1TransportDefaults {
  readonly mode: 'sync' | 'async' | 'mixed';
  readonly limits: Pick<
    ResearchExecutionLimits,
    'max_concurrency' | 'inline_attempt_deadline_ms' | 'poll_interval_ms'
  >;
  readonly fallback: FallbackIntent;
  readonly refinement: RefinementIntent;
  readonly budgets?: ExactBudgetLimits;
}

export type TransportNormalizationResult =
  | {
      readonly ok: true;
      readonly request: Record<string, unknown>;
      readonly notices: readonly PreparationNotice[];
    }
  | {
      readonly ok: false;
      readonly issues: readonly PreparationIssue[];
      readonly notices: readonly PreparationNotice[];
    };

interface CapabilitySelection {
  readonly requirements: EvidenceRequirements;
  readonly result_count?: number;
}

/** A selector value plus the raw-input path it came from on this transport. */
interface SelectorCandidateInput<TValue> {
  readonly value: TValue;
  readonly raw_path: string;
}

interface SelectorCandidates {
  readonly targets?: SelectorCandidateInput<readonly ProfileTarget[]>;
  readonly group?: SelectorCandidateInput<string>;
  readonly capabilities?: SelectorCandidateInput<CapabilitySelection>;
  readonly use_default?: SelectorCandidateInput<boolean>;
}

interface SemanticTransportFields {
  readonly query?: string;
  readonly mode?: string;
  readonly selector: SelectorCandidates;
  readonly fallback?: FallbackIntent;
  readonly limits?: Partial<ResearchExecutionLimits>;
  readonly budgets?: ExactBudgetLimits;
  readonly exclusions?: readonly ProfileTarget[];
  readonly refinement?: RefinementIntent;
}

interface TransportProjection {
  readonly fields: SemanticTransportFields;
  readonly issues?: readonly PreparationIssue[];
}

interface SelectorCandidate {
  readonly name: 'targets' | 'group' | 'capabilities' | 'default';
  readonly rawPath: string;
  readonly selector: Record<string, unknown>;
}

function presentSelectorCandidates(
  candidates: SelectorCandidates,
): SelectorCandidate[] {
  const present: SelectorCandidate[] = [];
  if (candidates.targets !== undefined) {
    present.push({
      name: 'targets',
      rawPath: candidates.targets.raw_path,
      selector: { kind: 'targets', targets: candidates.targets.value },
    });
  }
  if (candidates.group !== undefined) {
    present.push({
      name: 'group',
      rawPath: candidates.group.raw_path,
      selector: { kind: 'group', group_id: candidates.group.value },
    });
  }
  if (candidates.capabilities !== undefined) {
    const capability = candidates.capabilities.value;
    const selector: Record<string, unknown> = {
      kind: 'capabilities',
      requirements: capability.requirements,
    };
    if (capability.result_count !== undefined) {
      selector.result_count = capability.result_count;
    }
    present.push({
      name: 'capabilities',
      rawPath: candidates.capabilities.raw_path,
      selector,
    });
  }
  if (candidates.use_default?.value) {
    present.push({
      name: 'default',
      rawPath: candidates.use_default.raw_path,
      selector: { kind: 'default' },
    });
  }
  return present;
}

function mergeLimits(
  defaults: ResearchExecutionLimits | UnresolvedV1TransportDefaults['limits'],
  overrides: Partial<ResearchExecutionLimits> | undefined,
): Partial<ResearchExecutionLimits> {
  const merged: Partial<ResearchExecutionLimits> = { ...defaults };
  if (!overrides) return merged;
  for (const field of [
    'max_concurrency',
    'request_deadline_ms',
    'inline_attempt_deadline_ms',
    'background_attempt_deadline_ms',
    'poll_interval_ms',
  ] as const) {
    const value = overrides[field];
    if (value !== undefined) merged[field] = value;
  }
  return merged;
}

function normalizeTransportRequest(
  source: TransportSource,
  projection: TransportProjection,
  defaults: CanonicalTransportDefaults | UnresolvedV1TransportDefaults,
): TransportNormalizationResult {
  const issues: PreparationIssue[] = [...(projection.issues ?? [])];
  const notices: PreparationNotice[] = [];
  const fields = projection.fields;

  const present = presentSelectorCandidates(fields.selector);
  let selector: Record<string, unknown>;
  if (present.length === 0) {
    selector = { kind: 'default' };
  } else {
    const [chosen, ...competing] = present;
    selector = chosen.selector;
    const explicitProvidersWin =
      (source === 'cli' || source === 'mcp' || source === 'silent_mcp') &&
      chosen.name === 'targets' &&
      competing.length === 1 &&
      competing[0]?.name === 'group';
    if (explicitProvidersWin) {
      const group = competing[0];
      notices.push({
        code: 'transport_explicit_providers_override_group',
        phase: 'transport',
        path: group.rawPath,
        message: `Explicit providers override the competing group selection for ${source}; the group was ignored.`,
      });
    } else {
      for (const candidate of competing) {
        issues.push({
          code: 'transport_selector_conflict',
          phase: 'transport',
          path: candidate.rawPath,
          message: `The ${candidate.name} selection competes with ${chosen.name}; a canonical request has exactly one selector. Remove one of them from the ${source} input.`,
        });
      }
    }
  }

  if (issues.length > 0) {
    return {
      ok: false,
      issues: sortPreparationDiagnostics(issues),
      notices: sortPreparationDiagnostics(notices),
    };
  }

  const request: Record<string, unknown> = {
    query: fields.query,
    mode: fields.mode ?? defaults.mode,
    selector,
    fallback: fields.fallback ?? defaults.fallback,
    limits: mergeLimits(defaults.limits, fields.limits),
    exclusions: fields.exclusions ?? [],
    refinement: fields.refinement ?? defaults.refinement,
  };
  const budgets = fields.budgets ?? defaults.budgets;
  if (budgets !== undefined) request.budgets = budgets;
  return { ok: true, request, notices: sortPreparationDiagnostics(notices) };
}

/**
 * Shadow orchestration helper: compiles a normalized transport request and
 * merges the transport notices with the preparation notices so migration
 * information never disappears between normalization and compilation. The
 * PreparedResearchExecution itself is untouched, which keeps byte-for-byte
 * plan equality independent of transport-specific notices.
 */
export type ShadowTransportCompilation =
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

export function compileNormalizedTransportRequest(
  normalized: TransportNormalizationResult,
  catalog: FrozenPlanningCatalog,
  dependencies: PreparationDependencies,
): ShadowTransportCompilation {
  if (!normalized.ok) {
    return {
      ok: false,
      issues: normalized.issues,
      notices: normalized.notices,
    };
  }
  const result = prepareResearchExecution(
    normalized.request,
    catalog,
    dependencies,
  );
  const notices = sortPreparationDiagnostics([
    ...normalized.notices,
    ...result.notices,
  ]);
  return result.ok
    ? { ok: true, prepared: result.prepared, notices }
    : { ok: false, issues: result.issues, notices };
}

/**
 * Exact USD → micro-USD conversion with no floating-point arithmetic: the
 * decimal rendering of the number is shifted six places. Values that cannot be
 * represented exactly (exponent renderings, more than six decimal places,
 * negatives, non-finite) are rejected with a stable issue instead of rounded.
 */
function exactMicrousdFromUsd(
  value: number,
  path: string,
): { readonly value: string } | { readonly issue: PreparationIssue } {
  const reject = (reason: string): { readonly issue: PreparationIssue } => ({
    issue: {
      code: 'transport_budget_not_exact',
      phase: 'transport',
      path,
      message: `USD budgets must convert exactly to micro-USD: ${reason}`,
    },
  });
  if (!Number.isFinite(value) || value < 0) {
    return reject('the value must be a finite non-negative number.');
  }
  const text = String(value);
  if (text.includes('e') || text.includes('E')) {
    return reject('the value is too large or small for exact conversion.');
  }
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > 6) {
    return reject('at most six decimal places (one micro-USD) are supported.');
  }
  const shifted = `${whole}${fraction.padEnd(6, '0')}`.replace(/^0+(?=\d)/, '');
  return { value: shifted };
}

function targetsFromProviderIds(
  providerIds: readonly string[] | undefined,
  path: string,
  issues: PreparationIssue[],
): SelectorCandidateInput<readonly ProfileTarget[]> | undefined {
  if (providerIds === undefined) return undefined;
  const targets = providerIds
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => ({ provider_id: token }));
  if (targets.length === 0) {
    // Mirrors v1: provided-but-empty is a caller mistake, not a fallthrough
    // to the default selection (see resolveProviderSelection).
    issues.push({
      code: 'transport_empty_provider_selection',
      phase: 'transport',
      path,
      message:
        'A provider selection was given but contains no usable provider ids. Omit it to use the default selection or pass at least one id.',
    });
    return undefined;
  }
  return { value: targets, raw_path: path };
}

/**
 * Keep raw provider-token handling intact for existing ingress callers while
 * allowing the private configuration compiler to hand over exact catalog
 * identities. The two lanes are deliberately mutually exclusive: accepting
 * both would make the selected strategy dependent on undocumented precedence.
 */
function targetsFromRawOrExactTargets(
  providerIds: readonly string[] | undefined,
  exactTargets: readonly ProfileTarget[] | undefined,
  issues: PreparationIssue[],
): SelectorCandidateInput<readonly ProfileTarget[]> | undefined {
  if (providerIds !== undefined && exactTargets !== undefined) {
    issues.push({
      code: 'transport_raw_and_exact_targets_conflict',
      phase: 'transport',
      path: '/providers',
      message:
        'Raw provider tokens and exact resolved targets cannot be supplied together. Supply exactly one selection form.',
    });
    return undefined;
  }
  if (exactTargets !== undefined) {
    // The exact lane is an internal replacement for this transport's raw
    // provider tokens, so keep all later selector diagnostics at the public
    // ingress path rather than exposing the private implementation detail.
    return { value: exactTargets, raw_path: '/providers' };
  }
  return targetsFromProviderIds(providerIds, '/providers', issues);
}

export function exactUsdBudgets(
  maxCostUsd: number | undefined,
  maxEstimatedCostUsd: number | undefined,
  pathPrefix: string,
): {
  readonly budgets?: ExactBudgetLimits;
  readonly issues: readonly PreparationIssue[];
} {
  const issues: PreparationIssue[] = [];
  const budgets: {
    max_estimated_cost_microusd?: string;
    max_actual_cost_microusd?: string;
  } = {};
  if (maxEstimatedCostUsd !== undefined) {
    const converted = exactMicrousdFromUsd(
      maxEstimatedCostUsd,
      `${pathPrefix}/maxEstimatedCostUsd`,
    );
    if ('issue' in converted) issues.push(converted.issue);
    else budgets.max_estimated_cost_microusd = converted.value;
  }
  if (maxCostUsd !== undefined) {
    const converted = exactMicrousdFromUsd(
      maxCostUsd,
      `${pathPrefix}/maxCostUsd`,
    );
    if ('issue' in converted) issues.push(converted.issue);
    else budgets.max_actual_cost_microusd = converted.value;
  }
  return {
    ...(budgets.max_estimated_cost_microusd !== undefined ||
    budgets.max_actual_cost_microusd !== undefined
      ? { budgets }
      : {}),
    issues,
  };
}

function usdBudgets(
  maxCostUsd: number | undefined,
  maxEstimatedCostUsd: number | undefined,
  pathPrefix: string,
  issues: PreparationIssue[],
): ExactBudgetLimits | undefined {
  const result = exactUsdBudgets(maxCostUsd, maxEstimatedCostUsd, pathPrefix);
  issues.push(...result.issues);
  return result.budgets;
}

function toggleIntent<TIntent>(
  flag: boolean | undefined,
  enabled: TIntent,
  disabled: TIntent,
): TIntent | undefined {
  if (flag === undefined) return undefined;
  return flag ? enabled : disabled;
}

/** Programmatic (library) callers submit near-canonical semantic fields. */
export interface LibraryTransportInput {
  readonly query?: string;
  readonly mode?: string;
  readonly targets?: readonly ProfileTarget[];
  readonly group?: string;
  readonly capabilities?: CapabilitySelection;
  readonly useDefaultSelection?: boolean;
  readonly fallback?: FallbackIntent;
  readonly limits?: Partial<ResearchExecutionLimits>;
  readonly budgets?: ExactBudgetLimits;
  readonly exclusions?: readonly ProfileTarget[];
  readonly refinement?: RefinementIntent;
}

export function normalizeLibraryRequest(
  input: LibraryTransportInput,
  defaults: CanonicalTransportDefaults,
): TransportNormalizationResult {
  return normalizeTransportRequest(
    'library',
    {
      fields: {
        query: input.query,
        mode: input.mode,
        selector: {
          targets:
            input.targets === undefined
              ? undefined
              : { value: input.targets, raw_path: '/targets' },
          group:
            input.group === undefined
              ? undefined
              : { value: input.group, raw_path: '/group' },
          capabilities:
            input.capabilities === undefined
              ? undefined
              : { value: input.capabilities, raw_path: '/capabilities' },
          use_default:
            input.useDefaultSelection === undefined
              ? undefined
              : {
                  value: input.useDefaultSelection,
                  raw_path: '/useDefaultSelection',
                },
        },
        fallback: input.fallback,
        limits: input.limits,
        budgets: input.budgets,
        exclusions: input.exclusions,
        refinement: input.refinement,
      },
    },
    defaults,
  );
}

/** Mirrors the `librarium run` flag vocabulary (comma-split -p, seconds, USD). */
export interface CliTransportInput {
  readonly query?: string;
  readonly providers?: readonly string[];
  /**
   * Private compiler lane for already-resolved catalog targets. Public CLI
   * callers continue to use `providers`; passing both is rejected so a raw
   * token can never silently win over an exact target.
   */
  readonly exactTargets?: readonly ProfileTarget[];
  readonly group?: string;
  readonly mode?: string;
  readonly parallel?: number;
  readonly timeoutSeconds?: number;
  readonly maxCostUsd?: number;
  readonly maxEstimatedCostUsd?: number;
  readonly fallback?: boolean;
  readonly refine?: boolean;
}

export function normalizeCliRequest(
  input: CliTransportInput,
  defaults: CanonicalTransportDefaults,
): TransportNormalizationResult {
  return normalizeTransportRequest('cli', cliProjection(input), defaults);
}

function cliProjection(input: CliTransportInput): TransportProjection {
  const issues: PreparationIssue[] = [];
  const limits: Partial<ResearchExecutionLimits> = {};
  if (input.parallel !== undefined) limits.max_concurrency = input.parallel;
  if (input.timeoutSeconds !== undefined) {
    limits.inline_attempt_deadline_ms = input.timeoutSeconds * 1_000;
  }
  return {
    fields: {
      query: input.query,
      mode: input.mode,
      selector: {
        targets: targetsFromRawOrExactTargets(
          input.providers,
          input.exactTargets,
          issues,
        ),
        group:
          input.group === undefined
            ? undefined
            : { value: input.group, raw_path: '/group' },
      },
      fallback: toggleIntent<FallbackIntent>(
        input.fallback,
        { kind: 'configured' },
        { kind: 'disabled' },
      ),
      limits,
      budgets: usdBudgets(
        input.maxCostUsd,
        input.maxEstimatedCostUsd,
        '',
        issues,
      ),
      refinement: toggleIntent<RefinementIntent>(
        input.refine,
        { kind: 'requested' },
        { kind: 'disabled' },
      ),
    },
    issues,
  };
}

/** @internal Shadow-only normalization with deliberately unresolved limits. */
export function normalizeCliRequestUnresolved(
  input: CliTransportInput,
  defaults: UnresolvedV1TransportDefaults,
): TransportNormalizationResult {
  return normalizeTransportRequest('cli', cliProjection(input), defaults);
}

/** Mirrors the MCP `research` tool arguments (and the silent pipeline args). */
export interface McpTransportInput {
  readonly query?: string;
  readonly providers?: readonly string[];
  /** See CliTransportInput.exactTargets. */
  readonly exactTargets?: readonly ProfileTarget[];
  readonly group?: string;
  readonly mode?: string;
  readonly refine?: boolean;
}

function mcpProjection(input: McpTransportInput): TransportProjection {
  const issues: PreparationIssue[] = [];
  return {
    fields: {
      query: input.query,
      mode: input.mode,
      selector: {
        targets: targetsFromRawOrExactTargets(
          input.providers,
          input.exactTargets,
          issues,
        ),
        group:
          input.group === undefined
            ? undefined
            : { value: input.group, raw_path: '/group' },
      },
      refinement: toggleIntent<RefinementIntent>(
        input.refine,
        { kind: 'requested' },
        { kind: 'disabled' },
      ),
    },
    issues,
  };
}

export function normalizeMcpRequest(
  input: McpTransportInput,
  defaults: CanonicalTransportDefaults,
): TransportNormalizationResult {
  return normalizeTransportRequest('mcp', mcpProjection(input), defaults);
}

/** @internal Shadow-only normalization with deliberately unresolved limits. */
export function normalizeMcpRequestUnresolved(
  input: McpTransportInput,
  defaults: UnresolvedV1TransportDefaults,
): TransportNormalizationResult {
  return normalizeTransportRequest('mcp', mcpProjection(input), defaults);
}

export function normalizeSilentMcpRequest(
  input: McpTransportInput,
  defaults: CanonicalTransportDefaults,
): TransportNormalizationResult {
  return normalizeTransportRequest(
    'silent_mcp',
    mcpProjection(input),
    defaults,
  );
}

/** @internal Shadow-only normalization with deliberately unresolved limits. */
export function normalizeSilentMcpRequestUnresolved(
  input: McpTransportInput,
  defaults: UnresolvedV1TransportDefaults,
): TransportNormalizationResult {
  return normalizeTransportRequest(
    'silent_mcp',
    mcpProjection(input),
    defaults,
  );
}

/** Mirrors the config-file `defaults` block plus a declarative selection. */
export interface ConfigurationTransportInput {
  readonly query?: string;
  readonly providers?: readonly string[];
  readonly group?: string;
  readonly defaults?: {
    readonly mode?: string;
    readonly maxParallel?: number;
    /** v1 inline per-attempt deadline, in seconds. */
    readonly timeout?: number;
    /** v1 background per-attempt deadline, in seconds. */
    readonly asyncTimeout?: number;
    /** v1 background poll interval, in seconds. */
    readonly asyncPollInterval?: number;
    /** Explicit caller-provided canonical request deadline, in milliseconds. */
    readonly requestDeadlineMs?: number;
    /** @deprecated shadow compatibility spelling; prefer timeout. */
    readonly timeoutSeconds?: number;
    /** @deprecated shadow compatibility spelling; prefer asyncTimeout. */
    readonly backgroundTimeoutSeconds?: number;
    /** @deprecated shadow compatibility spelling; prefer requestDeadlineMs. */
    readonly requestTimeoutSeconds?: number;
    /** @deprecated shadow compatibility spelling; prefer asyncPollInterval. */
    readonly pollIntervalSeconds?: number;
    readonly maxCostUsd?: number;
    readonly maxEstimatedCostUsd?: number;
  };
}

export function normalizeConfigurationRequest(
  input: ConfigurationTransportInput,
  defaults: CanonicalTransportDefaults,
): TransportNormalizationResult {
  const issues: PreparationIssue[] = [];
  const configured = input.defaults ?? {};
  const limits: Partial<ResearchExecutionLimits> = {};
  if (configured.maxParallel !== undefined) {
    limits.max_concurrency = configured.maxParallel;
  }
  const timeout = configured.timeout ?? configured.timeoutSeconds;
  if (timeout !== undefined) {
    limits.inline_attempt_deadline_ms = timeout * 1_000;
  }
  const backgroundTimeout =
    configured.asyncTimeout ?? configured.backgroundTimeoutSeconds;
  if (backgroundTimeout !== undefined) {
    limits.background_attempt_deadline_ms = backgroundTimeout * 1_000;
  }
  if (configured.requestDeadlineMs !== undefined) {
    limits.request_deadline_ms = configured.requestDeadlineMs;
  } else if (configured.requestTimeoutSeconds !== undefined) {
    limits.request_deadline_ms = configured.requestTimeoutSeconds * 1_000;
  }
  const pollInterval =
    configured.asyncPollInterval ?? configured.pollIntervalSeconds;
  if (pollInterval !== undefined) {
    limits.poll_interval_ms = pollInterval * 1_000;
  }
  return normalizeTransportRequest(
    'configuration',
    {
      fields: {
        query: input.query,
        mode: configured.mode,
        selector: {
          targets: targetsFromProviderIds(
            input.providers,
            '/providers',
            issues,
          ),
          group:
            input.group === undefined
              ? undefined
              : { value: input.group, raw_path: '/group' },
        },
        limits,
        budgets: usdBudgets(
          configured.maxCostUsd,
          configured.maxEstimatedCostUsd,
          '/defaults',
          issues,
        ),
      },
      issues,
    },
    defaults,
  );
}
