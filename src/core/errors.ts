/**
 * Submission failed after entering a provider's billable creation path. The
 * dispatcher must not retry through synchronous execution because the remote
 * job may already have been accepted even when no response handle arrived.
 */
export class UnsafeToRetrySubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeToRetrySubmissionError';
  }
}
