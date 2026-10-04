// Life Chronicle (#5876): read-only rollups of the `chronicle_page_state` ledger for doctor and
// the advisor. One query module so the surfaces cannot drift from the ledger's columns.
import type { BrainEngine } from '../engine.ts';
import { isUndefinedTableError } from '../utils.ts';

export interface ChronicleLedgerStats {
  /** False when the ledger table is absent (migration not applied yet). */
  available: boolean;
  pending: number;
  /** Automatic extraction calls in the last rolling 24 hours (each counts against the daily limit). */
  autoCalls24h: number;
  /** Automatic calls per writer principal in the last 24 hours, largest first. */
  principals24h: Array<{ principal: string; calls: number }>;
  /** Automatic rows decided in the last 7 days, by state and by skip/failure reason. */
  last7d: { extracted: number; failed: number; skipped: number; reasons: Record<string, number> };
  /** Automatic spend in the last 7 days: priced dollars, unpriced calls and calls with no cost record, kept apart. */
  spend7d: { knownUsd: number; unpricedCalls: number; incompleteRecords: number };
}

const EMPTY: ChronicleLedgerStats = {
  available: false, pending: 0, autoCalls24h: 0, principals24h: [],
  last7d: { extracted: 0, failed: 0, skipped: 0, reasons: {} },
  spend7d: { knownUsd: 0, unpricedCalls: 0, incompleteRecords: 0 },
};

/** Automatic (trigger='auto') rows only: backfill is manual and bounded by its own --limit. */
export async function readChronicleLedgerStats(engine: BrainEngine): Promise<ChronicleLedgerStats> {
  try {
    const [counts] = await engine.executeRaw<{ pending: number; calls: number; extracted: number; failed: number; skipped: number;
      known_usd: number | null; unpriced: number; incomplete: number }>(
      `SELECT
         count(*) FILTER (WHERE state = 'pending')::int AS pending,
         count(*) FILTER (WHERE state IN ('extracted','failed') AND updated_at > now() - interval '24 hours')::int AS calls,
         count(*) FILTER (WHERE state = 'extracted' AND updated_at > now() - interval '7 days')::int AS extracted,
         count(*) FILTER (WHERE state = 'failed' AND updated_at > now() - interval '7 days')::int AS failed,
         count(*) FILTER (WHERE state = 'skipped' AND updated_at > now() - interval '7 days')::int AS skipped,
         sum(cost_usd) FILTER (WHERE NOT unpriced AND updated_at > now() - interval '7 days')::float8 AS known_usd,
         count(*) FILTER (WHERE unpriced AND state IN ('extracted','failed') AND updated_at > now() - interval '7 days')::int AS unpriced,
         count(*) FILTER (WHERE NOT unpriced AND cost_usd IS NULL AND state IN ('extracted','failed')
           AND updated_at > now() - interval '7 days')::int AS incomplete
       FROM chronicle_page_state WHERE trigger = 'auto'`,
    );
    const reasons = await engine.executeRaw<{ reason: string; n: number }>(
      `SELECT reason, count(*)::int AS n FROM chronicle_page_state
       WHERE trigger = 'auto' AND state IN ('skipped','failed') AND reason IS NOT NULL AND updated_at > now() - interval '7 days'
       GROUP BY reason ORDER BY n DESC, reason`,
    );
    const principals = await engine.executeRaw<{ principal: string; calls: number }>(
      `SELECT coalesce(principal_kind, 'unknown') || coalesce(':' || principal_id, '') AS principal, count(*)::int AS calls
       FROM chronicle_page_state
       WHERE trigger = 'auto' AND state IN ('extracted','failed') AND updated_at > now() - interval '24 hours'
       GROUP BY 1 ORDER BY calls DESC, principal LIMIT 5`,
    );
    return {
      available: true,
      pending: Number(counts?.pending ?? 0),
      autoCalls24h: Number(counts?.calls ?? 0),
      principals24h: principals.map((p) => ({ principal: p.principal, calls: Number(p.calls) })),
      last7d: { extracted: Number(counts?.extracted ?? 0), failed: Number(counts?.failed ?? 0), skipped: Number(counts?.skipped ?? 0),
        reasons: Object.fromEntries(reasons.map((r) => [r.reason, Number(r.n)])) },
      spend7d: { knownUsd: Number(counts?.known_usd ?? 0), unpricedCalls: Number(counts?.unpriced ?? 0),
        incompleteRecords: Number(counts?.incomplete ?? 0) },
    };
  } catch (error) {
    if (isUndefinedTableError(error)) return EMPTY;
    throw error;
  }
}

/** One line for doctor/advisor: 24 h usage against the limit, the largest writer's share, 7-day outcomes and spend. */
export function describeChronicleActivity(stats: ChronicleLedgerStats, dailyLimit: number): string {
  const top = stats.principals24h[0];
  const share = top ? `; largest writer ${top.principal} used ${Math.round((top.calls / dailyLimit) * 100)}% of the daily limit` : '';
  const reasons = Object.entries(stats.last7d.reasons).slice(0, 4).map(([r, n]) => `${r} ${n}`).join(', ');
  const usd = `$${stats.spend7d.knownUsd.toFixed(2)} known spend`;
  const unpriced = stats.spend7d.unpricedCalls > 0 ? ` + ${stats.spend7d.unpricedCalls} unpriced call(s)` : '';
  const incomplete = stats.spend7d.incompleteRecords > 0 ? ` + ${stats.spend7d.incompleteRecords} call(s) with no cost record` : '';
  return `Last 24 h: ${stats.autoCalls24h} of ${dailyLimit} automatic extraction calls${share}. ` +
    `Last 7 days: ${stats.last7d.extracted} extracted, ${stats.last7d.failed} failed, ${stats.last7d.skipped} skipped` +
    `${reasons ? ` (${reasons})` : ''}; ${usd}${unpriced}${incomplete}. ${stats.pending} page(s) pending.`;
}
