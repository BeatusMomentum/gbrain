import { OperationError } from '../../src/core/ops/contract.ts';

const MAX_ADMISSION_ATTEMPTS = 3;
const ADMISSION_RETRY_BACKOFF_MS = 25;

/**
 * Retry an admission whose contention outlasted the engine's retry window
 * (retryWriteAdmission's storage_error with detail database_contention),
 * reusing its request ID. Any other error, and the last attempt, rethrow.
 */
export async function submitWithAdmissionRetry<T>(submit: () => Promise<T>, onRetry: () => void = () => {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await submit(); }
    catch (error) {
      if (!(error instanceof OperationError && error.detail === 'database_contention') || attempt >= MAX_ADMISSION_ATTEMPTS) throw error;
      onRetry();
      await Bun.sleep(ADMISSION_RETRY_BACKOFF_MS);
    }
  }
}
