/**
 * Foundations 2 (Lane C) timeline attribution on an unmanaged brain: the DB
 * timeline extraction batches, the maintenance sweep's timeline batch, the
 * timeline write-through and the legacy timeline source repair write inside
 * maintenanceTransaction, so their rows (and the page revision the
 * write-through advances) name the local maintenance principal. A legacy row
 * the repair rewrites keeps its creator and moves its last writer.
 *
 * Protects the timeline extraction writer family in
 * docs/architecture/system-of-record.md. Fails if extract-timeline-db.ts,
 * sweep.ts, timeline-write-through.ts or timeline-dedup-repair.ts writes
 * outside maintenanceTransaction, Runs on
 * PGLite, and on Postgres (direct and transaction-mode PgBouncer) through
 * test/e2e/write-attribution-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { extractTimelineFromDB } from '../src/commands/extract-timeline-db.ts';
import { runMaintenanceSweep } from '../src/core/sweep.ts';
import { writeTimelineEntryThrough } from '../src/core/timeline-write-through.ts';
import { repairLegacyTimelineSourceRows } from '../src/core/timeline-dedup-repair.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { writePageThrough, _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { CREATOR_ACTOR, asCreator, revisionActor, rowActors, unmanagedBrain, type UnmanagedBrain } from './helpers/unmanaged-attribution.ts';

const engines: BrainEngine[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'gbrain-write-attribution-timeline-'));
let closePostgres: (() => Promise<void>) | undefined;
const TIMELINE = '## Timeline\n\n- **2026-01-02** | test — Met acme-example\n- **2026-02-03** | test — Joined acme-example';
const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n${body}\n`;

beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  rmSync(scratch, { recursive: true, force: true });
});

const timelineActors = (brain: UnmanagedBrain, slug: string) => rowActors(brain.engine, 'timeline_entries',
  'page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)', [brain.sourceId, slug]);
const both = (actor: UnmanagedBrain['maintenance']) => ({ created: actor, last: actor });
const quiet = { quiet: true, jsonMode: false, dryRun: false } as const;

describe('timeline attribution on an unmanaged brain', () => {
  test('extract timeline --source db stamps the rows it inserts', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      const slug = 'people/alice-example';
      await asCreator(engine, tx => tx.putPage(slug, { type: 'person', title: 'Alice', compiled_truth: `A person.\n\n${TIMELINE}` }, { sourceId: brain.sourceId }));
      await engine.executeRaw('DELETE FROM timeline_entries WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)', [brain.sourceId, slug]);

      const result = await extractTimelineFromDB(engine, { sourceIdFilter: brain.sourceId, ...quiet });

      expect(result.created).toBe(2);
      expect((await timelineActors(brain, slug)).map(({ created, last }) => ({ created, last }))).toEqual([both(brain.maintenance), both(brain.maintenance)]);
    }
  }, 120_000);

  test('the maintenance sweep stamps its timeline batch', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      await engine.setConfig('auto_link', 'false');
      const slug = 'people/bob-example';
      await asCreator(engine, tx => tx.putPage(slug, { type: 'person', title: 'Bob', compiled_truth: `A person.\n\n${TIMELINE}` }, { sourceId: brain.sourceId }));
      await engine.executeRaw('DELETE FROM timeline_entries WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)', [brain.sourceId, slug]);

      const report = await runMaintenanceSweep(engine, { sourceId: brain.sourceId, budgetMs: 60_000 });

      expect(report.timelineExtracted).toBe(2);
      expect((await timelineActors(brain, slug)).map(({ created, last }) => ({ created, last }))).toEqual([both(brain.maintenance), both(brain.maintenance)]);
      await engine.setConfig('auto_link', 'true');
    }
  }, 120_000);

  test('a timeline write-through stamps the page revision it advances and the row it inserts', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      const root = join(scratch, brain.sourceId);
      mkdirSync(root, { recursive: true });
      await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [brain.sourceId, root]);
      _resetWriteThroughCacheForTest();
      const slug = 'notes/acme-example';
      await importFromContent(engine, slug, page('Acme', 'An example company.'), { sourceId: brain.sourceId, sourcePath: `${slug}.md`, noEmbed: true });
      const written = await writePageThrough(engine, slug, { sourceId: brain.sourceId });
      await engine.executeRaw(`UPDATE pages SET revision_principal_kind=NULL, revision_principal_id=NULL WHERE source_id=$1 AND slug=$2`, [brain.sourceId, slug]);

      const outcome = await writeTimelineEntryThrough(engine, slug, brain.sourceId, { date: '2026-07-15', summary: 'Signed the example contract' });

      expect(outcome.handled).toBe(true);
      expect(readFileSync(written.path!, 'utf8')).toContain('Signed the example contract');
      expect(await revisionActor(engine, brain.sourceId, slug)).toEqual(brain.maintenance);
      expect((await timelineActors(brain, slug)).map(({ created, last }) => ({ created, last }))).toEqual([both(brain.maintenance)]);
    }
  }, 120_000);

  test('the legacy timeline source repair keeps the creator of a row it rewrites and moves its last writer', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      const slug = 'people/charlie-example';
      const stored = await asCreator(engine, tx => tx.putPage(slug, { type: 'person', title: 'Charlie',
        compiled_truth: 'A person.\n\n## Timeline\n\n- **2026-03-04** | Visited acme-example' }, { sourceId: brain.sourceId }));
      await engine.executeRaw('DELETE FROM timeline_entries WHERE page_id=$1', [stored.id]);
      await asCreator(engine, tx => tx.executeRaw(`INSERT INTO timeline_entries (page_id, date, source, summary, detail)
        VALUES ($1, '2026-03-04', '', 'Visited acme-example', '')`, [stored.id]));

      const result = await repairLegacyTimelineSourceRows(engine);

      expect(result.rowsRewritten).toBeGreaterThanOrEqual(1);
      expect((await timelineActors(brain, slug)).map(({ created, last }) => ({ created, last })))
        .toEqual([{ created: CREATOR_ACTOR, last: brain.maintenance }]);
    }
  }, 120_000);
});
