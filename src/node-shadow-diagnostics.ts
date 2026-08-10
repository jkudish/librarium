import { configGroupProvenance } from './core/config.js';
import type { PreparationDependencies } from './core/execution-plan.js';
import type {
  PreparationIssue,
  PreparationNotice,
} from './core/research-request.js';
import {
  compileShadowRequest,
  type ShadowCompilationInput,
} from './core/shadow-compilation.js';

type ProductionShadowDiagnosticInput = Omit<
  ShadowCompilationInput,
  'authoredGroups' | 'credentials' | 'preparation'
> & {
  readonly env?: Readonly<Record<string, string | undefined>>;
};

type Diagnostic = PreparationIssue | PreparationNotice;
type DiagnosticSink = (message: string) => void;

const MAX_CODES_PER_KIND = 12;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,79}$/;

function diagnosticPreparation(): PreparationDependencies {
  const counts = new Map<string, number>();
  return {
    clock: { now: () => 0 },
    ids: {
      next: (scope) => {
        const count = (counts.get(scope) ?? 0) + 1;
        counts.set(scope, count);
        return `shadow-${scope}-${count}`;
      },
    },
  };
}

function boundedCodes(diagnostics: readonly Diagnostic[]): {
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

function codeSummary(
  kind: 'issues' | 'notices',
  values: readonly Diagnostic[],
) {
  const { codes, total } = boundedCodes(values);
  return `${kind}=${total} ${kind}_codes=${codes.join(',') || 'none'}`;
}

function emitSafely(onWarn: DiagnosticSink, message: string): void {
  try {
    onWarn(message);
  } catch {
    // Shadow diagnostics are observational; a broken sink cannot break v1.
  }
}

/** Node-only, fail-open production ingress for the Worker-safe compiler. */
export function emitProductionShadowDiagnostic(
  input: ProductionShadowDiagnosticInput,
  onWarn: DiagnosticSink,
): void {
  try {
    const { env, ...compilerInput } = input;
    const result = compileShadowRequest({
      ...compilerInput,
      authoredGroups: configGroupProvenance(input.config),
      // Credential lookup reads only explicitly requested own keys. The
      // diagnostic never constructs the keychain resolver or custom code.
      credentials: { env },
      preparation: diagnosticPreparation(),
    });
    if (result.ok) {
      if (result.notices.length > 0) {
        emitSafely(
          onWarn,
          `[librarium] shadow: ${codeSummary('notices', result.notices)}`,
        );
      }
      return;
    }
    emitSafely(
      onWarn,
      `[librarium] shadow: ${codeSummary('issues', result.issues)}; ${codeSummary('notices', result.notices)}`,
    );
  } catch {
    emitSafely(onWarn, '[librarium] shadow: diagnostic_failed');
  }
}
