import type { BrainEngine } from '../engine.ts';
import { factsBackstopEligibleSql } from './eligibility.ts';
import { factKeysEnabled } from './fact-keys-publish.ts';

export interface FactKeysStatus {
  enabled: boolean;
  keyed_pages: number;
  keyed_chunks: number;
  key_rows: number;
  eligible_unkeyed_pages: number;
  stale_rows_pages: number;
}

/** Title-mode, sealed pages without protected fences that the facts backstop would extract. */
export const FACT_KEYS_ELIGIBLE_SQL = `p.deleted_at IS NULL AND p.contextual_retrieval_mode='title' AND p.text_projection_revision=p.knowledge_revision
  AND NOT (p.frontmatter ? 'embed_skip') AND strpos(p.compiled_truth,'gbrain:facts:')=0 AND strpos(p.compiled_truth,'gbrain:takes:')=0
  AND ${factsBackstopEligibleSql('p')}`;

export async function factKeysStatus(engine: BrainEngine): Promise<FactKeysStatus> {
  const [row] = await engine.executeRaw<Record<string, number>>(`SELECT
      (SELECT count(DISTINCT page_id) FROM content_chunks WHERE fact_keys IS NOT NULL)::int AS keyed_pages,
      (SELECT count(*) FROM content_chunks WHERE fact_keys IS NOT NULL)::int AS keyed_chunks,
      (SELECT count(*) FROM page_fact_keys)::int AS key_rows,
      (SELECT count(*) FROM pages p WHERE ${FACT_KEYS_ELIGIBLE_SQL}
        AND NOT EXISTS (SELECT 1 FROM page_fact_keys k WHERE k.page_id=p.id AND k.page_revision=p.knowledge_revision::text))::int AS eligible_unkeyed_pages,
      (SELECT count(DISTINCT k.page_id) FROM page_fact_keys k JOIN pages p ON p.id=k.page_id
        WHERE k.page_revision=p.knowledge_revision::text
          AND NOT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND c.fact_keys IS NOT NULL))::int AS stale_rows_pages`);
  return {
    enabled: await factKeysEnabled(engine),
    keyed_pages: Number(row.keyed_pages), keyed_chunks: Number(row.keyed_chunks), key_rows: Number(row.key_rows),
    eligible_unkeyed_pages: Number(row.eligible_unkeyed_pages), stale_rows_pages: Number(row.stale_rows_pages),
  };
}
