#!/usr/bin/env bun
/**
 * Report-only scale harness (fix wave 8 skeleton of the F4 scale tier).
 *
 *   bun run test:scale -- --pages 2000 [--seed 1] [--out <file.json>]
 *
 * Generates the deterministic fixture (scripts/scale/fixture.ts), imports it
 * into a fresh in-memory PGLite brain under a temporary GBRAIN_HOME (never
 * ~/.gbrain), and reports: import rate (last 10% vs first 10% per-page cost),
 * planner health (statistics on the hot tables after import, no Nested Loop
 * with loops above 10x pages in the backlink plan), and p50 timings over five
 * runs after a warmup for the key operations, each with a known-answer check.
 * Gate shape and cadence: O-CEO-16 / O-ENG-16 in docs/TESTING.md "Scale tier".
 *
 * REPORT-ONLY: exits 0 whatever the numbers or checks say; a crash exits 1.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { generateScaleFixture, SCALE_SOURCES } from './fixture.ts';

interface OpReport { op: string; p50_ms: number; runs_ms: number[]; known_answer: 'pass' | 'fail'; detail?: string }

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const pagesArg = Number(flag('--pages', '2000'));
const seed = Number(flag('--seed', '1'));
if (!Number.isInteger(pagesArg) || pagesArg < 20 || !Number.isInteger(seed)) {
  console.error('Usage: bun run test:scale -- --pages <N >= 20> [--seed <int>] [--out <file.json>]');
  process.exit(2);
}
const out = resolve(flag('--out', join('.context', 'scale', `report-pglite-${pagesArg}-seed${seed}.json`)));
const home = mkdtempSync(join(tmpdir(), 'gbrain-scale-'));
process.env.GBRAIN_HOME = home;
delete process.env.DATABASE_URL;
delete process.env.GBRAIN_DATABASE_URL;

const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
const { importFromContent } = await import('../../src/core/import-file.ts');
const { operations } = await import('../../src/core/operations.ts');
const { runExtract } = await import('../../src/commands/extract.ts');

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function main() {
  console.log(`[scale] seed=${seed} pages=${pagesArg} engine=pglite (report-only)`);
  const fixture = generateScaleFixture({ pages: pagesArg, seed });
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const sourceId of SCALE_SOURCES) {
    if (sourceId !== 'default') await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [sourceId]);
  }

  const perPage: number[] = [];
  const importStart = performance.now();
  for (const page of fixture.pages) {
    const t = performance.now();
    const result = await importFromContent(engine, page.slug, page.content, { sourceId: page.sourceId, noEmbed: true });
    if (result.status === 'error') throw new Error(`import failed for ${page.sourceId}:${page.slug}: ${result.error}`);
    perPage.push(performance.now() - t);
  }
  const importMs = performance.now() - importStart;
  const extractStart = performance.now();
  await runExtract(engine, ['all', '--source', 'db', '--json']);
  const extractMs = performance.now() - extractStart;
  const tenth = Math.max(1, Math.floor(perPage.length / 10));
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const rateRatio = avg(perPage.slice(-tenth)) / avg(perPage.slice(0, tenth));

  const hotTables = ['pages', 'links', 'content_chunks', 'timeline_entries', 'facts', 'takes'];
  const stats: Record<string, number> = {};
  for (const table of hotTables) {
    stats[table] = Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pg_stats WHERE tablename = $1', [table]))[0]?.n ?? 0);
  }
  const [{ id: hubId }] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug = $1 AND source_id = 'default'", [fixture.hub]);
  const [plan] = await engine.executeRaw<{ 'QUERY PLAN': unknown }>(
    `EXPLAIN (ANALYZE, FORMAT JSON) SELECT p.slug FROM links l JOIN pages p ON p.id = l.from_page_id WHERE l.to_page_id = $1`, [hubId]);
  let worstLoops = 0;
  const walk = (node: Record<string, unknown>) => {
    if (node['Node Type'] === 'Nested Loop') worstLoops = Math.max(worstLoops, Number(node['Actual Loops'] ?? 0));
    for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) walk(child);
  };
  for (const root of (plan!['QUERY PLAN'] as Array<{ Plan: Record<string, unknown> }>)) walk(root.Plan);

  const local = { engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' } as never;
  const remote = { ...(local as object), remote: true, auth: { token: 't', clientId: 'scale', scopes: ['read'], allowedSources: [...SCALE_SOURCES] } } as never;
  const op = (name: string) => operations.find(o => o.name === name)!;
  const probe = fixture.pages[Math.floor(fixture.pages.length / 3)]!;
  const hub = fixture.pages.find(p => p.slug === fixture.hub && p.sourceId === 'default')!;
  const checks: Array<{ op: string; run: () => Promise<unknown>; verify: (result: unknown) => string | null }> = [
    { op: 'get_health', run: () => op('get_health').handler(local, {}),
      verify: r => Number((r as { page_count?: number }).page_count) === fixture.pages.length ? null : `page_count ${(r as { page_count?: number }).page_count} != ${fixture.pages.length}` },
    { op: 'list_pages', run: () => op('list_pages').handler(local, { limit: 50 }),
      verify: r => (r as unknown[]).length === 50 ? null : `${(r as unknown[]).length} rows, expected 50` },
    { op: 'search (keyword, local)', run: () => op('search').handler(local, { query: probe.token, limit: 10, source_id: probe.sourceId }),
      verify: r => JSON.stringify(r).includes(probe.slug) ? null : `${probe.slug} not returned for ${probe.token}` },
    { op: 'search (MCP path, remote)', run: () => op('search').handler(remote, { query: probe.token, limit: 10 }),
      verify: r => JSON.stringify(r).includes(probe.slug) ? null : `${probe.slug} not returned for ${probe.token}` },
    { op: 'traverse_graph depth 3', run: () => op('traverse_graph').handler(local, { slug: fixture.hub, depth: 3 }),
      verify: r => hub.links.every(target => JSON.stringify(r).includes(target)) ? null : 'a direct link target of the hub is missing' },
    { op: 'get_backlinks', run: () => op('get_backlinks').handler(local, { slug: hub.links[0] }),
      verify: r => JSON.stringify(r).includes(fixture.hub) ? null : `${fixture.hub} missing from backlinks of ${hub.links[0]}` },
    { op: 'find_orphans', run: () => op('find_orphans').handler(local, {}),
      verify: r => fixture.islands.every(slug => JSON.stringify(r).includes(slug)) ? null : 'an island page is missing from find_orphans' },
  ];
  const ops: OpReport[] = [];
  for (const check of checks) {
    let result: unknown;
    let error: string | undefined;
    const runs: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t = performance.now();
      try { result = await check.run(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
      if (i > 0) runs.push(performance.now() - t);
    }
    const detail = error ?? check.verify(result) ?? undefined;
    ops.push({ op: check.op, p50_ms: Math.round(median(runs) * 10) / 10, runs_ms: runs.map(r => Math.round(r)), known_answer: detail ? 'fail' : 'pass', ...(detail ? { detail } : {}) });
  }
  await engine.disconnect();

  const report = {
    harness: 'gbrain-scale', mode: 'report-only', engine: 'pglite', seed, pages: fixture.pages.length, sources: SCALE_SOURCES,
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
    extract_db_ms: Math.round(extractMs),
    import: { total_ms: Math.round(importMs), per_page_ms_first10: Math.round(avg(perPage.slice(0, tenth)) * 10) / 10,
      per_page_ms_last10: Math.round(avg(perPage.slice(-tenth)) * 10) / 10, rate_ratio: Math.round(rateRatio * 100) / 100, gate_rate_ratio_max: 1.5 },
    planner: { hot_table_stat_rows: stats, tables_without_stats: hotTables.filter(t => stats[t] === 0),
      backlink_plan_worst_nested_loops: worstLoops, gate_loops_max: 10 * fixture.pages.length },
    ops,
    todo: ['injected query vectors (vector arm)', 'facts/takes population', 'source-scoped grant query', 'cold-process first query',
      'concurrent receipt-bearing writers', 'Postgres engine', '10k/20k/50k tiers and CI seed upload'],
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(`[scale] extract --source db ${report.extract_db_ms} ms`);
  console.log(`[scale] import ${report.import.total_ms} ms; per-page first10 ${report.import.per_page_ms_first10} ms, last10 ${report.import.per_page_ms_last10} ms, ratio ${report.import.rate_ratio} (gate <= 1.5)`);
  console.log(`[scale] planner: tables without stats: ${report.planner.tables_without_stats.join(', ') || 'none'}; backlink plan worst nested-loop loops ${worstLoops} (gate <= ${report.planner.gate_loops_max})`);
  for (const r of ops) console.log(`[scale] ${r.known_answer === 'pass' ? 'PASS' : 'FAIL'} ${r.op}: p50 ${r.p50_ms} ms${r.detail ? ` (${r.detail})` : ''}`);
  console.log(`[scale] report: ${out} (report-only; exit 0 regardless of results; reproduce with --seed ${seed} --pages ${pagesArg})`);
}

try {
  await main();
} catch (error) {
  console.error(`[scale] harness crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
