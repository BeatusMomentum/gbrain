/**
 * Triplet scoring for the relational (typed-edge) recall arm.
 *
 * Each edge on a candidate's representative path is a triplet (from page,
 * edge, to page). Its score sums three distances to the query, each in
 * [0, 2] and scaled by (2 − importance):
 *   - page distance: 1 − cosine(query vector, the page's first chunk vector),
 *     in the same embedding column the vector arm used; lexical fallback
 *     (1 − content-term overlap with the title) without a query vector;
 *   - edge distance: 1 − content-term overlap of the query with the
 *     humanized link type plus the link's context sentence;
 *   - a missing part (no chunk, no vector, no context) costs a fixed penalty.
 * Importance is the element's learned feedback weight mapped into
 * 0.5 ± λ (neutral 0.5 when feedback is off). A candidate's score is its
 * worst triplet, so one irrelevant hop is never hidden by a relevant one.
 * Lower is better; ties keep the fanout order. Fail-open.
 */
import type { BrainEngine } from '../engine.ts';
import type { SearchResult } from '../types.ts';
import { contentTerms } from './crag.ts';
import { effectiveInfluence, loadFeedbackSettings } from '../feedback/settings.ts';
import { NEUTRAL_WEIGHT, readWeights } from '../feedback/store.ts';

export const DEFAULT_TRIPLET_PENALTY = 3.0;

export interface TripletSettings {
  enabled: boolean;
  penalty: number;
}

const CACHE_TTL_MS = 30_000;
let cache: { ts: number; engine: BrainEngine; value: TripletSettings } | null = null;

export async function loadTripletSettings(engine: BrainEngine): Promise<TripletSettings> {
  const now = Date.now();
  if (cache && cache.engine === engine && now - cache.ts < CACHE_TTL_MS) return cache.value;
  const get = async (k: string) => { try { return await engine.getConfig(k); } catch { return null; } };
  const [on, penalty] = await Promise.all([get('search.triplet_scoring'), get('search.triplet_penalty')]);
  const p = Number(penalty);
  const value: TripletSettings = {
    enabled: ['true', '1', 'on', 'yes'].includes((on ?? '').trim().toLowerCase()),
    penalty: Number.isFinite(p) && p > 0 && p <= 10 ? p : DEFAULT_TRIPLET_PENALTY,
  };
  cache = { ts: now, engine, value };
  return value;
}

export function _resetTripletSettingsCacheForTests(): void {
  cache = null;
}

export function termOverlap(queryTerms: Set<string>, text: string): number {
  if (queryTerms.size === 0) return 0;
  const terms = contentTerms(text);
  let hit = 0;
  for (const t of queryTerms) if (terms.has(t)) hit++;
  return hit / queryTerms.size;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

export interface TripletInputs {
  queryTerms: Set<string>;
  penalty: number;
  /** distance in [0, 2] per page key 'source:slug', absent = missing */
  pageDistance: Map<string, number>;
  /** context text per edge key 'source:from|type|to' ('' = no context), absent = unknown edge */
  edgeContext: Map<string, string>;
  pageImportance: Map<string, number>;
  edgeImportance: Map<string, number>;
}

/** Pure scorer: worst triplet per row (lower is better). */
export function scoreRow(row: SearchResult, inp: TripletInputs): SearchResult['triplet'] | undefined {
  const source = row.source_id ?? 'default';
  const edges = row.relational_path_edges ?? [];
  if (edges.length === 0) return undefined;
  const parts: NonNullable<SearchResult['triplet']>['parts'] = [];
  for (const edge of edges) {
    const [from, type, to] = edge.split('|');
    if (!from || !type || !to) continue;
    const scale = (imp: number | undefined) => 2 - (imp ?? NEUTRAL_WEIGHT);
    const dist = (key: string) => inp.pageDistance.get(key) ?? inp.penalty;
    const fromKey = `${source}:${from}`;
    const toKey = `${source}:${to}`;
    const edgeKey = `${source}:${edge}`;
    const ctx = inp.edgeContext.get(edgeKey);
    const edgeText = `${type.replace(/[_-]+/g, ' ')} ${ctx ?? ''}`;
    const edgeDistance = ctx === undefined || ctx === ''
      ? inp.penalty
      : 1 - termOverlap(inp.queryTerms, edgeText);
    const f = dist(fromKey) * scale(inp.pageImportance.get(fromKey));
    const e = edgeDistance * scale(inp.edgeImportance.get(edgeKey));
    const t = dist(toKey) * scale(inp.pageImportance.get(toKey));
    parts.push({ edge, from: round(f), edge_distance: round(e), to: round(t), total: round(f + e + t) });
  }
  if (parts.length === 0) return undefined;
  return { worst: Math.max(...parts.map(p => p.total)), parts };
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Score and reorder the relational arm in place, then keep the first
 * `keep` rows. Returns true when scoring ran.
 */
export async function applyTripletScoring(
  engine: BrainEngine,
  query: string,
  list: SearchResult[],
  opts: { queryEmbedding: Float32Array | null; column: string; keep: number; penalty: number },
): Promise<boolean> {
  if (list.length === 0) return false;
  try {
    const pageKeys = new Map<string, { source_id: string; slug: string }>();
    const edgeKeys = new Map<string, { source_id: string; from: string; type: string; to: string }>();
    for (const r of list) {
      const source = r.source_id ?? 'default';
      for (const edge of r.relational_path_edges ?? []) {
        const [from, type, to] = edge.split('|');
        if (!from || !type || !to) continue;
        pageKeys.set(`${source}:${from}`, { source_id: source, slug: from });
        pageKeys.set(`${source}:${to}`, { source_id: source, slug: to });
        edgeKeys.set(`${source}:${edge}`, { source_id: source, from, type, to });
      }
    }
    if (edgeKeys.size === 0) return false;
    const pages = [...pageKeys.values()];
    const chunkRows = await engine.executeRaw<{ source_id: string; slug: string; title: string; chunk_id: number | string | null }>(
      `SELECT p.source_id, p.slug, p.title,
              (SELECT cc.id FROM content_chunks cc WHERE cc.page_id = p.id ORDER BY cc.chunk_index ASC LIMIT 1) AS chunk_id
         FROM pages p
         JOIN unnest($1::text[], $2::text[]) AS r(source_id, slug) ON p.source_id = r.source_id AND p.slug = r.slug
        WHERE p.deleted_at IS NULL`,
      [pages.map(p => p.source_id), pages.map(p => p.slug)],
    );
    const queryTerms = contentTerms(query);
    const pageDistance = new Map<string, number>();
    if (opts.queryEmbedding) {
      const ids = chunkRows.map(r => r.chunk_id).filter((id): id is number | string => id != null).map(Number);
      const vectors = ids.length > 0 ? await engine.getEmbeddingsByChunkIds(ids, opts.column) : new Map<number, Float32Array>();
      for (const r of chunkRows) {
        const v = r.chunk_id == null ? undefined : vectors.get(Number(r.chunk_id));
        if (v) pageDistance.set(`${r.source_id}:${r.slug}`, 1 - cosine(opts.queryEmbedding, v));
      }
    } else {
      for (const r of chunkRows) pageDistance.set(`${r.source_id}:${r.slug}`, 1 - termOverlap(queryTerms, `${r.title} ${r.slug.replace(/[/_-]+/g, ' ')}`));
    }
    const edges = [...edgeKeys.values()];
    const ctxRows = await engine.executeRaw<{ source_id: string; from_slug: string; link_type: string; to_slug: string; context: string }>(
      `SELECT fp.source_id, fp.slug AS from_slug, l.link_type, tp.slug AS to_slug, max(l.context) AS context
         FROM links l
         JOIN pages fp ON fp.id = l.from_page_id
         JOIN pages tp ON tp.id = l.to_page_id
         JOIN unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS e(source_id, from_slug, link_type, to_slug)
           ON fp.source_id = e.source_id AND fp.slug = e.from_slug AND l.link_type = e.link_type AND tp.slug = e.to_slug
        GROUP BY fp.source_id, fp.slug, l.link_type, tp.slug`,
      [edges.map(e => e.source_id), edges.map(e => e.from), edges.map(e => e.type), edges.map(e => e.to)],
    );
    const edgeContext = new Map<string, string>();
    for (const r of ctxRows) edgeContext.set(`${r.source_id}:${r.from_slug}|${r.link_type}|${r.to_slug}`, r.context ?? '');

    const settings = await loadFeedbackSettings(engine);
    const influence = effectiveInfluence(settings);
    const toImportance = (w: number) => NEUTRAL_WEIGHT + influence * 2 * (w - NEUTRAL_WEIGHT);
    const pageImportance = new Map<string, number>();
    const edgeImportance = new Map<string, number>();
    if (influence > 0) {
      const pw = await readWeights(engine, 'page', pages.map(p => ({ source_id: p.source_id, key: p.slug })));
      for (const [k, w] of pw) pageImportance.set(k, toImportance(w));
      const ew = await readWeights(engine, 'link', edges.map(e => ({ source_id: e.source_id, key: `${e.from}|${e.type}|${e.to}` })));
      for (const [k, w] of ew) edgeImportance.set(k, toImportance(w));
    }

    const inputs: TripletInputs = { queryTerms, penalty: opts.penalty, pageDistance, edgeContext, pageImportance, edgeImportance };
    const scored = list.map((r, index) => {
      const t = scoreRow(r, inputs);
      if (t) r.triplet = t;
      return { r, index, score: t?.worst ?? Number.POSITIVE_INFINITY };
    });
    scored.sort((a, b) => (a.score - b.score) || (a.index - b.index));
    list.splice(0, list.length, ...scored.slice(0, Math.max(1, opts.keep)).map(s => s.r));
    return true;
  } catch {
    list.splice(opts.keep);
    return false;
  }
}
