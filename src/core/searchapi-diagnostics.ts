import type { ProviderFailureDiagnostic } from '../types.js';
import {
  diagnosticForSubmissionError,
  diagnosticForSubmissionHttpStatus,
} from './errors.js';

// Kept apart from searchapi.ts: provider descriptors import that module's
// options schema, and errors.ts reaches the descriptors through http-client.
/**
 * Safe failure diagnostic for a non-200 SearchAPI response. The status is
 * always kept so the canonical error records the cause as provider_code.
 */
export function searchApiHttpFailureDiagnostic(
  status: number,
): ProviderFailureDiagnostic {
  const { kind } = diagnosticForSubmissionHttpStatus(status);
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? { kind, httpStatus: status }
    : { kind };
}

/** Safe failure diagnostic for a thrown transport error; no message kept. */
export function searchApiErrorFailureDiagnostic(
  error: unknown,
  signal?: AbortSignal,
): ProviderFailureDiagnostic {
  return diagnosticForSubmissionError(error, signal);
}
