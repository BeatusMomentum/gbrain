/**
 * #6109: `gbrain onboard --history` reads migration_impact_log, and
 * runRemediation is its writer. Each executed job step whose job moves a
 * tracked metric records that metric before submit and after its job is
 * terminal; a dry run, an unmapped job or a failed capture never changes the
 * step's result, and the orphan metric is get_health's orphan_pages without
 * running the full health aggregate.
 *
 * Protects: onboard history reflecting what remediation actually did.
 * Fails when: the capture is unwired (history stays empty), a step writes
 * more or fewer rows than it executed, the orphan metric drifts from
 * get_health, or telemetry failure changes a job's status.
 * Seams: none; real remediation with inline jobs on PGLite (the Postgres arm
 * is test/e2e/onboard-full-flow.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runRemediation } from '../src/core/remediation/index.ts';
import * as impactCapture from '../src/core/onboard/impact-capture.ts';
import { runOnboard } from '../src/commands/onboard.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let version: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  version = (await engine.getConfig('version'))!;
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', version);
});

async function history(brain: BrainEngine): Promise<Array<Record<string, unknown>>> {
  let out = '';
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as never);
  try {
    await runOnboard(brain, ['--history', '--json']);
  } finally {
    write.mockRestore();
  }
  return (JSON.parse(out) as { history: Array<Record<string, unknown>> }).history;
}

/** Two unextracted pages, one linking the other: the planner adds extract.stale, which leaves no orphan pages. */
async function seedLinkedPages(): Promise<void> {
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice works at [[companies/acme-example]].' });
  await engine.putPage('companies/acme-example', { type: 'company', title: 'Acme Example', compiled_truth: 'A widget company.' });
}

const MAPPED_JOBS = new Set(['embed', 'embed-catch-up', 'extract', 'extract-ner', 'extract-timeline-from-meetings', 'extract-takes-from-pages']);

describe('remediation impact capture (#6109)', () => {
  test('onboard --history returns one row per executed mapped step, with the metric before and after', async () => {
    await seedLinkedPages();
    const result = await runRemediation(engine, { targetScore: 0, inlineJobs: true });
    const executed = result.submitted.filter(s => s.job_id !== null);
    expect(executed.map(s => s.id)).toContain('extract.stale');
    const rows = await history(engine);
    const jobs = await engine.executeRaw<{ id: number; name: string }>('SELECT id, name FROM minion_jobs');
    const jobName = new Map(jobs.map(j => [Number(j.id), j.name]));
    expect(rows.map(r => r.remediation_id).sort()).toEqual(executed.filter(s => MAPPED_JOBS.has(jobName.get(s.job_id!)!)).map(s => s.id).sort());
    expect(rows.find(r => r.remediation_id === 'extract.stale')).toMatchObject({ metric_name: 'orphan_count', metric_before: 2, metric_after: 0, delta: -2 });
  });

  test('a dry run and an unmapped job record nothing', async () => {
    await seedLinkedPages();
    const dry = await runRemediation(engine, { targetScore: 0, dryRun: true });
    expect(dry.submitted.every(s => s.status === 'dry_run')).toBe(true);
    expect(await impactCapture.startStepImpact(engine, { id: 'x.unmapped', job: 'reindex-frontmatter', idempotency_key: 'k', params: {} })).toBeNull();
    expect(await history(engine)).toEqual([]);
  });

  test('a failed capture or log write never changes the step result', async () => {
    await seedLinkedPages();
    const failing = new Proxy(engine, {
      get(target, prop) {
        if (prop === 'executeRaw') return async (sql: string, params?: unknown[]) => {
          if (sql.includes('migration_impact_log') || sql.includes('FROM links l JOIN pages src')) throw new Error('telemetry unavailable');
          return target.executeRaw(sql, params as never);
        };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const errors = spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    try {
      const result = await runRemediation(failing, { targetScore: 0, inlineJobs: true });
      expect(result.submitted.find(s => s.id === 'extract.stale')?.status).toBe('completed');
    } finally {
      errors.mockRestore();
    }
    expect(await history(engine)).toEqual([]);
  });

  test('orphan_count equals get_health orphan_pages without running get_health', async () => {
    await seedLinkedPages();
    await engine.putPage('notes/lonely-example', { type: 'note', title: 'Lonely', compiled_truth: 'No links.' });
    await engine.putPage('notes/quarantined-example', { type: 'note', title: 'Hidden', compiled_truth: 'Junk.', frontmatter: { quarantine: { reason: 'junk_pattern', detail: 'fixture' } } });
    await engine.putPage('templates/new-person', { type: 'note', title: 'Template', compiled_truth: 'A template page.' });
    await engine.putPage('notes/gone-example', { type: 'note', title: 'Gone', compiled_truth: 'Links to [[notes/kept-example]].' });
    await engine.putPage('notes/kept-example', { type: 'note', title: 'Kept', compiled_truth: 'Only a deleted page links here.' });
    await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type)
      SELECT f.id, t.id, 'mention' FROM pages f, pages t WHERE f.slug = 'notes/gone-example' AND t.slug = 'notes/kept-example'`);
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = 'notes/gone-example'`);
    const health = spyOn(engine, 'getHealth');
    const orphans = await impactCapture.captureMetric(engine, 'orphan_count');
    expect(health).not.toHaveBeenCalled();
    health.mockRestore();
    expect(orphans).toBe((await engine.getHealth()).orphan_pages);
    expect(orphans).toBeGreaterThan(2);
  });
});
