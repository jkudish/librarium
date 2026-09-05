/**
 * Submission failed after entering a provider's billable creation path. The
 * execution runtime must not retry because the remote job may already have
 * been accepted even when no response handle arrived.
 */
export class UnsafeToRetrySubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeToRetrySubmissionError';
  }
}
