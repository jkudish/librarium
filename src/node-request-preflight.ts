import { configGroupProvenance } from './core/config.js';
import type { CredentialContext } from './core/credentials.js';
import type {
  PreparationDependencies,
  PreparedResearchExecution,
} from './core/execution-plan.js';
import {
  compileRequest,
  type RequestCompilationInput,
} from './core/request-compilation.js';
import type {
  PreparationIssue,
  PreparationNotice,
} from './core/research-request.js';
import { assertResearchResponseProjectableProfile } from './core/research-response-projector.js';
import { createNodeCredentialContext } from './node-credentials.js';

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
  /** Exact admitted adapter ids that may require trusted custom-code loading. */
  readonly admittedAdapterIds: readonly string[];
}

export type StructuralProductionRequestPreflightResult = Omit<
  ProductionRequestPreflightResult,
  'credentials'
>;

/**
 * Return every adapter admitted by the canonical plan, including reserve-only
 * fallbacks. Initialization must make all of these available before any
 * refinement, artifact creation, or canonical execution can begin.
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

/** Reject plans that cannot reach the public terminal contract without touching credentials. */
export function assertPreparedResearchResponseProjectable(
  prepared: PreparedResearchExecution,
): void {
  const profiles = [
    ...prepared.request.slots.map((slot, index) => ({
      profile: slot.primary,
      path: `/slots/${index}/primary`,
    })),
    ...prepared.request.fallback_reserve.map((candidate, index) => ({
      profile: candidate.profile,
      path: `/fallback_reserve/${index}/profile`,
    })),
  ];
  const issues: PreparationIssue[] = [];
  for (const { profile, path } of profiles) {
    try {
      assertResearchResponseProjectableProfile(profile);
    } catch (error) {
      issues.push({
        code: 'profile_not_projectable',
        phase: 'compilation',
        path,
        message:
          error instanceof Error
            ? error.message
            : 'The selected profile cannot reach the terminal response contract.',
      });
    }
  }
  if (issues.length > 0) {
    throw new RequestPreflightError(issues, prepared.notices);
  }
}

/**
 * Factories can still reject a malformed adapter during initialization.
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

/** Validate and compile a request without reading environment or keychain credentials. */
export function preflightProductionRequestStructure(
  input: ProductionRequestInput,
): StructuralProductionRequestPreflightResult {
  const common = {
    ...input,
    authoredGroups: configGroupProvenance(input.config),
  };
  try {
    const prepared = requireCompiled(
      compileRequest({
        ...common,
        assumeCredentialAvailability: true,
        structuralOnly: true,
        preparation: requestPreparation(),
      }),
    );
    assertPreparedResearchResponseProjectable(prepared);
    return {
      prepared,
      notices: prepared.notices,
      admittedAdapterIds: admittedAdapterIds(prepared),
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

  preflightProductionRequestStructure(input);

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
