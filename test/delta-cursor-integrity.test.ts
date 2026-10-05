/**
 * delta never advances a cursor past content it did not deliver (P0, the
 * contributor audit wave). Both engines: PGLite always, Postgres when
 * DATABASE_URL names a test database (persistence-validation lane).
 *
 * Failure injection wraps the real engine in a Proxy so one read arm throws
 * while every other statement hits the real database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { getSessionContextState } from '../src/core/context/session-state.ts';
import { __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;
const del = operations.find((o) => o.name === 'delta')!;
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Methods made to throw on demand; everything else passes through. */
interface Faults { failing: Set<string> }

function faulty(engine: BrainEngine, faults: Faults): BrainEngine {
  return new Proxy(engine, {
    get(t, k) {
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      if (typeof k === 'string' && faults.failing.has(k)) {
        return async () => { throw new Error(`injected ${k} failure`); };
      }
      return typeof v === 'function' && k !== 'constructor' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as BrainEngine;
}

for (const kind of testBackends()) {
  describe(`delta cursor integrity (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const faults: Faults = { failing: new Set() };
    const ctx = (): OperationContext => ({
      engine: faulty(engine, faults), config: {} as GBrainConfig, logger: noopLogger, dryRun: false, remote: false, sourceId: 'default',
    } as OperationContext);
    const call = async (p: Record<string, unknown>): Promise<R> => (await del.handler(ctx(), p)) as R;
    const state = () => getSessionContextState(engine, 'default', null, 's1');

    async function page(slug: string, agoMs: number): Promise<void> {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `body of ${slug}` });
      await engine.executeRaw(`UPDATE pages SET updated_at = now() - ($1 || ' milliseconds')::interval WHERE slug = $2`, [String(agoMs), slug]);
    }
    async function fact(text: string, agoMs: number): Promise<number> {
      const { id } = await engine.insertFact({ fact: text, kind: 'fact', visibility: 'world', entity_slug: null, source: 'test' } as never, { source_id: 'default' });
      await engine.executeRaw(`UPDATE facts SET created_at = now() - ($1 || ' milliseconds')::interval WHERE id = $2`, [String(agoMs), id]);
      return id;
    }

    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(async () => {
      faults.failing.clear();
      __resetHotMemoryCacheForTests();
      await engine.executeRaw('DELETE FROM session_context_state');
      await engine.executeRaw('DELETE FROM facts');
      await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'notes/%'`);
    });

    test('pages arm throws: neither the session nor the stateless cursor advances, and the next call delivers the page', async () => {
      await call({ session_id: 's1' });
      await engine.executeRaw(`UPDATE session_context_state SET last_wake_at = now() - interval '10 seconds'`);
      const before = (await state())!.last_wake_at;
      await page('notes/missed-by-failed-read', 2_600);

      faults.failing.add('listPages');
      const failed = await call({ session_id: 's1' });
      expect(failed.degraded_reason).toContain('pages');
      expect(failed.pages).toEqual([]);
      expect((await state())!.last_wake_at).toBe(before);
      expect(failed.next_cursor.since).toBe(before);

      const stateless = await call({ since: before });
      expect(stateless.next_cursor.since).toBe(before);

      faults.failing.clear();
      const retry = await call({ session_id: 's1' });
      expect(retry.degraded_reason).toBeUndefined();
      expect(retry.pages.map((p: R) => p.slug)).toContain('notes/missed-by-failed-read');
    });

    test('facts arm throws while pages are delivered: the facts recorded in the window still arrive on the next call', async () => {
      await call({ session_id: 's1' });
      await engine.executeRaw(`UPDATE session_context_state SET last_wake_at = now() - interval '10 seconds'`);
      await fact('fact recorded before the failed read', 5_000);
      await page('notes/delivered-page', 3_000);

      faults.failing.add('listFactsSince');
      faults.failing.add('listFactsKeyset');
      const failed = await call({ session_id: 's1' });
      expect(failed.degraded_reason).toContain('facts');
      expect(failed.facts).toEqual([]);

      faults.failing.clear();
      const retry = await call({ session_id: 's1' });
      expect(retry.facts.map((f: R) => f.fact)).toContain('fact recorded before the failed read');
    });
  });
}
