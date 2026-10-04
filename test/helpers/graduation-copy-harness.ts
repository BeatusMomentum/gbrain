/**
 * Test-only stand-ins for the graduation inventory lane: a local inventory
 * derived from information_schema (every base table present on both engines,
 * with the plan's non-carry classes and transforms), an FK topological order,
 * and canonical per-table snapshots for comparing a source with its copy.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GraduationEngines, InventoryClass, InventoryEntry, TriggerBypass } from '../../src/core/persistence/engine-graduation.types.ts';
import { carryRowFilter, copyTable, tableColumns, transformFor } from '../../src/core/persistence/graduation-copy.ts';

export const LOCAL_NON_CARRY: Readonly<Record<string, InventoryClass>> = {
  planner_stats_deltas: 'discard', planner_stats_state: 'discard', gbrain_cycle_locks: 'discard', budget_reservations: 'discard',
  subagent_rate_leases: 'discard', oauth_codes: 'discard', query_cache: 'rebuild', code_traversal_cache: 'rebuild',
  file_migration_ledger: 'schema_owned', persistence_graduation: 'schema_owned',
};

export const LOCAL_TRANSFORMS: Readonly<Record<string, readonly string[]>> = {
  minion_jobs: ['status', 'lock_token', 'lock_until', 'timeout_at', 'started_at'],
  persistence_worktrees: ['heartbeat_at'],
  persistence_effects: ['state', 'execution_token', 'claim_expires_at'],
  persistence_brain: ['enabled'],
};

async function baseTables(engine: BrainEngine): Promise<string[]> {
  const rows = await engine.executeRaw<{ name: string }>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1");
  return rows.map(r => r.name);
}

/** Carry and rebind entries for every table present on both engines, in FK topological order. */
export async function localCopyInventory(e: GraduationEngines): Promise<InventoryEntry[]> {
  const target = new Set(await baseTables(e.target));
  const tables = (await baseTables(e.source)).filter(t => target.has(t) && !(t in LOCAL_NON_CARRY));
  const edges = await e.source.executeRaw<{ child: string; parent: string }>(`SELECT c.relname AS child, p.relname AS parent
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
    WHERE k.contype = 'f' AND k.conrelid <> k.confrelid`);
  const parents = new Map(tables.map(t => [t, new Set<string>()]));
  for (const edge of edges) if (parents.has(edge.child) && parents.has(edge.parent)) parents.get(edge.child)!.add(edge.parent);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string, path: Set<string>) => {
    if (seen.has(t)) return;
    if (path.has(t)) throw new Error(`FK cycle at ${t}`);
    path.add(t);
    for (const p of [...parents.get(t)!].sort()) visit(p, path);
    path.delete(t); seen.add(t); ordered.push(t);
  };
  for (const t of tables) visit(t, new Set());
  return ordered.map(relation => ({
    relation, kind: 'table', class: relation === 'persistence_brain' ? 'rebind' : 'carry', engines: { pglite: true, postgres: true },
    lossKind: 'user_data', transforms: (LOCAL_TRANSFORMS[relation] ?? []).map(column => ({ column, rule: transformFor(relation, column).rule })),
    reason: 'test inventory',
  }));
}

export async function copyAll(e: GraduationEngines, entries: readonly InventoryEntry[], opts: { bypass: TriggerBypass; runId: string; batchBytes?: number }):
  Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.relation] = (await copyTable(e, entry, opts)).rows;
  return counts;
}

export interface TableSnapshot { relation: string; rows: number; sha256: string; keys: string[]; lines: string[] }

/**
 * Canonical snapshot: every column (generated ones included, in name order, since
 * the engines' physical column order differs) as text under
 * UTC/ISO rendering, ordered by primary key with COLLATE "C". With
 * `applyTransforms` the entry's transforms are applied, so a source snapshot
 * compares equal to its copy.
 */
export async function tableSnapshot(engine: BrainEngine, entry: InventoryEntry, opts: { applyTransforms?: boolean } = {}): Promise<TableSnapshot> {
  const columns = (await tableColumns(engine, entry.relation)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const transforms = new Map(opts.applyTransforms ? entry.transforms.map(t => [t.column, transformFor(entry.relation, t.column)]) : []);
  const identOf = (name: string) => columns.find(c => c.name === name)!.ident;
  const pk = await engine.executeRaw<{ name: string }>(`SELECT a.attname AS name FROM pg_constraint k CROSS JOIN LATERAL unnest(k.conkey) WITH ORDINALITY AS u(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum WHERE k.contype = 'p' AND k.conrelid = to_regclass(format('public.%I', $1::text)) ORDER BY u.ord`, [entry.relation]);
  const order = pk.map(p => { const c = columns.find(col => col.name === p.name)!; return c.collatable ? `${c.ident} COLLATE "C"` : c.ident; }).join(', ');
  const select = columns.map((c, i) => `(${transforms.get(c.name)?.sql(identOf) ?? c.ident})::text AS c${i}`).join(', ');
  const filter = carryRowFilter(entry.relation);
  const [{ ident }] = await engine.executeRaw<{ ident: string }>("SELECT format('%I', $1::text) AS ident", [entry.relation]);
  const rows = await engine.transaction(async tx => {
    for (const s of ["SET LOCAL TimeZone = 'UTC'", "SET LOCAL DateStyle = 'ISO'", 'SET LOCAL extra_float_digits = 3']) await tx.executeRaw(s);
    return tx.executeRaw<Record<string, string | null>>(`SELECT ${select} FROM ${ident}${filter ? ` WHERE ${filter}` : ''} ORDER BY ${order}`);
  });
  const pkIndex = pk.map(p => columns.findIndex(c => c.name === p.name));
  const lines = rows.map(r => JSON.stringify(columns.map((_, i) => r[`c${i}`] ?? null)));
  const keys = rows.map(r => JSON.stringify(pkIndex.map(i => r[`c${i}`] ?? null)));
  return { relation: entry.relation, rows: rows.length, sha256: createHash('sha256').update(lines.join('\n')).digest('hex'), keys, lines };
}

/** First differing row between two snapshots, for a readable assertion message. */
export function firstDifference(a: TableSnapshot, b: TableSnapshot): string | null {
  if (a.sha256 === b.sha256) return null;
  for (let i = 0; i < Math.max(a.lines.length, b.lines.length); i++) {
    if (a.lines[i] !== b.lines[i]) return `${a.relation} row ${i}: source ${a.lines[i] ?? '<none>'} target ${b.lines[i] ?? '<none>'}`.slice(0, 2000);
  }
  return `${a.relation}: digests differ`;
}
