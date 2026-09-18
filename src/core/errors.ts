import type {
  ProviderFailureDiagnostic,
  ProviderFailureKind,
} from '../types.js';
import {
  HttpRequestAbortedError,
  HttpRequestTimeoutError,
} from './http-client.js';

const DEFINITIVE_SUBMISSION_REJECTION_KINDS = new Map<
  number,
  ProviderFailureKind
>([
  [400, 'invalid_request'],
  [401, 'authentication'],
  [402, 'billing'],
  // A 403 proves rejection, but its provider-specific cause does not.
  [403, 'provider'],
  [404, 'invalid_request'],
  [422, 'invalid_request'],
  [429, 'rate_limit'],
]);

/**
 * Classify only HTTP statuses whose submission semantics are already safe.
 * Unlisted 4xx statuses deliberately omit the code so the canonical bridge
 * cannot infer a definitive rejection from an unfamiliar provider response.
 */
export function diagnosticForSubmissionHttpStatus(
  status: number,
): ProviderFailureDiagnostic {
  const validStatus =
    Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : undefined;
  if (status === 408 || status === 504) {
    return {
      kind: 'timeout',
      ...(validStatus !== undefined && { httpStatus: validStatus }),
    };
  }
  if (status >= 500 && status <= 599) {
    return { kind: 'provider', httpStatus: status };
  }
  const kind = DEFINITIVE_SUBMISSION_REJECTION_KINDS.get(status);
  return kind ? { kind, httpStatus: status } : { kind: 'provider' };
}

/** Classify bounded transport facts without retaining an error message. */
export function diagnosticForSubmissionError(
  error: unknown,
  signal?: AbortSignal,
): ProviderFailureDiagnostic {
  if (
    signal?.aborted ||
    error instanceof HttpRequestAbortedError ||
    error instanceof HttpRequestTimeoutError ||
    (error instanceof DOMException &&
      (error.name === 'AbortError' || error.name === 'TimeoutError'))
  ) {
    return { kind: 'timeout' };
  }
  const detail = error instanceof Error ? error.message : '';
  if (/API key not found/i.test(detail)) return { kind: 'authentication' };
  if (
    error instanceof TypeError ||
    /fetch failed|failed to fetch|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(
      detail,
    )
  ) {
    return { kind: 'network' };
  }
  return { kind: 'provider' };
}

/**
 * Submission failed after entering a provider's billable creation path. The
 * execution runtime must not retry because the remote job may already have
 * been accepted even when no response handle arrived.
 */
export class UnsafeToRetrySubmissionError extends Error {
  readonly failureDiagnostic?: ProviderFailureDiagnostic;

  constructor(message: string, failureDiagnostic?: ProviderFailureDiagnostic) {
    super(message);
    this.name = 'UnsafeToRetrySubmissionError';
    if (failureDiagnostic) this.failureDiagnostic = failureDiagnostic;
  }
}
