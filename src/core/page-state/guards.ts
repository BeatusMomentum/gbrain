import type { BrainEngine } from '../engine.ts';
import { validateSlug } from '../utils.ts';
import type { PageKey } from './types.ts';

type SqlExecutor = Pick<BrainEngine, 'executeRaw'>;
const keyId = (sourceId: string, slug: string) => JSON.stringify([sourceId, slug]);

function orderedPageKeys(keys: readonly PageKey[]): PageKey[] {
  const unique = new Map<string, PageKey>();
  for (const key of keys) {
    if (!key.sourceId) throw new TypeError('A page guard requires an exact sourceId');
    const slug = validateSlug(key.slug);
    unique.set(keyId(key.sourceId, slug), { sourceId: key.sourceId, slug });
  }
  return [...unique.values()].sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
}

/**
 * Locks sorted sources (FOR SHARE), then the sorted page guards, then the
 * sorted pages rows, in three statements for any number of keys (#6007).
 */
async function lockOrderedPageKeys(engine: SqlExecutor, ordered: readonly PageKey[]): Promise<void> {
  if (!ordered.length) return;
  const sourceIds = [...new Set(ordered.map(key => key.sourceId))];
  // Every source row is share-locked, in key order, before the first guard
  // row is inserted: the insert is gated on reading the whole locked set.
  const sources = await engine.executeRaw<{ id: string; incarnation: string }>(`WITH s AS MATERIALIZED (
      SELECT src.id,src.incarnation FROM unnest($1::text[]) WITH ORDINALITY AS u(id,n) JOIN sources src ON src.id=u.id ORDER BY u.n FOR SHARE OF src),
    created AS (INSERT INTO page_write_guards(source_incarnation,slug)
      SELECT s.incarnation,k.s FROM unnest($2::text[],$3::text[]) WITH ORDINALITY AS k(src,s,n) JOIN s ON s.id=k.src
      WHERE (SELECT count(*) FROM s)=cardinality($1::text[]) ORDER BY k.n ON CONFLICT DO NOTHING)
    SELECT id,incarnation FROM s`, [sourceIds, ordered.map(key => key.sourceId), ordered.map(key => key.slug)]);
  const incarnations = new Map(sources.map(row => [row.id, row.incarnation]));
  const missing = sourceIds.find(id => !incarnations.has(id));
  if (missing !== undefined) throw new Error(`Page source does not exist: ${missing}`);
  await engine.executeRaw(`SELECT g.slug FROM unnest($1::uuid[],$2::text[]) WITH ORDINALITY AS k(i,s,n)
    JOIN page_write_guards g ON g.source_incarnation=k.i AND g.slug=k.s ORDER BY k.n FOR UPDATE OF g`,
  [ordered.map(key => incarnations.get(key.sourceId)!), ordered.map(key => key.slug)]);
  // Also fence direct SQL row writers. The guard remains when this row is absent.
  await engine.executeRaw(`SELECT p.id FROM unnest($1::text[],$2::text[]) WITH ORDINALITY AS k(src,s,n)
    JOIN pages p ON p.source_id=k.src AND p.slug=k.s ORDER BY k.n FOR UPDATE OF p`, [ordered.map(key => key.sourceId), ordered.map(key => key.slug)]);
}

/** Source locks precede auth/request locks in callers; repeat held locks safely. */
export async function lockPageKeys(engine: SqlExecutor, keys: readonly PageKey[]): Promise<void> {
  await lockOrderedPageKeys(engine, orderedPageKeys(keys));
}

/**
 * Guards a transaction already holds, chained through its open savepoints.
 * The transaction's session owns them until the transaction or savepoint
 * ends, so they are not re-acquired. That includes a key whose pages row was
 * absent when it was locked: the only pages INSERT (engine-sql/pages.ts
 * putPage) runs after both engines' putPage take the same guard, so no other
 * transaction can create that row while the guard is held.
 */
export interface HeldPageKeys { keys: Set<string>; parent: HeldPageKeys | null }
function pageGuardKey(key: PageKey): string | null {
  if (!key.sourceId) return null;
  try { return keyId(key.sourceId, validateSlug(key.slug)); } catch { return null; }
}
function holds(held: HeldPageKeys | null, id: string): boolean {
  for (; held; held = held.parent) if (held.keys.has(id)) return true;
  return false;
}
/** lockPageKeys for keys this transaction does not hold yet; invalid keys still reach its checks. */
export async function lockUnheldPageKeys(engine: SqlExecutor, held: HeldPageKeys, keys: readonly PageKey[]): Promise<void> {
  const pending = keys.filter(key => { const id = pageGuardKey(key); return id === null || !holds(held, id); });
  if (!pending.length) return;
  await lockPageKeys(engine, pending);
  for (const key of pending) held.keys.add(pageGuardKey(key)!);
}
/** Runs a transaction or savepoint; a released savepoint's guards stay held by its parent, a rolled-back one's do not. */
export async function withHeldPageKeys<T>(parent: HeldPageKeys | null, run: (held: HeldPageKeys) => Promise<T>): Promise<T> {
  const held: HeldPageKeys = { keys: new Set(), parent };
  const result = await run(held);
  for (const key of held.keys) parent?.keys.add(key);
  return result;
}
