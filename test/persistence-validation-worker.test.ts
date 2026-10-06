/**
 * Persistence validation producer admission (#5485). Protects: the soak
 * producer retries an admission whose contention outlasted the engine's
 * retry window, with the same request ID, a bounded number of times, and
 * counts each retry so the contention stays visible in the report. Fails
 * when: the producer gives up on the first exhausted-contention refusal, or
 * retries anything else (a terminal refusal, an unrelated storage error).
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { submitWithAdmissionRetry } from '../scripts/persistence/producer-admission.ts';
import { retryWriteAdmission } from '../src/core/persistence/admission-retry.ts';
import { OperationError } from '../src/core/ops/contract.ts';

let exhausted: unknown;
beforeAll(async () => {
  exhausted = await retryWriteAdmission('11111111-1111-4111-8111-111111111111',
    async () => { throw Object.assign(new Error('serialization failure'), { code: '40001' }); }, 30).then(() => null, error => error);
});

describe('persistence validation producer admission', () => {
  test('the engine helper\'s exhausted-contention refusal is what the producer retries', () => {
    expect(exhausted).toBeInstanceOf(OperationError);
    expect(exhausted).toMatchObject({ code: 'storage_error', writeError: 'storage_error', detail: 'database_contention' });
  });

  test('retries a contention-blocked admission with the same request ID and counts the retry', async () => {
    const requestIds: string[] = []; let retries = 0;
    const accepted = { request_id: '11111111-1111-4111-8111-111111111111', state: 'queued' };
    const row = await submitWithAdmissionRetry(async () => {
      requestIds.push(accepted.request_id);
      if (requestIds.length === 1) throw exhausted;
      return accepted;
    }, () => { retries++; });
    expect(row).toBe(accepted);
    expect(requestIds).toEqual([accepted.request_id, accepted.request_id]);
    expect(retries).toBe(1);
  });

  test('stops after three attempts and rethrows when contention persists', async () => {
    let attempts = 0; let retries = 0;
    await expect(submitWithAdmissionRetry(async () => { attempts++; throw exhausted; }, () => { retries++; })).rejects.toBe(exhausted);
    expect([attempts, retries]).toEqual([3, 2]);
  });

  test('never retries a terminal refusal, another storage error or a non-contention detail', async () => {
    const others = [
      new OperationError('storage_error', 'The write did not commit.'),
      Object.assign(new OperationError('storage_error', 'Admission failed.'), { detail: 'unbound_source' }),
      new OperationError('conflict', 'The page changed since the expected revision.'),
      Object.assign(new Error('look-alike'), { code: 'storage_error', detail: 'database_contention' }),
    ];
    for (const other of others) {
      let attempts = 0; let retries = 0;
      await expect(submitWithAdmissionRetry(async () => { attempts++; throw other; }, () => { retries++; })).rejects.toBe(other);
      expect([attempts, retries]).toEqual([1, 0]);
    }
  });
});
