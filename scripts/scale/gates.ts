/**
 * Gate policy for the scale tier (spec F4c; O-CEO-16 / O-ENG-16 / O-CEO-9).
 * Pure: `evaluateScaleGates` reads a finished report and decides which gates
 * pass, which fail, and the exit code. scripts/scale/run.ts calls it, the
 * scale-tier workflow enforces it with `--enforce`, and
 * test/scripts/scale-gates.test.ts plants slow ops and wrong answers in it.
 *
 * Enforced from day one (under --enforce): import rate, known answers for
 * every timed op and data check, no-op re-import, no duplicate documents
 * across sources, phase timers.
 * Planner health is enforced only when PLANNER_HEALTH_ENFORCED is true.
 * Interactive ceilings and calibrated budgets stay report-only until
 * scripts/scale/trend.ts says "ceilings stable" and a reviewer sets the repo
 * variable GBRAIN_SCALE_ENFORCE_CEILINGS=1.
 */

/**
 * The one switch for the planner-health gate (hot-table statistics after
 * import, Nested Loop inner loops in the key plans). Report-only until F4b
 * (planner-stats ANALYZE during import, after GBRA-39's ad7252a) lands:
 * before it, PGLite has no statistics after an import and this gate would
 * fail every run. Flip to true in the commit that merges F4b.
 */
export const PLANNER_HEALTH_ENFORCED = false;

export const RATE_RATIO_MAX = 1.5;
/** Below this size per-process warmup dominates the per-page cost, so the rate gate is reported but not enforced. */
export const RATE_MIN_PAGES = 1000;
export const TOTAL_VS_HALF_MAX = 2.5;
export const LOOPS_PER_PAGE_MAX = 10;
export const HOT_TABLES = ['pages', 'links', 'content_chunks', 'timeline_entries', 'facts', 'takes'] as const;
/** The plans the planner-health gate inspects (every captured read statement of these ops). */
export const KEY_PLAN_OPS = ['get_backlinks', 'search (MCP path, remote)', 'get_health', 'find_orphans'] as const;
export const HEADLINE_OP = 'search (MCP path, remote)';
/** Interactive ceilings (p50 ms), defined at 10k pages; report-only until trend.ts says stable. */
export const CEILINGS_MS: Record<string, number> = { 'search (MCP path, remote)': 500, get_health: 1000 };
export const CEILING_PAGES = 10_000;
/** The interactive ceilings that apply at a brain size: defined at 10k, so they bind brains up to 10k pages. */
export function ceilingsFor(pages: number): Record<string, number> {
  return pages <= CEILING_PAGES ? CEILINGS_MS : {};
}
/** Calibrated budgets are this multiple of the first calibration run's p50 (O-CEO-9). */
export const BUDGET_MULTIPLIER = 3;

/** Phase ceilings: 10k pages <= 20 min per engine, 50k <= 100 min (import 75, budgets 25); linear in pages, floor 2 min. */
export function phaseLimitsMs(pages: number): Record<'import' | 'budgets', number> {
  const minutes = (perThousand: number) => Math.max(2, (pages / 1000) * perThousand) * 60_000;
  return { import: minutes(1.5), budgets: minutes(0.5) };
}

export interface PlanStatement { sql: string; execution_ms: number; inner_loops: number; text?: string }
export interface OpPlan { statements: number; slowest?: PlanStatement; worst_loops?: PlanStatement }
export interface OpResult {
  op: string;
  p50_ms: number;
  runs_ms: number[];
  known_answer: 'pass' | 'fail';
  detail?: string;
  plan?: OpPlan;
}
export interface DataCheck { check: string; status: 'pass' | 'fail'; detail?: string }
export interface ScaleReport {
  engine: 'pglite' | 'postgres';
  pages: number;
  seed: number;
  import_mode: 'cli' | 'content';
  import: { rate_ratio: number; total_vs_half: number; per_page_ms_first10: number; per_page_ms_last10: number };
  planner: { hot_table_stat_rows: Record<string, number> };
  ops: OpResult[];
  data: DataCheck[];
  phases_ms: Record<string, number>;
  budgets_ms?: Record<string, number>;
}
export interface GatePolicy { enforce: boolean; enforcePlanner: boolean; enforceCeilings: boolean }
export interface GateResult {
  gate: string;
  status: 'pass' | 'fail';
  /** Whether a failure of this gate fails the run (only meaningful under --enforce). */
  enforced: boolean;
  message: string;
  explain?: string;
}
export interface GateVerdict { results: GateResult[]; failures: GateResult[]; reportOnlyBreaches: GateResult[]; exitCode: 0 | 1 }

export function reproduceCommand(report: Pick<ScaleReport, 'engine' | 'pages' | 'seed' | 'import_mode'>): string {
  return `bun run test:scale -- --engine ${report.engine} --pages ${report.pages} --seed ${report.seed}`
    + `${report.import_mode === 'content' ? ' --import-mode content' : ''} --enforce`;
}

function planText(plan: PlanStatement | undefined): string | undefined {
  if (!plan) return undefined;
  return `-- ${plan.sql.replace(/\s+/g, ' ').trim()}\n${plan.text ?? '(no EXPLAIN text captured)'}`;
}

export function evaluateScaleGates(report: ScaleReport, policy: GatePolicy): GateVerdict {
  const repro = reproduceCommand(report);
  const results: GateResult[] = [];
  const add = (gate: string, ok: boolean, enforced: boolean, message: string, explain?: string) =>
    results.push({ gate, status: ok ? 'pass' : 'fail', enforced, message, ...(explain && !ok ? { explain } : {}) });

  const { rate_ratio, total_vs_half, per_page_ms_first10, per_page_ms_last10 } = report.import;
  add('import_rate', rate_ratio <= RATE_RATIO_MAX && total_vs_half <= TOTAL_VS_HALF_MAX, report.pages >= RATE_MIN_PAGES,
    `import rate: last 10% per-page cost ${per_page_ms_last10} ms is ${rate_ratio}x the first 10% (${per_page_ms_first10} ms; gate <= ${RATE_RATIO_MAX}); `
    + `total import time is ${total_vs_half}x the time at the halfway mark (gate <= ${TOTAL_VS_HALF_MAX}). `
    + `A rising per-page cost means import slows as the brain grows, usually stale planner statistics during import. Reproduce: ${repro}`);

  const missing = HOT_TABLES.filter(t => !(report.planner.hot_table_stat_rows[t]! > 0));
  add('planner_stats', missing.length === 0, policy.enforcePlanner,
    missing.length === 0 ? 'planner stats: every hot table has pg_stats rows after import'
      : `planner stats: no pg_stats rows after import for ${missing.join(', ')}; the planner is guessing row counts on these tables. `
        + `Shipped import must leave statistics behind (F4b). Reproduce: ${repro}`);

  const loopsLimit = LOOPS_PER_PAGE_MAX * report.pages;
  for (const name of KEY_PLAN_OPS) {
    const op = report.ops.find(o => o.op === name);
    const worst = op?.plan?.worst_loops;
    const loops = worst?.inner_loops ?? 0;
    add(`planner_loops:${name}`, loops <= loopsLimit, policy.enforcePlanner,
      `planner loops: ${name} key plan worst Nested Loop inner loops ${loops} (gate <= ${loopsLimit}, ${LOOPS_PER_PAGE_MAX}x pages). `
      + `A Nested Loop rescanning its inner side per row scales quadratically. Reproduce: ${repro}`, planText(worst));
  }

  for (const op of report.ops) {
    add(`known_answer:${op.op}`, op.known_answer === 'pass', true,
      op.known_answer === 'pass' ? `known answer: ${op.op} returned the expected result`
        : `known answer: ${op.op} returned a wrong answer: ${op.detail ?? 'no detail'}. Reproduce: ${repro}`,
      planText(op.plan?.slowest));
  }
  for (const check of report.data) {
    add(`data:${check.check}`, check.status === 'pass', true,
      check.status === 'pass' ? `data check: ${check.check} holds` : `data check: ${check.check} failed: ${check.detail ?? 'no detail'}. Reproduce: ${repro}`);
  }

  const limits = phaseLimitsMs(report.pages);
  for (const phase of ['import', 'budgets'] as const) {
    const ms = report.phases_ms[phase] ?? 0;
    add(`phase:${phase}`, ms <= limits[phase], true,
      `phase timer: ${phase} took ${Math.round(ms / 1000)} s (ceiling ${Math.round(limits[phase] / 1000)} s at ${report.pages} pages). Reproduce: ${repro}`);
  }

  for (const [name, ceiling] of Object.entries(ceilingsFor(report.pages))) {
    const op = report.ops.find(o => o.op === name);
    if (!op) continue;
    add(`ceiling:${name}`, op.p50_ms < ceiling, policy.enforceCeilings,
      `interactive ceiling: ${name} p50 ${op.p50_ms} ms (ceiling < ${ceiling} ms). Reproduce: ${repro}`, planText(op.plan?.slowest));
  }
  for (const [name, budget] of Object.entries(report.budgets_ms ?? {})) {
    const op = report.ops.find(o => o.op === name);
    if (!op) continue;
    add(`budget:${name}`, op.p50_ms <= budget, policy.enforceCeilings,
      `calibrated budget: ${name} p50 ${op.p50_ms} ms (budget ${budget} ms, ${BUDGET_MULTIPLIER}x the calibration run). Reproduce: ${repro}`,
      planText(op.plan?.slowest));
  }

  const failures = results.filter(r => r.status === 'fail' && r.enforced);
  const reportOnlyBreaches = results.filter(r => r.status === 'fail' && !r.enforced);
  return { results, failures, reportOnlyBreaches, exitCode: policy.enforce && failures.length > 0 ? 1 : 0 };
}

/** The lines a run prints for its verdict: every failure with its EXPLAIN, then report-only breaches, then the outcome. */
export function verdictLines(report: ScaleReport, verdict: GateVerdict, policy: GatePolicy): string[] {
  const lines: string[] = [];
  for (const f of verdict.failures) {
    lines.push(`[scale] GATE FAIL ${f.gate}: ${f.message}`);
    if (f.explain) lines.push(...f.explain.split('\n').map(l => `[scale]   ${l}`));
  }
  for (const b of verdict.reportOnlyBreaches) lines.push(`[scale] REPORT-ONLY ${b.gate}: ${b.message}`);
  if (!policy.enforce) {
    lines.push(`[scale] report-only run: exit 0 regardless of gates (${verdict.failures.length} gate(s) would fail under --enforce).`);
  } else if (verdict.failures.length > 0) {
    lines.push(`[scale] ${verdict.failures.length} enforced gate(s) failed; exit 1. Fix the named op or phase, then rerun: ${reproduceCommand(report)}`);
  } else {
    lines.push(`[scale] all enforced gates passed (planner health ${policy.enforcePlanner ? 'enforced' : 'report-only until F4b'}, `
      + `ceilings ${policy.enforceCeilings ? 'enforced' : 'report-only until GBRAIN_SCALE_ENFORCE_CEILINGS=1'}).`);
  }
  return lines;
}

/** Every `{slug, source_id?}` an op result carries, in order (op results nest hits in arrays or evidence objects). */
export function resultHits(value: unknown): Array<{ slug: string; source_id?: string }> {
  const hits: Array<{ slug: string; source_id?: string }> = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { for (const item of v) walk(item); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.slug === 'string') hits.push({ slug: o.slug, ...(typeof o.source_id === 'string' ? { source_id: o.source_id } : {}) });
    for (const child of Object.values(o)) if (child && typeof child === 'object') walk(child);
  };
  walk(value);
  return hits;
}
