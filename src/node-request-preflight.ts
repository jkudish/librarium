import { configGroupProvenance } from './core/config.js';
import type { CredentialContext } from './core/credentials.js';
import {
  type PreparationDependencies,
  type PreparedResearchExecution,
  profileIdentityKey,
} from './core/execution-plan.js';
import {
  compileRequest,
  type RequestCompilationInput,
} from './core/request-compilation.js';
import type {
  PreparationIssue,
  PreparationNotice,
} from './core/research-request.js';
import { createNodeCredentialContext } from './node-credentials.js';
import type { Config } from './types.js';

type ProductionRequestInput = Omit<
  RequestCompilationInput,
  | 'authoredGroups'
  | 'credentials'
  | 'assumeCredentialAvailability'
  | 'structuralOnly'
  | 'preparation'
>;

interface DiagnosticCode {
  readonly code: string;
}

const MAX_CODES_PER_KIND = 12;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,79}$/;

function requestPreparation(): PreparationDependencies {
  const counts = new Map<string, number>();
  return {
    clock: { now: () => Date.now() },
    ids: {
      next: (scope) => {
        const count = (counts.get(scope) ?? 0) + 1;
        counts.set(scope, count);
        return `preflight-${scope}-${count}`;
      },
    },
  };
}

function boundedCodes(diagnostics: readonly DiagnosticCode[]): {
  readonly codes: readonly string[];
  readonly total: number;
} {
  const all = [
    ...new Set(
      diagnostics.map(({ code }) =>
        SAFE_CODE.test(code) ? code : 'invalid_diagnostic_code',
      ),
    ),
  ].sort();
  return { codes: all.slice(0, MAX_CODES_PER_KIND), total: diagnostics.length };
}

export function formatRequestDiagnosticCodes(
  kind: 'issues' | 'notices',
  values: readonly DiagnosticCode[],
): string {
  const { codes, total } = boundedCodes(values);
  return `${kind}=${total} ${kind}_codes=${codes.join(',') || 'none'}`;
}

function formatFailure(
  issues: readonly PreparationIssue[],
  notices: readonly PreparationNotice[],
): string {
  const details = issues
    .slice(0, MAX_CODES_PER_KIND)
    .map(
      (issue) => `${issue.path || '/'}: ${sanitizeDiagnostic(issue.message)}`,
    )
    .join(' ');
  return `[librarium] preflight: ${formatRequestDiagnosticCodes('issues', issues)}; ${formatRequestDiagnosticCodes('notices', notices)}${details ? `; ${details}` : ''}`;
}

function sanitizeDiagnostic(message: string): string {
  return Array.from(message)
    .map((character) =>
      character === '\r' || character === '\n' || character === '\t'
        ? ' '
        : character,
    )
    .filter((character) => character >= ' ' && character !== '\u007f')
    .join('')
    .slice(0, 320);
}

/** A safe, terminal ingress rejection. It contains no request or credentials. */
export class RequestPreflightError extends Error {
  readonly issues: readonly PreparationIssue[];
  readonly notices: readonly PreparationNotice[];

  constructor(
    issues: readonly PreparationIssue[],
    notices: readonly PreparationNotice[],
  ) {
    super(formatFailure(issues, notices));
    this.name = 'RequestPreflightError';
    this.issues = issues;
    this.notices = notices;
  }
}

export interface ProductionRequestPreflightDeps {
  /** Test seam. Production defaults to the Node keychain-aware context. */
  createCredentials?: () => CredentialContext;
}

export interface ProductionRequestPreflightResult {
  readonly prepared: PreparedResearchExecution;
  readonly credentials: CredentialContext;
  readonly notices: readonly PreparationNotice[];
  /** Exact legacy adapter ids that may require trusted custom-code loading. */
  readonly admittedAdapterIds: readonly string[];
}

export function legacyPrimaryAdapterIds(
  prepared: PreparedResearchExecution,
): readonly string[] {
  const seen = new Set<string>();
  const adapterIds: string[] = [];
  for (const slot of prepared.request.slots) {
    const identity = slot.primary.identity;
    const key = profileIdentityKey(identity);
    const plan = prepared.profile_plans_by_identity[key];
    if (!plan) {
      throw new RequestPreflightError(
        [
          {
            code: 'request_plan_binding_missing',
            phase: 'compilation',
            path: '/slots',
            message: 'The admitted request is missing an executable binding.',
          },
        ],
        prepared.notices,
      );
    }
    if (!seen.has(plan.binding.adapter_id)) {
      seen.add(plan.binding.adapter_id);
      adapterIds.push(plan.binding.adapter_id);
    }
  }
  return adapterIds;
}

/**
 * Project the canonical fallback reserve onto the v1 dispatcher surface. The
 * legacy dispatcher reads config fallback edges directly, so retaining raw
 * configuration here could execute an omitted or incompatible fallback. A
 * legacy adapter can represent only one edge, therefore retain the first
 * reserve candidate that is eligible for every slot dispatched by that
 * adapter. Ambiguous multi-profile edges are intentionally disabled.
 */
export function projectLegacyExecutionConfig(
  config: Config,
  prepared: PreparedResearchExecution,
): Config {
  const slotIdsByAdapter = new Map<string, string[]>();
  for (const slot of prepared.request.slots) {
    const plan =
      prepared.profile_plans_by_identity[
        profileIdentityKey(slot.primary.identity)
      ];
    if (!plan) continue;
    const slotIds = slotIdsByAdapter.get(plan.binding.adapter_id) ?? [];
    slotIds.push(slot.slot_id);
    slotIdsByAdapter.set(plan.binding.adapter_id, slotIds);
  }

  const primaryAdapterIds = new Set(slotIdsByAdapter.keys());
  const fallbackByPrimaryAdapter = new Map<string, string>();
  for (const [primaryAdapterId, slotIds] of slotIdsByAdapter) {
    for (const candidate of prepared.request.fallback_reserve) {
      if (
        !slotIds.every((slotId) => candidate.eligible_slot_ids.includes(slotId))
      ) {
        continue;
      }
      const plan =
        prepared.profile_plans_by_identity[
          profileIdentityKey(candidate.profile.identity)
        ];
      const fallbackAdapterId = plan?.binding.adapter_id;
      if (
        fallbackAdapterId === undefined ||
        fallbackAdapterId === primaryAdapterId ||
        primaryAdapterIds.has(fallbackAdapterId)
      ) {
        continue;
      }
      fallbackByPrimaryAdapter.set(primaryAdapterId, fallbackAdapterId);
      break;
    }
  }

  const providers: Config['providers'] = {};
  for (const [adapterId, provider] of Object.entries(config.providers)) {
    const { fallback: _rawFallback, ...withoutFallback } = provider;
    const fallback = fallbackByPrimaryAdapter.get(adapterId);
    providers[adapterId] =
      fallback === undefined
        ? withoutFallback
        : { ...withoutFallback, fallback };
  }
  return { ...config, providers };
}

/**
 * Return every adapter admitted by the canonical plan, including reserve-only
 * fallbacks. Initialization must make all of these available before any
 * refinement, artifact creation, or legacy dispatch can begin.
 */
export function admittedAdapterIds(
  prepared: PreparedResearchExecution,
): readonly string[] {
  return [
    ...new Set(
      Object.values(prepared.profile_plans_by_identity).map(
        (plan) => plan.binding.adapter_id,
      ),
    ),
  ];
}

/**
 * The legacy engine remains active during this slice. Its provider-id dispatch
 * receives the canonical plan's stable, unique primary adapter projection.
 */
export function assertLegacySelectionMatchesAdmission(
  prepared: PreparedResearchExecution,
  legacyProviderIds: readonly string[],
): void {
  const expected = new Set(legacyPrimaryAdapterIds(prepared));
  const actual = new Set(legacyProviderIds);
  if (
    expected.size === actual.size &&
    [...expected].every((id) => actual.has(id))
  ) {
    return;
  }
  throw new RequestPreflightError(
    [
      {
        code: 'legacy_selection_drift',
        phase: 'compilation',
        path: '/selector',
        message:
          'Legacy provider selection did not match the admitted exact request.',
      },
    ],
    prepared.notices,
  );
}

/**
 * Factories can still reject a malformed legacy adapter during initialization.
 * Check that every admitted adapter was actually registered before refinement,
 * output creation, or dispatch, while preserving canonical plan selection.
 */
export function assertAdmittedAdaptersRegistered(
  prepared: PreparedResearchExecution,
  registeredAdapterIds: Iterable<string>,
): void {
  const registered = new Set(registeredAdapterIds);
  const missing = admittedAdapterIds(prepared).filter(
    (id) => !registered.has(id),
  );
  if (missing.length === 0) return;
  throw new RequestPreflightError(
    missing.map((id) => ({
      code: 'admitted_adapter_unavailable',
      phase: 'compilation',
      path: '/selector',
      message: `The admitted provider adapter "${id}" did not initialize.`,
    })),
    prepared.notices,
  );
}

function requireCompiled(
  compiled: ReturnType<typeof compileRequest>,
): PreparedResearchExecution {
  if (!compiled.ok) {
    throw new RequestPreflightError(compiled.issues, compiled.notices);
  }
  return compiled.prepared;
}

/**
 * Run the two admission phases required before a production transport may
 * initialize providers. The first phase never constructs a credential context
 * and therefore cannot read the keychain. The second checks credentials after
 * structural admission but still before custom imports, process spawning,
 * refinement, output creation, or any provider request.
 */
export function preflightProductionRequest(
  input: ProductionRequestInput,
  deps: ProductionRequestPreflightDeps = {},
): ProductionRequestPreflightResult {
  const common = {
    ...input,
    authoredGroups: configGroupProvenance(input.config),
  };

  try {
    requireCompiled(
      compileRequest({
        ...common,
        assumeCredentialAvailability: true,
        structuralOnly: true,
        preparation: requestPreparation(),
      }),
    );
  } catch (error) {
    if (error instanceof RequestPreflightError) throw error;
    throw new RequestPreflightError(
      [
        {
          code: 'request_compilation_failed',
          phase: 'compilation',
          path: '',
          message: 'Request compilation failed before execution could start.',
        },
      ],
      [],
    );
  }

  const credentials = (deps.createCredentials ?? createNodeCredentialContext)();
  try {
    const prepared = requireCompiled(
      compileRequest({
        ...common,
        credentials,
        preparation: requestPreparation(),
      }),
    );
    const admittedIds = admittedAdapterIds(prepared);
    return {
      prepared,
      credentials,
      notices: prepared.notices,
      admittedAdapterIds: admittedIds,
    };
  } catch (error) {
    if (error instanceof RequestPreflightError) throw error;
    throw new RequestPreflightError(
      [
        {
          code: 'request_compilation_failed',
          phase: 'compilation',
          path: '',
          message: 'Request compilation failed before execution could start.',
        },
      ],
      [],
    );
  }
}

/** Render optional notices after admission without allowing a broken sink to run work. */
export function emitRequestPreflightNotices(
  notices: readonly PreparationNotice[],
  onWarn: (message: string) => void,
): void {
  if (notices.length === 0) return;
  try {
    onWarn(
      `[librarium] preflight: ${formatRequestDiagnosticCodes('notices', notices)}`,
    );
  } catch {
    // The request is already admitted. Diagnostics cannot change execution.
  }
}
