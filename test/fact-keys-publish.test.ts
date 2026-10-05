/**
 * Fact keys (docs/designs/FACT_KEYS.md): prepare-then-swap publication,
 * revision binding, fail-closed visibility, withdrawal filtering and
 * discovery, retirement on a new revision, and the install-time key check.
 * Real PGLite (and Postgres when DATABASE_URL is set); fake embeddings.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installPageEmbeddings, installPageProjection, preparePageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
import { bindFactKeysSnapshot, clearPageFactKeys, publishPageFactKeys, type FactKeyItem } from '../src/core/facts/fact-keys-publish.ts';
import { embeddingInputContext, embeddingWriteTarget } from '../src/core/page-state/projections.ts';
import { embeddingInputHash } from '../src/core/embedding-input-hash.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { discoverWithdrawalTargets } from '../src/core/facts/withdrawal-discovery.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const sourceId = 'fact-keys-test';
const slug = 'meetings/synthetic-planning';
const body = 'Alice-example said the offsite moves to the lake cabin. Budget talk followed about the cedar deck repair and paint.';
const timeline = '2026-01-02: Synthetic planning call.';

function fakeVector(text: string): Float32Array {
  const v = new Float32Array(1536);
  const h = createHash('sha256').update(text).digest();
  for (let i = 0; i < 32; i++) v[i] = (h[i] - 127.5) / 128;
  return v;
}
const embedded: string[][] = [];
const embed = async (texts: string[]) => { embedded.push(texts); return texts.map(fakeVector); };
const vectorText = (text: string) => `[${Array.from(fakeVector(text)).join(',')}]`;

for (const kind of testBackends()) {
  describe(`fact keys ${kind}`, () => {
    let engine: BrainEngine;
    let closePostgres: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close: closePostgres } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    }, 120_000);
    beforeEach(async () => {
      embedded.length = 0;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
      await engine.setConfig('search.fact_keys', 'on');
    });
    afterEach(async () => {
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
      await engine.setConfig('search.fact_keys', 'off');
    });
    afterAll(async () => {
      if (kind === 'pglite') await engine.disconnect();
      await closePostgres?.();
    });

    async function seed(opts: { mode?: string | null; frontmatter?: Record<string, unknown>; text?: string } = {}) {
      await engine.putPage(slug, { type: 'meeting', title: 'Synthetic planning', compiled_truth: opts.text ?? body, timeline,
        frontmatter: opts.frontmatter ?? {} }, { sourceId });
      const prepared = (await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true }))!;
      await installPageProjection(engine, prepared, (await preparePageProjection(prepared)).chunks, { seal: true });
      await engine.executeRaw('UPDATE pages SET contextual_retrieval_mode=$3 WHERE source_id=$1 AND slug=$2',
        [sourceId, slug, opts.mode === undefined ? 'title' : opts.mode]);
      const snapshot = (await readProjectionSnapshot(engine, slug, sourceId))!;
      const target = await embeddingWriteTarget(engine);
      const provenance = embeddingInputContext(target, snapshot.snapshot.page.title, null, snapshot.chunks);
      for (const chunk of snapshot.chunks) {
        const input = `<context>Synthetic planning\n</context>\n${chunk.chunk_text}`;
        await engine.executeRaw(`UPDATE content_chunks SET embedding=$2::vector,model=$3,embedded_at=now(),embedded_text_hash=md5(chunk_text),
          embedding_input_hash=$4 WHERE id=$1`, [chunk.id, vectorText(input), snapshot.embeddingModel, embeddingInputHash(provenance, 'title', chunk)]);
      }
      return (await bindFactKeysSnapshot(engine, sourceId, slug, opts.text ?? body))!;
    }
    const chunks = () => engine.executeRaw<{ chunk_index: number; fact_keys: string | null; embedding: string | null; embedding_input_hash: string | null }>(
      `SELECT cc.chunk_index,cc.fact_keys,cc.embedding::text AS embedding,cc.embedding_input_hash FROM content_chunks cc JOIN pages p ON p.id=cc.page_id
        WHERE p.source_id=$1 AND p.slug=$2 ORDER BY cc.chunk_index`, [sourceId, slug]);
    const rows = () => engine.executeRaw<{ item_text: string; subject: string; visibility: string }>(
      'SELECT item_text,subject,visibility FROM page_fact_keys WHERE source_id=$1 ORDER BY ordinal', [sourceId]);
    const world = (text: string, subject = '*'): FactKeyItem => ({ text, subject, visibility: 'world' });

    test('publishes keys and swaps vectors built from them in one step', async () => {
      const binding = await seed();
      const result = await publishPageFactKeys(engine, binding, [world('The offsite is at the lake cabin'), world('The cedar deck needs repair')], { embed });
      expect(result).toEqual({ published: true, items: 2, chunks_rekeyed: 1 });
      const [first, second] = await chunks();
      expect(first.fact_keys).toBe('The offsite is at the lake cabin; The cedar deck needs repair');
      expect(second.fact_keys).toBeNull();
      const input = `<context>Synthetic planning\nFacts: ${first.fact_keys}\n</context>\n${body}`;
      expect(embedded).toEqual([[input]]);
      expect(first.embedding).toBe(vectorText(input));
      const snapshot = (await readProjectionSnapshot(engine, slug, sourceId))!;
      const provenance = embeddingInputContext(await embeddingWriteTarget(engine), 'Synthetic planning', null, snapshot.chunks);
      expect(first.embedding_input_hash).toBe(embeddingInputHash(provenance, 'title', snapshot.chunks[0]));
      expect((await rows()).map(r => r.item_text)).toEqual(['The offsite is at the lake cabin', 'The cedar deck needs repair']);
      expect(await publishPageFactKeys(engine, binding, [world('The offsite is at the lake cabin'), world('The cedar deck needs repair')], { embed }))
        .toEqual({ published: true, items: 2, chunks_rekeyed: 0 });
    });

    test('a superseded revision, a disabled setting or an ineligible page publishes nothing', async () => {
      const binding = await seed();
      await engine.setConfig('search.fact_keys', 'off');
      expect(await publishPageFactKeys(engine, binding, [world('The offsite is at the lake cabin')], { embed })).toEqual({ published: false, reason: 'disabled' });
      await engine.setConfig('search.fact_keys', 'on');
      await engine.putPage(slug, { type: 'meeting', title: 'Synthetic planning', compiled_truth: `${body} Edited.`, timeline }, { sourceId });
      expect(await publishPageFactKeys(engine, binding, [world('The offsite is at the lake cabin')], { embed })).toMatchObject({ published: false, reason: 'superseded' });
      expect(await rows()).toEqual([]);
      for (const [opts, reason] of [[{ mode: 'per_chunk_synopsis' }, 'not_title_mode'], [{ mode: null }, 'not_title_mode'],
        [{ frontmatter: { embed_skip: true } }, 'embed_skip'], [{ text: `${body}\n<!--- gbrain:facts:begin -->\n<!--- gbrain:facts:end -->` }, 'protected']] as const) {
        await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [sourceId]);
        const fresh = await seed(opts);
        expect(await publishPageFactKeys(engine, fresh, [world('The offsite is at the lake cabin')], { embed })).toEqual({ published: false, reason });
      }
      expect(embedded).toEqual([]);
    });

    test('private facts never key a world page; withdrawn facts never key at all', async () => {
      const binding = await seed();
      const priv: FactKeyItem = { text: 'Alice-example dislikes the lake', subject: '*', visibility: 'private' };
      expect(await publishPageFactKeys(engine, binding, [priv], { embed })).toEqual({ published: true, items: 0, chunks_rekeyed: 0 });
      const fact = await engine.insertFact({ fact: 'The cedar deck needs repair', visibility: 'world', source: 'synthetic' }, { source_id: sourceId });
      expect((await recordFactWithdrawal(engine, fact.id, sourceId)).withdrawn).toBe(true);
      expect(await publishPageFactKeys(engine, binding, [world('The cedar deck needs repair.'), world('The offsite is at the lake cabin')], { embed }))
        .toEqual({ published: true, items: 1, chunks_rekeyed: 1 });
      expect((await rows()).map(r => r.item_text)).toEqual(['The offsite is at the lake cabin']);
      await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [sourceId]);
      const privatePage = await seed({ frontmatter: { visibility: 'private' } });
      expect(await publishPageFactKeys(engine, privatePage, [priv], { embed })).toEqual({ published: true, items: 1, chunks_rekeyed: 1 });
    });

    test('withdrawal discovery finds a page through its keys, including unresolved key subjects', async () => {
      const binding = await seed();
      await publishPageFactKeys(engine, binding, [world('Bob-example prefers the window seat', 'people/bob-example')], { embed });
      const page = (await engine.readPageSnapshot(slug, { sourceId }))!;
      const claim = (subject: string) => [{ visibility: 'world', fact_hash: '', subject, claim: 'Bob-example prefers the window seat!' }];
      expect((await discoverWithdrawalTargets(engine, sourceId, claim('people/bob-example'))).map(t => t.page_id)).toEqual([page.page.id]);
      expect(await discoverWithdrawalTargets(engine, sourceId, claim('people/carol-example'))).toEqual([]);
      await publishPageFactKeys(engine, binding, [world('Bob-example prefers the window seat')], { embed });
      expect((await discoverWithdrawalTargets(engine, sourceId, claim('people/carol-example'))).map(t => t.page_id)).toEqual([page.page.id]);
    });

    test('a new revision retires the keys and drops the keyed vectors', async () => {
      const binding = await seed();
      await publishPageFactKeys(engine, binding, [world('The offsite is at the lake cabin')], { embed });
      await engine.putPage(slug, { type: 'meeting', title: 'Synthetic planning', compiled_truth: body, timeline: `${timeline}\n2026-01-03: Follow-up.` }, { sourceId });
      const prepared = (await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true }))!;
      await installPageProjection(engine, prepared, (await preparePageProjection(prepared)).chunks, { seal: true, preserveEmbeddings: true });
      expect(await rows()).toEqual([]);
      const [first] = await chunks();
      expect(first.fact_keys).toBeNull();
      expect(first.embedding).toBeNull();
    });

    test('an embedding built before a key change cannot install', async () => {
      const binding = await seed();
      const stale = (await readProjectionSnapshot(engine, slug, sourceId))!;
      await publishPageFactKeys(engine, binding, [world('The offsite is at the lake cabin')], { embed });
      const installed = await installPageEmbeddings(engine, stale, stale.chunks.map(chunk => ({
        chunk_index: chunk.chunk_index, chunk_text: chunk.chunk_text, chunk_source: chunk.chunk_source, embedding: fakeVector('old input'),
      })));
      expect(installed).toBe(false);
      expect((await chunks())[0].fact_keys).toBe('The offsite is at the lake cabin');
    });

    test('clearing strips keys by re-embedding first, whatever the setting', async () => {
      const binding = await seed();
      await publishPageFactKeys(engine, binding, [world('The offsite is at the lake cabin')], { embed });
      await engine.setConfig('search.fact_keys', 'off');
      embedded.length = 0;
      expect(await clearPageFactKeys(engine, sourceId, slug, { embed })).toEqual({ published: true, items: 0, chunks_rekeyed: 1 });
      const input = `<context>Synthetic planning\n</context>\n${body}`;
      expect(embedded).toEqual([[input]]);
      const [first] = await chunks();
      expect([first.fact_keys, first.embedding]).toEqual([null, vectorText(input)]);
      expect(await rows()).toEqual([]);
    });

    test('a failed embed leaves the previous keys and vectors in place', async () => {
      const binding = await seed();
      const before = await chunks();
      const failing = async () => { throw new Error('provider down'); };
      expect(await publishPageFactKeys(engine, binding, [world('The offsite is at the lake cabin')], { embed: failing }))
        .toEqual({ published: false, reason: 'embed_failed', detail: 'provider down' });
      expect(await chunks()).toEqual(before);
      expect(await rows()).toEqual([]);
    });
  });
}
