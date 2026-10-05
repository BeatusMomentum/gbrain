import type { BrainEngine } from '../engine.ts';

/**
 * Rows for any revision other than the page's current one are never used
 * again. Every path that seals a new chunk set calls this in its transaction;
 * the replacement chunks carry no keys, and upsertChunks drops any vector whose
 * key text changed.
 */
export async function retireStaleFactKeys(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string): Promise<void> {
  await tx.executeRaw(`DELETE FROM page_fact_keys k USING pages p WHERE p.id=k.page_id AND p.source_id=$1 AND p.slug=$2
    AND k.page_revision IS DISTINCT FROM p.knowledge_revision::text`, [sourceId, slug]);
}
