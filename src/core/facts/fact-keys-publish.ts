/**
 * Fact keys in chunk embeddings — publication (docs/designs/FACT_KEYS.md).
 *
 * Invariant: every searchable vector was built from the page's current key
 * rows. Keys are added or replaced only by prepare-then-swap: the changed
 * chunks are embedded with their new keys first, then the occurrence rows,
 * the chunk key text and the vectors change together in one guarded
 * transaction. Any failed check writes nothing, so the page keeps its previous
 * keys and vectors.
 *
 * Scope: pages embedded under the `title` tier (the `balanced` default).
 * Pages with protected fences, `embed_skip`, or another tier get no keys.
 * Visibility fails closed: a private fact never keys a world-visible page.
 */
import type { BrainEngine } from '../engine.ts';
import type { ChunkInput } from '../types.ts';
import { assignFactKeys } from '../fact-keys.ts';
import { wrapChunkTextsForStoredMode } from '../embedding-context.ts';
import { currentEmbeddingSignature, embedBatch } from '../embedding.ts';
import { installPageEmbeddings, readProjectionSnapshot, type ProjectionSnapshot } from '../page-state/projections.ts';
import { declarePersistenceProtocol } from '../persistence/protocol.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import { quoteIdentifier } from '../search/embedding-column.ts';
import { FACTS_FENCE_BEGIN } from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN } from '../takes-fence.ts';

export const FACT_KEYS_CONFIG_KEY = 'search.fact_keys';
export const FACT_KEYS_EXTRACTOR_VERSION = 'facts-extractor-v1';

export interface FactKeysBinding {
  sourceId: string;
  slug: string;
  pageId: number;
  revision: string;
  sourceIncarnation: string;
  text: string;
}

export interface FactKeyItem {
  text: string;
  /** Resolved entity slug the fact is about, or '*' when unresolved. */
  subject: string;
  visibility: 'private' | 'world';
}

export type FactKeysSkipReason = 'disabled' | 'superseded' | 'protected' | 'not_title_mode' | 'embed_skip'
  | 'embedding_unconfigured' | 'embed_failed' | 'withdrawal_changed';

export type FactKeysPublishResult =
  | { published: true; items: number; chunks_rekeyed: number }
  | { published: false; reason: FactKeysSkipReason; detail?: string };

type EmbedFn = (texts: string[], opts?: { abortSignal?: AbortSignal }) => Promise<Float32Array[]>;

export async function factKeysEnabled(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  const value = (await engine.getConfig(FACT_KEYS_CONFIG_KEY))?.trim().toLowerCase();
  return value === 'on' || value === 'true' || value === '1';
}

/**
 * Binds key publication to the exact text the extractor reads. Null when the
 * feature is off or the stored page no longer holds `text`; extraction then
 * proceeds as before and publishes no keys.
 */
export async function bindFactKeysSnapshot(engine: BrainEngine, sourceId: string, slug: string | undefined, text: string): Promise<FactKeysBinding | null> {
  if (!slug || !await factKeysEnabled(engine)) return null;
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot || snapshot.page.deleted_at || snapshot.page.compiled_truth !== text) return null;
  return { sourceId, slug, pageId: snapshot.page.id, revision: snapshot.revision, sourceIncarnation: snapshot.sourceIncarnation, text };
}

function hasProtectedFence(body: string): boolean {
  return body.includes(FACTS_FENCE_BEGIN) || body.includes(TAKES_FENCE_BEGIN);
}

async function pageIsWorldVisible(engine: BrainEngine, pageId: number): Promise<boolean> {
  const [row] = await engine.executeRaw<{ world: boolean }>(`SELECT (${privatePagesFilterFragment('p')}) AS world FROM pages p WHERE p.id=$1`, [pageId]);
  return row?.world === true;
}

/** Items that may key this page: not withdrawn, and never a private fact on a world page. */
async function admissibleItems(engine: BrainEngine, sourceId: string, pageId: number, items: readonly FactKeyItem[]): Promise<FactKeyItem[]> {
  if (!items.length) return [];
  const world = await pageIsWorldVisible(engine, pageId);
  const visible = items.filter(item => !world || item.visibility === 'world');
  if (!visible.length) return [];
  const withdrawn = await engine.executeRaw<{ i: number }>(`SELECT DISTINCT k.i FROM jsonb_to_recordset($2::text::jsonb) k(i int,text text,subject text,visibility text)
    JOIN fact_withdrawals w ON w.source_id=$1 AND w.visibility=k.visibility
      AND w.fact_hash IN (gbrain_fact_fingerprint(k.text),gbrain_fact_fingerprint_v1(k.text))
      AND (w.subject='*' OR k.subject='*' OR w.subject=k.subject)`,
  [sourceId, JSON.stringify(visible.map((item, i) => ({ i, ...item })))]);
  const drop = new Set(withdrawn.map(row => Number(row.i)));
  return visible.filter((_, i) => !drop.has(i));
}

async function vectorColumns(engine: BrainEngine): Promise<string[]> {
  const rows = await engine.executeRaw<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
    WHERE table_name='content_chunks' AND udt_name IN ('vector','halfvec') AND column_name<>'embedding_image'`);
  return rows.map(row => row.column_name);
}

function sameInventory(a: ProjectionSnapshot['chunks'], b: ProjectionSnapshot['chunks']): boolean {
  return a.length === b.length && a.every((chunk, i) => chunk.id === b[i].id && chunk.chunk_index === b[i].chunk_index
    && chunk.chunk_text === b[i].chunk_text && (chunk.fact_keys ?? null) === (b[i].fact_keys ?? null));
}

/**
 * Publish occurrence keys for one bound page revision (`items` empty clears
 * them). `force` publishes even when the feature is off; the disable sweep
 * uses it with no items to strip keys.
 */
export async function publishPageFactKeys(engine: BrainEngine, binding: FactKeysBinding, rawItems: readonly FactKeyItem[],
  opts: { embed?: EmbedFn; force?: boolean; abortSignal?: AbortSignal } = {}): Promise<FactKeysPublishResult> {
  const clearing = rawItems.length === 0;
  if (!opts.force && !await factKeysEnabled(engine)) return { published: false, reason: 'disabled' };
  const prepared = await readProjectionSnapshot(engine, binding.slug, binding.sourceId, { requireLiveSource: true });
  const page = prepared?.snapshot.page;
  if (!prepared || !page || prepared.snapshot.revision !== binding.revision || page.id !== binding.pageId
    || prepared.snapshot.sourceIncarnation !== binding.sourceIncarnation || page.compiled_truth !== binding.text) {
    return { published: false, reason: 'superseded' };
  }
  if (!clearing) {
    if (Object.hasOwn(page.frontmatter ?? {}, 'embed_skip')) return { published: false, reason: 'embed_skip' };
    if (page.contextual_retrieval_mode !== 'title') return { published: false, reason: 'not_title_mode' };
    if (hasProtectedFence(page.compiled_truth) || hasProtectedFence(page.timeline ?? '')) return { published: false, reason: 'protected' };
  }
  const items = await admissibleItems(engine, binding.sourceId, page.id, rawItems);
  const keys = items.length ? assignFactKeys(items.map(item => item.text), prepared.chunks, 'chunk') : prepared.chunks.map(() => null);
  const changed = prepared.chunks.map((chunk, i) => ({ chunk, keys: keys[i] })).filter(({ chunk, keys: next }) => next !== (chunk.fact_keys ?? null));

  const canEmbed = !!opts.embed || !!currentEmbeddingSignature();
  let vectors: Float32Array[] = [];
  if (changed.length && canEmbed) {
    try {
      vectors = await (opts.embed ?? embedBatch)(
        wrapChunkTextsForStoredMode(page, changed.map(({ chunk, keys: next }) => ({ ...chunk, fact_keys: next }))),
        opts.abortSignal ? { abortSignal: opts.abortSignal } : {});
    } catch (error) {
      return { published: false, reason: 'embed_failed', detail: error instanceof Error ? error.message : String(error) };
    }
    if (vectors.length !== changed.length || vectors.some(v => !v?.length)) return { published: false, reason: 'embed_failed', detail: 'incomplete embedding batch' };
  } else if (changed.length && !clearing) {
    return { published: false, reason: 'embedding_unconfigured' };
  }

  class Abort extends Error { constructor(readonly reason: FactKeysSkipReason) { super(reason); } }
  try {
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx as never);
      await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR SHARE', [binding.sourceId]);
      await tx.lockPageKeys([{ sourceId: binding.sourceId, slug: binding.slug }]);
      const current = await tx.readPageSnapshot(binding.slug, { sourceId: binding.sourceId });
      if (!current || current.page.deleted_at || current.revision !== binding.revision || current.page.id !== binding.pageId
        || current.sourceIncarnation !== binding.sourceIncarnation || current.page.compiled_truth !== binding.text
        || current.page.text_projection_revision !== current.revision) throw new Abort('superseded');
      if (!sameInventory(await tx.getChunks(binding.slug, { sourceId: binding.sourceId, includeUnsealed: true }), prepared.chunks)) throw new Abort('superseded');
      if (!opts.force && !await factKeysEnabled(tx)) throw new Abort('disabled');
      const recheck = await admissibleItems(tx, binding.sourceId, page.id, rawItems);
      if (recheck.length !== items.length || recheck.some((item, i) => item !== items[i])) throw new Abort('withdrawal_changed');
      await tx.executeRaw('DELETE FROM page_fact_keys WHERE page_id=$1', [page.id]);
      if (items.length) {
        await tx.executeRaw(`INSERT INTO page_fact_keys (page_id,source_id,page_revision,ordinal,item_text,item_fingerprint,subject,visibility,extractor_version)
          SELECT $1,$2,$3,k.ordinal,k.text,gbrain_fact_fingerprint(k.text),k.subject,k.visibility,$4
          FROM jsonb_to_recordset($5::text::jsonb) k(ordinal int,text text,subject text,visibility text)`,
        [page.id, binding.sourceId, binding.revision, FACT_KEYS_EXTRACTOR_VERSION,
          JSON.stringify(items.map((item, ordinal) => ({ ordinal, text: item.text, subject: item.subject, visibility: item.visibility })))]);
      }
      if (!changed.length) return;
      const ids = changed.map(({ chunk }) => chunk.id);
      await tx.executeRaw(`UPDATE content_chunks c SET fact_keys=k.keys FROM jsonb_to_recordset($2::text::jsonb) k(id int,keys text)
        WHERE c.page_id=$1 AND c.id=k.id`, [page.id, JSON.stringify(changed.map(({ chunk, keys: next }) => ({ id: chunk.id, keys: next })))]);
      const others = (await vectorColumns(tx)).filter(name => name !== prepared.embeddingColumn.name);
      if (others.length) {
        await tx.executeRaw(`UPDATE content_chunks SET ${others.map(name => `${quoteIdentifier(name)}=NULL`).join(',')} WHERE page_id=$1 AND id=ANY($2::int[])`, [page.id, ids]);
      }
      if (!vectors.length) {
        await tx.executeRaw(`UPDATE content_chunks SET ${quoteIdentifier(prepared.embeddingColumn.name)}=NULL,embedded_at=NULL,
          embedded_text_hash=NULL,embedding_input_hash=NULL WHERE page_id=$1 AND id=ANY($2::int[])`, [page.id, ids]);
        return;
      }
      const rekeyed: ProjectionSnapshot = { ...prepared, chunks: prepared.chunks.map((chunk, i) => ({ ...chunk, fact_keys: keys[i] })) };
      const installed = await installPageEmbeddings(tx, rekeyed, changed.map(({ chunk, keys: next }, i): ChunkInput => ({
        chunk_index: chunk.chunk_index, chunk_text: chunk.chunk_text, chunk_source: chunk.chunk_source,
        embedding: vectors[i], model: prepared.embeddingModel ?? undefined, fact_keys: next,
      })));
      if (!installed) throw new Abort('superseded');
    });
  } catch (error) {
    if (error instanceof Abort) return { published: false, reason: error.reason };
    throw error;
  }
  return { published: true, items: items.length, chunks_rekeyed: changed.length };
}

/** Remove a page's keys (prepare-then-swap with no items), whatever the setting. */
export async function clearPageFactKeys(engine: BrainEngine, sourceId: string, slug: string, opts: { embed?: EmbedFn } = {}): Promise<FactKeysPublishResult> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot || snapshot.page.deleted_at) return { published: false, reason: 'superseded' };
  return publishPageFactKeys(engine, { sourceId, slug, pageId: snapshot.page.id, revision: snapshot.revision,
    sourceIncarnation: snapshot.sourceIncarnation, text: snapshot.page.compiled_truth }, [], { ...opts, force: true });
}

/**
 * The facts backstop's hook: occurrence keys from the extractor's own output
 * for the bound revision, captured before notability filtering and dedup.
 * Never throws; a failed publication leaves the previous keys and vectors.
 */
export async function publishExtractedFactKeys(engine: BrainEngine, binding: FactKeysBinding,
  input: { pageSlug?: string; turnText: string },
  facts: ReadonlyArray<{ fact?: unknown; entity_slug?: string | null }>, visibility: 'private' | 'world',
  resolve: (engine: BrainEngine, sourceId: string, ref: string) => Promise<{ slug: string; source: string } | null>,
  abortSignal?: AbortSignal): Promise<FactKeysPublishResult> {
  if (input.pageSlug !== binding.slug || input.turnText !== binding.text) return { published: false, reason: 'superseded' };
  try {
    const items: FactKeyItem[] = [];
    for (const f of facts) {
      if (typeof f.fact !== 'string' || !f.fact.trim()) continue;
      const resolved = f.entity_slug ? await resolve(engine, binding.sourceId, f.entity_slug) : null;
      items.push({ text: f.fact, subject: resolved && resolved.source !== 'fallback_slugify' ? resolved.slug : '*', visibility });
    }
    return await publishPageFactKeys(engine, binding, items, { abortSignal });
  } catch (error) {
    return { published: false, reason: 'superseded', detail: error instanceof Error ? error.message : String(error) };
  }
}
