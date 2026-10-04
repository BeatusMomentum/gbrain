/**
 * Engine graduation copier (Route B, in process): copies each carried table
 * from the PGLite source into the fenced Postgres target verbatim, primary
 * keys and every column preserved.
 *
 * - Per-column contract: source and target columns must match by name, type
 *   and typmod (`format_type`) and generation expression, outside the
 *   inventory entry's `columnAllowlist`; generated columns are never inserted.
 * - Each table copies in one target transaction that carries the run's fence
 *   identity (`gbrain.graduation_run`), bypasses user triggers
 *   (`session_replication_role = replica`, or DISABLE/ENABLE TRIGGER by name
 *   inside the same transaction, never the fence), deletes the target's rows
 *   for that table (initSchema seed rows included; config keeps its
 *   target-owned keys) and inserts the source rows.
 * - Values travel as canonical text and are cast back with the column's own
 *   type, one jsonb parameter per batch (far below the 65,535 bind-parameter
 *   limit), batches sized by bytes. Source batches are keyset-ordered by
 *   primary key with `COLLATE "C"` under UTC/ISO rendering settings.
 * - Self-referencing FKs copy in one pass under replica mode (no FK triggers)
 *   and in two passes (insert with NULL, then update) under DISABLE TRIGGER,
 *   where FK checks stay active.
 * - Inventory transforms (lease and claim resets) are applied from
 *   `COPY_TRANSFORMS`; the digest applies the same expressions to the source.
 * - Sequences are set to the source's exact position, raised to the target
 *   column maximum when that is higher.
 * - HNSW and GIN indexes are dropped before the copy and rebuilt after it; the
 *   pending list lives in a target-owned config row so a crash resumes it.
 */
import type { BrainEngine } from '../engine.ts';
import { ANN_BUILD_MESSAGE, buildDeferredAnnIndexes, type DeferredAnnIndex } from '../embedding-ann-build.ts';
import type { GraduationEngines, InventoryEntry, TriggerBypass } from './engine-graduation.types.ts';
import { graduationError } from './graduation-target.ts';

export const GRADUATION_DEFERRED_INDEXES_KEY = 'graduation.deferred_indexes';
/** Config keys each engine owns: the target keeps its own values and the copy never writes them. */
export const TARGET_OWNED_CONFIG_KEYS: readonly string[] = ['engine', 'version', GRADUATION_DEFERRED_INDEXES_KEY];
/** Default copy batch size in bytes of canonical text. */
export const DEFAULT_COPY_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_ROWS = 5000;
const FENCE_TRIGGER_PREFIX = 'gbrain_graduation_fence';
const RENDER_SETTINGS = ["SET LOCAL TimeZone = 'UTC'", "SET LOCAL DateStyle = 'ISO'", 'SET LOCAL extra_float_digits = 3', "SET LOCAL IntervalStyle = 'postgres'", "SET LOCAL bytea_output = 'hex'"];

/** Rows of a carried table that are not copied (and not digested): the target-owned config keys. */
export function carryRowFilter(relation: string): string | null {
  if (relation !== 'config') return null;
  return `NOT (key = ANY (ARRAY[${TARGET_OWNED_CONFIG_KEYS.map(k => `'${k.replace(/'/g, "''")}'`).join(', ')}]::text[]))`;
}

export interface CopyTransform {
  rule: string;
  /** SQL over the typed source values; `col(name)` renders another column of the same row. */
  sql: (col: (name: string) => string) => string;
}

const activeJob = (col: (name: string) => string, column: string) => `CASE WHEN ${col('status')} = 'active' THEN NULL ELSE ${col(column)} END`;
const claimedEffect = (col: (name: string) => string, column: string) => `CASE WHEN ${col('state')} IN ('running', 'queued') THEN NULL ELSE ${col(column)} END`;

/**
 * Every column transform graduation may apply, keyed `relation.column`. An
 * inventory entry lists the ones it uses; verify applies the same SQL to the
 * source snapshot, so nothing else may differ.
 */
export const COPY_TRANSFORMS: Readonly<Record<string, CopyTransform>> = {
  'minion_jobs.status': { rule: 'active -> waiting', sql: col => `CASE WHEN ${col('status')} = 'active' THEN 'waiting' ELSE ${col('status')} END` },
  'minion_jobs.lock_token': { rule: 'cleared on active jobs', sql: col => activeJob(col, 'lock_token') },
  'minion_jobs.lock_until': { rule: 'cleared on active jobs', sql: col => activeJob(col, 'lock_until') },
  'minion_jobs.timeout_at': { rule: 'cleared on active jobs', sql: col => activeJob(col, 'timeout_at') },
  'minion_jobs.started_at': { rule: 'cleared on active jobs', sql: col => activeJob(col, 'started_at') },
  'persistence_worktrees.heartbeat_at': { rule: 'reset', sql: () => 'NULL' },
  'persistence_effects.state': { rule: 'running -> queued', sql: col => `CASE WHEN ${col('state')} = 'running' THEN 'queued' ELSE ${col('state')} END` },
  'persistence_effects.execution_token': { rule: 'cleared on running and queued effects', sql: col => claimedEffect(col, 'execution_token') },
  'persistence_effects.claim_expires_at': { rule: 'cleared on running and queued effects', sql: col => claimedEffect(col, 'claim_expires_at') },
  'persistence_brain.enabled': { rule: 'false until cutover', sql: () => 'false' },
};

export function transformFor(relation: string, column: string): CopyTransform {
  const transform = COPY_TRANSFORMS[`${relation}.${column}`];
  if (!transform) throw new Error(`graduation inventory lists a transform for ${relation}.${column} that the copier does not implement`);
  return transform;
}

export interface ColumnMeta {
  name: string;
  ident: string;
  type: string;
  generated: boolean;
  generationExpr: string | null;
  collatable: boolean;
}

type Sql = Pick<BrainEngine, 'executeRaw'>;

async function relationIdent(engine: Sql, relation: string): Promise<string> {
  const [row] = await engine.executeRaw<{ ident: string; exists: boolean }>(
    "SELECT format('%I', $1::text) AS ident, to_regclass(format('public.%I', $1::text)) IS NOT NULL AS exists", [relation]);
  if (!row?.exists) throw new Error(`relation ${relation} does not exist`);
  return row.ident;
}

export async function tableColumns(engine: Sql, relation: string): Promise<ColumnMeta[]> {
  const rows = await engine.executeRaw<{ name: string; ident: string; type: string; generated: boolean; generation_expr: string | null; collatable: boolean }>(
    `SELECT a.attname AS name, format('%I', a.attname) AS ident, format_type(a.atttypid, a.atttypmod) AS type,
       a.attgenerated <> '' AS generated, CASE WHEN a.attgenerated <> '' THEN pg_get_expr(d.adbin, d.adrelid) END AS generation_expr,
       t.typcollation <> 0 AS collatable
     FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = to_regclass(format('public.%I', $1::text)) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [relation]);
  return rows.map(r => ({ name: r.name, ident: r.ident, type: r.type, generated: r.generated === true, generationExpr: r.generation_expr, collatable: r.collatable === true }));
}

async function constraintColumns(engine: Sql, relation: string, kind: 'p' | 'f-self'): Promise<string[]> {
  const rows = await engine.executeRaw<{ name: string }>(kind === 'p'
    ? `SELECT a.attname AS name FROM pg_constraint k CROSS JOIN LATERAL unnest(k.conkey) WITH ORDINALITY AS u(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum
       WHERE k.contype = 'p' AND k.conrelid = to_regclass(format('public.%I', $1::text)) ORDER BY u.ord`
    : `SELECT DISTINCT a.attname AS name FROM pg_constraint k CROSS JOIN LATERAL unnest(k.conkey) AS u(attnum)
         JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum
       WHERE k.contype = 'f' AND k.conrelid = k.confrelid AND k.conrelid = to_regclass(format('public.%I', $1::text)) ORDER BY 1`, [relation]);
  return rows.map(r => r.name);
}

const normalizeExpr = (expr: string | null) => (expr ?? '').replace(/\s+/g, ' ').trim();

/**
 * The per-column contract: every non-allowlisted column must exist on both
 * sides with the same type and typmod, and generated columns must carry the
 * same expression. Returns the columns the copy inserts (source order).
 */
export function columnContract(entry: Pick<InventoryEntry, 'relation' | 'columnAllowlist'>, source: readonly ColumnMeta[], target: readonly ColumnMeta[]): ColumnMeta[] {
  const allow = entry.columnAllowlist ?? {};
  const targetByName = new Map(target.map(c => [c.name, c]));
  const sourceNames = new Set(source.map(c => c.name));
  const problems: string[] = [];
  const copied: ColumnMeta[] = [];
  for (const column of source) {
    const other = targetByName.get(column.name);
    if (column.name in allow) { if (other && !other.generated && !column.generated && other.type === column.type) copied.push(column); continue; }
    if (!other) { problems.push(`${column.name} (${column.type}) is missing on the target`); continue; }
    if (other.type !== column.type) { problems.push(`${column.name} is ${column.type} on the source but ${other.type} on the target`); continue; }
    if (other.generated !== column.generated || normalizeExpr(other.generationExpr) !== normalizeExpr(column.generationExpr)) {
      problems.push(`${column.name} generation differs (source ${column.generationExpr ?? 'not generated'}, target ${other.generationExpr ?? 'not generated'})`);
      continue;
    }
    if (!column.generated) copied.push(column);
  }
  for (const column of target) {
    if (!sourceNames.has(column.name) && !(column.name in allow)) problems.push(`${column.name} (${column.type}) exists only on the target`);
  }
  if (problems.length) {
    throw graduationError('graduation_target_unsupported', `The target's ${entry.relation} columns do not match the source.`,
      'Use an empty target database created by this gbrain version; the column contract never copies into a different shape.',
      { why: `Graduation copies every column verbatim; ${entry.relation}: ${problems.join('; ')}.`, detail: problems.join('; '),
        fix: { argv: ['gbrain', 'migrate', '--plan', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
          why: 'Re-plans after the target is replaced or its schema is upgraded.', verify: { argv: ['gbrain', 'migrate', '--plan', '--json'] } } });
  }
  return copied;
}

export async function detectTriggerBypass(target: BrainEngine): Promise<TriggerBypass | null> {
  const rollback = Symbol('rollback');
  try {
    await target.transaction(async tx => { await tx.executeRaw('SET LOCAL session_replication_role = replica'); throw rollback; });
  } catch (error) {
    if (error === rollback) return 'session_replication_role';
  }
  const [row] = await target.executeRaw<{ owns: boolean }>(`SELECT COALESCE(bool_and(pg_has_role(current_user, c.relowner, 'USAGE')), true) AS owns
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`);
  return row?.owns ? 'disable_trigger' : null;
}

async function setFence(tx: Sql, runId: string): Promise<void> {
  await tx.executeRaw("SELECT set_config('gbrain.graduation_run', $1::text, true)", [runId]);
}

/** The run id the target fence admits: explicit, else the target's `persistence_graduation` row. */
async function fenceRunId(target: Sql, explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  const [table] = await target.executeRaw<{ present: boolean }>("SELECT to_regclass('public.persistence_graduation') IS NOT NULL AS present");
  if (!table?.present) return null;
  const [row] = await target.executeRaw<{ run_id: string }>('SELECT run_id::text AS run_id FROM persistence_graduation LIMIT 1');
  return row?.run_id ?? null;
}

type TriggerState = { ident: string; enabled: string };

async function userTriggers(tx: Sql, relation: string, enabledOnly: boolean): Promise<TriggerState[]> {
  return tx.executeRaw<TriggerState>(`SELECT format('%I', tgname) AS ident, tgenabled::text AS enabled FROM pg_trigger
    WHERE tgrelid = to_regclass(format('public.%I', $1::text)) AND NOT tgisinternal AND tgname NOT LIKE '${FENCE_TRIGGER_PREFIX}%'
      ${enabledOnly ? "AND tgenabled <> 'D'" : "AND tgenabled = 'D'"} ORDER BY tgname`, [relation]);
}

const ENABLE_BY_MODE: Readonly<Record<string, string>> = { O: 'ENABLE TRIGGER', A: 'ENABLE ALWAYS TRIGGER', R: 'ENABLE REPLICA TRIGGER' };

/**
 * Copies one carried (or rebind) table into the fenced target in a single
 * transaction and returns the number of source rows copied.
 */
export async function copyTable(e: GraduationEngines, entry: InventoryEntry,
  opts: { bypass: TriggerBypass; batchBytes?: number; onBatch?: (rows: number) => void; runId: string }): Promise<{ rows: number }> {
  if (entry.class !== 'carry' && entry.class !== 'rebind') throw new Error(`copyTable: ${entry.relation} is ${entry.class}, not carried`);
  const relation = entry.relation;
  const sourceColumns = await tableColumns(e.source, relation);
  const targetColumns = await tableColumns(e.target, relation);
  if (!sourceColumns.length) throw new Error(`copyTable: ${relation} does not exist on the source`);
  const columns = columnContract(entry, sourceColumns, targetColumns);
  const pk = await constraintColumns(e.source, relation, 'p');
  if (!pk.length) throw new Error(`copyTable: ${relation} has no primary key; the keyset copy needs one`);
  const transforms = new Map(entry.transforms.map(t => [t.column, transformFor(relation, t.column)]));
  const selfFk = opts.bypass === 'disable_trigger' ? (await constraintColumns(e.target, relation, 'f-self')).filter(c => columns.some(col => col.name === c)) : [];
  const sourceIdent = await relationIdent(e.source, relation);
  const targetIdent = await relationIdent(e.target, relation);
  const filter = carryRowFilter(relation);
  const index = new Map(columns.map((c, i) => [c.name, i]));
  const pkColumns = pk.map(name => {
    const column = columns.find(c => c.name === name);
    if (!column) throw new Error(`copyTable: primary key column ${relation}.${name} is not copied`);
    return column;
  });
  const typed = (name: string) => {
    const i = index.get(name);
    if (i === undefined) throw new Error(`copyTable: ${relation}.${name} is not a copied column`);
    return `((r.v->>${i})::${columns[i]!.type})`;
  };
  const insertExprs = columns.map(c => selfFk.includes(c.name) ? 'NULL' : transforms.get(c.name)?.sql(typed) ?? typed(c.name));
  const insertSql = `INSERT INTO ${targetIdent} (${columns.map(c => c.ident).join(', ')}) SELECT ${insertExprs.join(', ')} FROM jsonb_array_elements($1::jsonb) AS r(v)`;
  const orderBy = pkColumns.map(c => c.collatable ? `${c.ident} COLLATE "C"` : c.ident).join(', ');
  const keyset = `(${orderBy}) > (${pkColumns.map((c, j) => `$${j + 1}::${c.type}${c.collatable ? ' COLLATE "C"' : ''}`).join(', ')})`;
  const batchBytes = opts.batchBytes ?? DEFAULT_COPY_BATCH_BYTES;

  const selectList = columns.map((c, i) => `${c.ident}::text AS c${i}`).join(', ');
  const scan = async (extraWhere: string | null, visit: (rows: Array<Array<string | null>>) => Promise<void>) => {
    let limit = 100;
    let last: Array<string | null> | null = null;
    for (;;) {
      const where: string[] = [filter, extraWhere, last ? keyset : null].filter((w): w is string => !!w);
      const sql: string = `SELECT ${selectList} FROM ${sourceIdent}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderBy} LIMIT ${limit}`;
      const params: Array<string | null> = last ? pkColumns.map(c => last![index.get(c.name)!]!) : [];
      const rows: Array<Record<string, string | null>> = await e.source.transaction(async tx => {
        for (const setting of RENDER_SETTINGS) await tx.executeRaw(setting);
        return tx.executeRaw<Record<string, string | null>>(sql, params);
      });
      if (!rows.length) return;
      const values: Array<Array<string | null>> = rows.map(row => columns.map((_, i) => row[`c${i}`] ?? null));
      await visit(values);
      if (rows.length < limit) return;
      last = values[values.length - 1]!;
      const bytes = values.reduce((sum, row) => sum + row.reduce((s, v) => s + (v?.length ?? 4) + 3, 2), 0);
      limit = Math.max(1, Math.min(MAX_BATCH_ROWS, Math.floor(batchBytes * rows.length / Math.max(1, bytes))));
    }
  };

  return e.target.transaction(async tx => {
    await setFence(tx, opts.runId);
    const disabled = opts.bypass === 'disable_trigger' ? await userTriggers(tx, relation, true) : [];
    if (opts.bypass === 'session_replication_role') await tx.executeRaw('SET LOCAL session_replication_role = replica');
    for (const trigger of disabled) await tx.executeRaw(`ALTER TABLE ${targetIdent} DISABLE TRIGGER ${trigger.ident}`);
    await tx.executeRaw(`DELETE FROM ${targetIdent}${filter ? ` WHERE ${filter}` : ''}`);
    let copied = 0;
    await scan(null, async rows => {
      await tx.executeRaw(insertSql, [JSON.stringify(rows)]);
      copied += rows.length;
      opts.onBatch?.(rows.length);
    });
    if (selfFk.length) {
      const fkColumns = selfFk.map(name => columns[index.get(name)!]!);
      const updateSql = `UPDATE ${targetIdent} AS t SET ${fkColumns.map((c, j) => `${c.ident} = (r.v->>${pkColumns.length + j})::${c.type}`).join(', ')}
        FROM jsonb_array_elements($1::jsonb) AS r(v) WHERE ${pkColumns.map((c, j) => `t.${c.ident} = (r.v->>${j})::${c.type}`).join(' AND ')}`;
      await scan(`(${fkColumns.map(c => `${c.ident} IS NOT NULL`).join(' OR ')})`, async rows => {
        const payload = rows.map(row => [...pkColumns.map(c => row[index.get(c.name)!]), ...fkColumns.map(c => row[index.get(c.name)!] ?? null)]);
        await tx.executeRaw(updateSql, [JSON.stringify(payload)]);
      });
    }
    for (const trigger of disabled) await tx.executeRaw(`ALTER TABLE ${targetIdent} ${ENABLE_BY_MODE[trigger.enabled] ?? 'ENABLE TRIGGER'} ${trigger.ident}`);
    return { rows: copied };
  });
}

export interface SequencePosition { sequence: string; value: string; isCalled: boolean; raisedToColumnMax: boolean }

/**
 * Sets every source sequence present on the target to the source's exact
 * position (`last_value`, `is_called`), raised to the maximum of every target
 * column it feeds when that is higher, so a value consumed by an aborted source
 * transaction is never reissued. Sequences absent on the target are skipped.
 */
export async function copySequences(e: GraduationEngines, opts: { runId?: string } = {}): Promise<readonly SequencePosition[]> {
  const sequences = await e.source.executeRaw<{ name: string; ident: string }>(`SELECT c.relname AS name, format('%I', c.relname) AS ident
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY c.relname`);
  const runId = await fenceRunId(e.target, opts.runId);
  const positions: SequencePosition[] = [];
  await e.target.transaction(async tx => {
    if (runId) await setFence(tx, runId);
    for (const seq of sequences) {
      const [present] = await tx.executeRaw<{ present: boolean }>("SELECT to_regclass(format('public.%I', $1::text)) IS NOT NULL AS present", [seq.name]);
      if (!present?.present) continue;
      const [position] = await e.source.executeRaw<{ last_value: string; is_called: boolean }>(`SELECT last_value::text AS last_value, is_called FROM ${seq.ident}`);
      const feeds = await tx.executeRaw<{ table_ident: string; column_ident: string }>(`SELECT DISTINCT format('%I', t.relname) AS table_ident, format('%I', a.attname) AS column_ident
        FROM pg_depend d JOIN pg_class t ON t.oid = d.refobjid JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
        WHERE d.classid = 'pg_class'::regclass AND d.objid = to_regclass(format('public.%I', $1::text)) AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
        UNION
        SELECT DISTINCT format('%I', t.relname), format('%I', a.attname)
        FROM pg_depend d JOIN pg_attrdef ad ON ad.oid = d.objid JOIN pg_class t ON t.oid = ad.adrelid JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
        WHERE d.classid = 'pg_attrdef'::regclass AND d.refobjid = to_regclass(format('public.%I', $1::text))`, [seq.name]);
      let value = BigInt(position!.last_value);
      let isCalled = position!.is_called === true;
      let raised = false;
      for (const feed of feeds) {
        const [max] = await tx.executeRaw<{ max: string | null }>(`SELECT max(${feed.column_ident})::text AS max FROM ${feed.table_ident}`);
        if (max?.max && /^-?\d+$/.test(max.max) && BigInt(max.max) > value - (isCalled ? 0n : 1n)) {
          value = BigInt(max.max); isCalled = true; raised = true;
        }
      }
      await tx.executeRaw(`SELECT setval(to_regclass(format('public.%I', $1::text)), $2::bigint, $3::boolean)`, [seq.name, value.toString(), isCalled]);
      positions.push({ sequence: seq.name, value: value.toString(), isCalled, raisedToColumnMax: raised });
    }
  });
  return positions;
}

export interface DeferredIndex { name: string; relation: string; method: 'hnsw' | 'gin'; def: string }

async function readDeferred(engine: Sql): Promise<DeferredIndex[]> {
  const [row] = await engine.executeRaw<{ value: string }>('SELECT value FROM config WHERE key = $1', [GRADUATION_DEFERRED_INDEXES_KEY]);
  if (!row?.value) return [];
  const parsed = JSON.parse(row.value) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((d): d is DeferredIndex => !!d && typeof d.name === 'string' && typeof d.def === 'string' && typeof d.relation === 'string'
    && (d.method === 'hnsw' || d.method === 'gin') && /^CREATE INDEX [a-z_][a-z0-9_]* ON public\.[a-z_][a-z0-9_]* USING (hnsw|gin) \(/.test(d.def) && !d.def.includes(';'));
}

async function writeDeferred(engine: BrainEngine, pending: readonly DeferredIndex[], runId: string | null): Promise<void> {
  await engine.transaction(async tx => {
    if (runId) await setFence(tx, runId);
    if (pending.length) {
      await tx.executeRaw(`INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [GRADUATION_DEFERRED_INDEXES_KEY, JSON.stringify(pending)]);
    } else {
      await tx.executeRaw('DELETE FROM config WHERE key = $1', [GRADUATION_DEFERRED_INDEXES_KEY]);
    }
  });
}

/**
 * Drops every non-unique HNSW and GIN index on the target's public tables and
 * records their definitions in the target-owned `graduation.deferred_indexes`
 * config row, in one transaction. Re-running merges with an existing list.
 */
export async function deferIndexes(target: BrainEngine, opts: { runId?: string } = {}): Promise<readonly DeferredIndex[]> {
  const runId = await fenceRunId(target, opts.runId);
  return target.transaction(async tx => {
    if (runId) await setFence(tx, runId);
    const found = await tx.executeRaw<{ name: string; ident: string; relation: string; method: 'hnsw' | 'gin'; def: string }>(`SELECT i.relname AS name,
        format('%I', i.relname) AS ident, t.relname AS relation, am.amname AS method, pg_get_indexdef(i.oid) AS def
      FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_am am ON am.oid = i.relam
      WHERE n.nspname = 'public' AND am.amname IN ('hnsw', 'gin') AND NOT x.indisunique
        AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.oid) ORDER BY t.relname, i.relname`);
    const byName = new Map((await readDeferred(tx)).map(d => [d.name, d]));
    for (const index of found) byName.set(index.name, { name: index.name, relation: index.relation, method: index.method, def: index.def });
    const pending = [...byName.values()];
    if (pending.length) {
      await tx.executeRaw(`INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [GRADUATION_DEFERRED_INDEXES_KEY, JSON.stringify(pending)]);
    }
    for (const index of found) await tx.executeRaw(`DROP INDEX ${index.ident}`);
    return pending;
  });
}

/**
 * Builds the deferred indexes one at a time, removing each from the pending
 * row once valid, so a killed run resumes where it stopped. HNSW indexes go
 * through the deferred-ANN build of `gbrain migrate embeddings` (invalid
 * remnant cleanup, CONCURRENTLY on Postgres, per-type dimension caps); GIN
 * indexes build plainly without a statement timeout.
 */
export async function buildDeferredIndexes(target: BrainEngine, opts: { runId?: string; log?: (line: string) => void } = {}): Promise<{ built: readonly string[] }> {
  const runId = await fenceRunId(target, opts.runId);
  const built: string[] = [];
  for (const index of await readDeferred(target)) {
    if (index.method === 'hnsw') {
      const column = /USING hnsw \(([a-z_][a-z0-9_]*) /.exec(index.def)?.[1];
      const [dims] = await target.executeRaw<{ dims: number }>(`SELECT a.atttypmod AS dims FROM pg_attribute a
        WHERE a.attrelid = to_regclass(format('public.%I', $1::text)) AND a.attname = $2`, [index.relation, column ?? '']);
      const targetDims = Number(dims?.dims ?? 0);
      if (!(targetDims > 0)) throw new Error(`deferred index ${index.name}: ${index.relation}.${column} has no vector dimension on the target`);
      const ann: DeferredAnnIndex = { name: index.name, def: index.def };
      const result = await buildDeferredAnnIndexes(target, {
        targetDims, readPending: async () => [ann], writePending: async () => {},
        log: opts.log ?? (line => process.stderr.write(`${line.replace(`[migrate] ${ANN_BUILD_MESSAGE}`, '[graduation] building deferred vector index')}\n`)),
      });
      if (result.skipped_over_cap.length) throw new Error(`deferred index ${index.name} exceeds the HNSW dimension cap on the target`);
    } else {
      await target.transaction(async tx => {
        await tx.executeRaw('SET LOCAL statement_timeout = 0');
        await tx.executeRaw(index.def.replace(/^CREATE INDEX /, 'CREATE INDEX IF NOT EXISTS '));
      });
    }
    built.push(index.name);
    await writeDeferred(target, (await readDeferred(target)).filter(d => d.name !== index.name), runId);
  }
  return { built };
}

/**
 * Re-enables user triggers left disabled on the given relations (never the
 * graduation fence). The copier disables and re-enables inside each table's
 * transaction, so this only repairs a target someone else left disabled.
 */
export async function reenableTriggers(target: BrainEngine, relations: readonly string[], opts: { runId?: string } = {}): Promise<readonly string[]> {
  const runId = await fenceRunId(target, opts.runId);
  const enabled: string[] = [];
  await target.transaction(async tx => {
    if (runId) await setFence(tx, runId);
    for (const relation of relations) {
      const [present] = await tx.executeRaw<{ present: boolean }>("SELECT to_regclass(format('public.%I', $1::text)) IS NOT NULL AS present", [relation]);
      if (!present?.present) continue;
      const ident = await relationIdent(tx, relation);
      for (const trigger of await userTriggers(tx, relation, false)) {
        await tx.executeRaw(`ALTER TABLE ${ident} ENABLE TRIGGER ${trigger.ident}`);
        enabled.push(`${relation}.${trigger.ident}`);
      }
    }
  });
  return enabled;
}
