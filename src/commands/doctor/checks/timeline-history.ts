/**
 * timeline_history doctor check (#5567): timeline rows that exist only in the
 * database, with no bullet in their page. Materializable rows warn and name
 * `gbrain repair timeline`; rows that cannot round-trip through the page are
 * kept by every writer and reported as informational.
 *
 * Bounded: pages carrying non-event timeline rows are classified in id order
 * up to PAGE_CAP pages or TIME_BUDGET_MS per run. A run that stops early keeps
 * its cursor in the config row `doctor.timeline_history.scan:<scope>` (#5821),
 * so successive doctor runs cover the whole scope; a pass that ends reports
 * the counts of every run in it. While a later pass is in progress, a clean
 * finished pass is trusted until a newer timeline row is written. A truncated
 * run with neither is a lower bound and is never reported as clean.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { scanTimelineHistory } from '../../../core/repair/timeline.ts';

const PAGE_CAP = 2_000;
const TIME_BUDGET_MS = 10_000;
const STATE_KEY = 'doctor.timeline_history.scan';

interface PassTotals { materializable: number; unrenderable: number; affected: number; inspected: number; runs: number }
interface ScanState extends PassTotals {
  cursor: number;
  /** Highest timeline row id when the pass started; rows above it may be unscanned. */
  started_max_entry: number;
  last?: PassTotals & { max_entry: number; completed_at: string };
}

const emptyTotals = (): PassTotals => ({ materializable: 0, unrenderable: 0, affected: 0, inspected: 0, runs: 0 });

async function loadState(engine: BrainEngine, key: string): Promise<ScanState | null> {
  try {
    const raw = await engine.getConfig(key);
    const state = raw ? JSON.parse(raw) as ScanState : null;
    return state && Number.isSafeInteger(state.cursor) ? state : null;
  } catch { return null; }
}

async function saveState(engine: BrainEngine, key: string, state: ScanState): Promise<void> {
  try { await engine.setConfig(key, JSON.stringify(state)); } catch { /* best effort: the next run rescans from the start */ }
}

export async function timelineHistoryCheck(engine: BrainEngine, sourceId?: string, opts: { pageCap?: number } = {}): Promise<Check> {
  const name = 'timeline_history';
  try {
    const sources = sourceId ? [sourceId] : (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE')).map(r => r.id);
    const key = `${STATE_KEY}:${[...sources].sort().join(',')}`;
    const [{ max_entry }] = await engine.executeRaw<{ max_entry: number | string }>('SELECT COALESCE(max(id), 0) AS max_entry FROM timeline_entries');
    const maxEntry = Number(max_entry);
    const prior = await loadState(engine, key);
    const state: ScanState = prior ?? { ...emptyTotals(), cursor: 0, started_max_entry: maxEntry };
    const scan = await scanTimelineHistory(engine, sources, state.cursor, { pages: opts.pageCap ?? PAGE_CAP, deadline: Date.now() + TIME_BUDGET_MS });
    const segment = {
      materializable: scan.pages.reduce((n, p) => n + p.materializable, 0),
      unrenderable: scan.pages.reduce((n, p) => n + p.unrenderable, 0),
      affected: scan.pages.filter(p => p.materializable).length,
    };
    const pass: PassTotals = {
      materializable: state.materializable + segment.materializable,
      unrenderable: state.unrenderable + segment.unrenderable,
      affected: state.affected + segment.affected,
      inspected: state.inspected + scan.inspected,
      runs: state.runs + 1,
    };
    const multiRun = pass.runs > 1;

    if (!scan.truncated) {
      if (prior) {
        await saveState(engine, key, { ...emptyTotals(), cursor: 0, started_max_entry: maxEntry,
          last: { ...pass, max_entry: state.started_max_entry, completed_at: new Date().toISOString() } });
      }
      const details = { materializable_rows: pass.materializable, kept_unrenderable_rows: pass.unrenderable, pages_affected: pass.affected,
        pages_inspected: pass.inspected, count: 'exact', truncated: false, repair: 'timeline', ...(multiRun ? { pass_runs: pass.runs } : {}) };
      const across = multiRun ? ` (full pass across ${pass.runs} doctor runs)` : '';
      if (pass.materializable > 0) {
        return { name, status: 'warn', details, message: `${pass.materializable} timeline row(s) on ${pass.affected} page(s) exist only in the database${across}. `
          + `Preview: gbrain repair timeline — apply: gbrain repair timeline --apply` + (pass.unrenderable ? `. ${pass.unrenderable} other row(s) cannot round-trip and are kept as-is.` : '') };
      }
      return { name, status: 'ok', details, message: pass.unrenderable
        ? `No materializable database-only timeline rows${across}; ${pass.unrenderable} row(s) cannot round-trip through their page and are kept as-is (informational).`
        : `Every timeline row has a bullet in its page (${pass.inspected} page(s) inspected${multiRun ? ` across ${pass.runs} doctor runs` : ''}).` };
    }

    await saveState(engine, key, { ...state, ...pass, cursor: scan.cursor });
    const details = { materializable_rows: pass.materializable, kept_unrenderable_rows: pass.unrenderable, pages_affected: pass.affected,
      pages_inspected: pass.inspected, count: 'lower_bound', truncated: true, repair: 'timeline', pass_runs: pass.runs, resumes_after_page_id: scan.cursor };
    const coverage = ` (this pass has inspected ${pass.inspected} page(s) over ${pass.runs} run(s) and resumes on the next doctor run; counts are a lower bound)`;
    if (pass.materializable > 0) {
      return { name, status: 'warn', details, message: `at least ${pass.materializable} timeline row(s) on ${pass.affected} page(s) exist only in the database${coverage}. `
        + `Preview: gbrain repair timeline — apply: gbrain repair timeline --apply` + (pass.unrenderable ? `. ${pass.unrenderable} other row(s) cannot round-trip and are kept as-is.` : '') };
    }
    const last = state.last;
    if (last && last.materializable === 0 && maxEntry <= last.max_entry) {
      return { name, status: 'ok', details: { ...details, last_full_pass: { pages_inspected: last.inspected, runs: last.runs, completed_at: last.completed_at } },
        message: `No materializable database-only timeline rows: the last full pass (${last.inspected} page(s), completed ${last.completed_at}) found none and no timeline row has been written since; the next pass is in progress.` };
    }
    return { name, status: 'warn', details, message: `Timeline history scan incomplete${coverage}; run \`gbrain repair timeline\` for the full count now.` };
  } catch (e) {
    return { name, status: 'warn', message: `timeline history check skipped: ${e instanceof Error ? e.message : String(e)}`,
      details: { count: 'lower_bound', truncated: true, health: 'unknown' } };
  }
}
