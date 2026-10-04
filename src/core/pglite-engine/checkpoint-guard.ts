/**
 * #5449/#5284: PGLite runs Postgres as one in-process backend with no
 * checkpointer. When WAL since the last redo point reaches the automatic
 * trigger, Postgres runs the checkpoint inline inside whatever WAL write
 * crossed the segment boundary, and on PGLite 0.4.x that nested checkpoint
 * spins forever at 100% CPU. The guard keeps the automatic trigger from ever
 * firing mid-transaction: before an outermost write transaction begins, it
 * runs a top-level CHECKPOINT once WAL since redo passes half of the trigger
 * distance (256 MB with the default 1 GB max_wal_size). A write statement run
 * outside engine.transaction() is its own outermost transaction and takes the
 * same guard (`writesWal`).
 */
import { GBrainError } from '../types.ts';

export const CHECKPOINT_GUARD_MAX_BYTES = 256 * 1024 * 1024;

/** Reads and transaction control never start a WAL-writing transaction of their own. */
const READ_OR_CONTROL = /^\s*(select|show|explain|values|table|begin|start|commit|end|rollback|savepoint|release|set|reset|checkpoint)\b/i;

/** Whether a statement run on its own (autocommit) may write WAL, so it takes the guard like an outermost transaction. */
export function writesWal(sql: string): boolean {
  if (READ_OR_CONTROL.test(sql)) return false;
  return !/^\s*with\b/i.test(sql) || /\b(insert|update|delete|merge)\b/i.test(sql);
}

type Query = (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;

/**
 * Postgres requests a checkpoint when a new WAL segment number reaches
 * redo_segment + CheckPointSegments - 1, where CheckPointSegments is
 * floor(max_wal_size / (segment * (1 + checkpoint_completion_target))), at
 * least 1. Half that distance leaves room for one large transaction.
 */
export function checkpointGuardThreshold(maxWalBytes: number, segmentBytes: number, completionTarget: number): number {
  const segments = Math.max(1, Math.floor(maxWalBytes / (segmentBytes * (1 + completionTarget))));
  return Math.min(CHECKPOINT_GUARD_MAX_BYTES, Math.max(segmentBytes, (segments - 1) * segmentBytes) / 2);
}

export class PgliteCheckpointGuard {
  private threshold: number | undefined;
  private warned = false;
  private tail: Promise<void> = Promise.resolve();
  private outermost = 0;

  /** `query` replaces the admitted database's query function (tests inject failures here). */
  constructor(private readonly override?: Query, private readonly warn: (message: string) => void = message => console.warn(message)) {}

  /**
   * PGLite already runs one transaction at a time; queuing the probe with its
   * transaction makes each outermost transaction see the WAL its predecessors
   * wrote, so concurrent callers cannot all pass one stale probe.
   */
  async runOutermost<T>(query: Query, transaction: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    const turn = Promise.withResolvers<void>();
    this.tail = turn.promise;
    this.outermost++;
    try {
      await prior;
      await this.beforeOutermostTransaction(this.override ?? query);
      return await transaction();
    } finally { this.outermost--; turn.resolve(); }
  }

  /**
   * An autocommit write statement probes like an outermost transaction but
   * never queues behind one: a statement issued from inside an open
   * transaction's callback must not wait for that transaction to finish. While
   * a guarded transaction is open or queued, its own probe covers the WAL.
   */
  async runStatement<T>(query: Query, statement: () => Promise<T>): Promise<T> {
    if (this.outermost === 0) await this.beforeOutermostTransaction(this.override ?? query);
    return statement();
  }

  private async beforeOutermostTransaction(query: Query): Promise<void> {
    let walSinceRedo: number;
    try {
      if (this.threshold === undefined) {
        const [settings] = (await query(`SELECT pg_size_bytes(current_setting('max_wal_size'))::float8 AS max_wal,
          pg_size_bytes(current_setting('wal_segment_size'))::float8 AS segment,
          current_setting('checkpoint_completion_target')::float8 AS target`)).rows;
        this.threshold = checkpointGuardThreshold(Number(settings!.max_wal), Number(settings!.segment), Number(settings!.target));
      }
      const [probe] = (await query(
        'SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), redo_lsn)::float8 AS since_redo FROM pg_control_checkpoint()')).rows;
      walSinceRedo = Number(probe!.since_redo);
      if (!Number.isFinite(walSinceRedo)) throw new Error('WAL position is unavailable');
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        this.warn(`[pglite] WAL checkpoint guard is unavailable (${error instanceof Error ? error.message : String(error)}); `
          + 'continuing without it. Large imports may stall; restart the command to resume if one does.');
      }
      return;
    }
    if (walSinceRedo < this.threshold) return;
    try {
      await query('CHECKPOINT');
    } catch (error) {
      throw new GBrainError('PGLite checkpoint failed',
        `a top-level CHECKPOINT before the next write transaction failed (${error instanceof Error ? error.message : String(error)}); the transaction was not started`,
        'stop other gbrain processes, restart the command, and run `gbrain pglite-repair --dry-run` if it fails again');
    }
  }
}
