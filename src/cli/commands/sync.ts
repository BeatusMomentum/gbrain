/**
 * `gbrain sync`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { opError } from '../../core/ops/contract.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runSync, SyncLockBusyError } = await import('../../commands/sync.ts');
  try {
    await runSync(engine, args);
  } catch (e) {
    // D1/D2: a busy sync lock is a retryable sync_in_progress refusal (its
    // message names the holder and the --break-lock recovery), not an
    // unclassified internal error.
    if (!(e instanceof SyncLockBusyError)) throw e;
    throw opError('sync_in_progress', e.message,
      `Wait for the running sync to finish and retry. If its holder is dead, run \`gbrain sync --break-lock\` (with the same --source).`,
      { reason: 'lock_busy', detail: e.lockKey });
  }
}
