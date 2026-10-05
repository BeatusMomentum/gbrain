/**
 * D-NEW-2: a code page whose body carries a facts/takes fence marker is never
 * sealed safe. Authoring gate: (1) protects the code import stamp, the
 * unchanged re-import re-seal path, `repair safe-chunks` and doctor's
 * safe_index_pending; (2) fails when a protected code body is admitted to
 * safe-chunk (remote) reads, or when re-seal stamps it safe again; (3)
 * test/safe-chunk-reseal.test.ts covers code without markers only; (4) no
 * production seam. Both engines: PGLite here, PostgreSQL through
 * test/e2e/code-import-protected-fence-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { resealSafeChunks } from '../src/core/page-state/projections.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../src/core/search/safe-chunks.ts';
import { safeChunksRepair } from '../src/core/repair/safe-chunks.ts';
import { safeIndexPendingCheck } from '../src/commands/doctor/checks/safe-index.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const fenced = 'export const note = `\n<!--- gbrain:facts:begin -->\n| fact | private |\n<!--- gbrain:facts:end -->\n`;\n';
const plain = 'export function add(a: number, b: number) {\n  return a + b;\n}\n';

for (const kind of testBackends()) {
  describe(`code import with a fence marker (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let fencedSlug = '';
    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });

    const chunkerVersion = async (slug: string) => Number((await engine.executeRaw<{ v: number }>(
      "SELECT chunker_version AS v FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!.v);

    test('a protected code body stays below the safe fence through import, re-import and re-seal', async () => {
      const imported = await importCodeFile(engine, 'lib/fenced-example.ts', fenced, { noEmbed: true });
      expect(imported.status).toBe('imported');
      fencedSlug = imported.slug;
      expect(await chunkerVersion(imported.slug)).toBeLessThan(SAFE_FENCE_CHUNKER_VERSION);
      expect((await engine.getChunks(imported.slug, { sourceId: 'default' })).length).toBeGreaterThan(0);
      expect(await engine.getChunks(imported.slug, { sourceId: 'default', requireSafeChunks: true })).toEqual([]);

      const again = await importCodeFile(engine, 'lib/fenced-example.ts', fenced, { noEmbed: true });
      expect(again).toMatchObject({ status: 'skipped' });
      expect(again.resealed).toBeUndefined();
      expect(await resealSafeChunks(engine, imported.slug, 'default')).toBeNull();
      expect(await chunkerVersion(imported.slug)).toBeLessThan(SAFE_FENCE_CHUNKER_VERSION);
      expect(await engine.getChunks(imported.slug, { sourceId: 'default', requireSafeChunks: true })).toEqual([]);
    }, 60_000);

    test('plain code is still sealed and admitted', async () => {
      const imported = await importCodeFile(engine, 'lib/plain-example.ts', plain, { noEmbed: true });
      expect(await chunkerVersion(imported.slug)).toBeGreaterThanOrEqual(SAFE_FENCE_CHUNKER_VERSION);
      expect((await engine.getChunks(imported.slug, { sourceId: 'default', requireSafeChunks: true })).length).toBeGreaterThan(0);
    }, 60_000);

    test('repair and doctor leave a protected code page out of the re-sealable count', async () => {
      const plan = await safeChunksRepair.plan(engine, { brain_id: 'host', source_ids: ['default'] }, null);
      expect(fencedSlug).not.toBe('');
      expect(plan.items.map(item => item.slug)).not.toContain(fencedSlug);
      expect(plan.residuals).toMatchObject({ code_with_fence_marker: 1, code_without_source_path: 0 });
      const check = await safeIndexPendingCheck(engine, ['default']);
      expect(check.status).toBe('ok');
      expect(check.details).toMatchObject({ pages_pending: 0, kept_pages: 1 });
    }, 60_000);
  });
}
