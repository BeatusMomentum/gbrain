/**
 * Engine graduation custody harness: a real disk-backed PGLite source brain
 * in a temp GBRAIN_HOME and a real target engine (an in-memory PGLite, or
 * Postgres when the caller passes a guarded test DATABASE_URL), with the
 * copy/verify/drain/target lanes replaced by thin, honest stand-ins over one
 * carried probe table. Custody, schema, fence, manifest, marker, tombstone,
 * lock and routing code under test is the production code.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GraduationDeps } from '../../src/core/persistence/engine-graduation.ts';
import type { InventoryEntry, TableReceipt, VerifyResult } from '../../src/core/persistence/engine-graduation.types.ts';
import { withGraduationRun } from '../../src/core/persistence/graduation-schema.ts';
import { withEnv } from './with-env.ts';

export const PROBE: InventoryEntry = {
  relation: 'grad_probe', kind: 'table', class: 'carry', engines: { pglite: true, postgres: true },
  lossKind: 'user_data', transforms: [], reason: 'harness probe table',
};
const PROBE_DDL = 'CREATE TABLE IF NOT EXISTS grad_probe (id integer PRIMARY KEY, v text NOT NULL)';
export const TARGET_URL = 'postgres://alice-example:secret-pw@db.example.test:5432/brain';
export const SOURCE_TOKEN_ID = '00000000-0000-4000-8000-0000000000a1';

/** Open a disk-backed PGLite engine (callers disconnect it). */
export async function openPglite(dataDir: string): Promise<PGLiteEngine> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dataDir });
  return engine;
}

export async function probeRows(engine: BrainEngine): Promise<Array<{ id: number; v: string }>> {
  const [present] = await engine.executeRaw<{ ok: boolean }>(`SELECT to_regclass('grad_probe') IS NOT NULL AS ok`);
  if (!present?.ok) return [];
  return engine.executeRaw<{ id: number; v: string }>('SELECT id, v FROM grad_probe ORDER BY id');
}

async function digest(engine: BrainEngine, entry: InventoryEntry): Promise<TableReceipt> {
  const rows = await probeRows(engine);
  const text = rows.map(r => `${r.id}:${r.v}`).join('\n');
  return { relation: entry.relation, rows: rows.length, rootSha256: createHash('sha256').update(text).digest('hex'), batches: [] };
}

/** A non-disconnecting view of the shared target, so the orchestrator's cleanup leaves it open for assertions. */
function borrowed(engine: BrainEngine): BrainEngine {
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'disconnect') return async () => {};
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export interface Harness {
  root: string;
  home: string;
  /** configDir() under this harness: config.json and the graduation manifest live here. */
  gbrainDir: string;
  dataDir: string;
  mountsPath: string;
  target: BrainEngine;
  deps: Partial<GraduationDeps>;
  calls: Record<string, number>;
  /** Run fn with GBRAIN_HOME pointing at this harness. */
  inHome<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface HarnessOptions { postgresUrl?: string }

async function freshTarget(opts: HarnessOptions): Promise<BrainEngine> {
  if (!opts.postgresUrl) {
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' });
    return engine;
  }
  const { PostgresEngine } = await import('../../src/core/postgres-engine.ts');
  const engine = new PostgresEngine();
  await engine.connect({ engine: 'postgres', database_url: opts.postgresUrl });
  await engine.executeRaw('DROP SCHEMA IF EXISTS public CASCADE');
  await engine.executeRaw('CREATE SCHEMA public');
  return engine;
}

/** A source brain with history-shaped rows: three probe rows and one access token. */
export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-graduation-'));
  const home = join(root, 'home');
  const gbrainDir = join(home, '.gbrain');
  mkdirSync(gbrainDir, { recursive: true });
  const dataDir = join(root, 'brain.pglite');
  const mountsPath = join(root, 'mounts.json');
  writeFileSync(join(gbrainDir, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dataDir }), { mode: 0o600 });
  writeFileSync(mountsPath, JSON.stringify({ version: 1, mounts: [{ id: 'team-example', path: root, engine: 'pglite', database_path: dataDir }] }), { mode: 0o600 });
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const source = await openPglite(dataDir);
    try {
      await source.initSchema();
      await source.executeRaw(PROBE_DDL);
      await source.executeRaw(`INSERT INTO grad_probe VALUES (1,'alpha'),(2,'beta'),(3,'gamma')`);
      await source.executeRaw(`INSERT INTO access_tokens (id, name, token_hash) VALUES ($1::uuid, 'agent-example', 'hash-a1')`, [SOURCE_TOKEN_ID]);
    } finally { await source.disconnect(); }
  });
  const target = await freshTarget(opts);
  const calls: Record<string, number> = {};
  const count = (name: string) => { calls[name] = (calls[name] ?? 0) + 1; };
  const deps: Partial<GraduationDeps> = {
    inventory: { version: 900, entries: [PROBE] },
    assertRelationSet: async () => {},
    copyOrder: async () => [PROBE],
    fkClosure: async () => [],
    digestTable: async (engine, entry) => digest(engine, entry),
    verifyGraduation: async (e): Promise<VerifyResult> => {
      count('verify');
      const [source, copied] = [await digest(e.source, PROBE), await digest(e.target, PROBE)];
      const ok = source.rootSha256 === copied.rootSha256;
      return { ok, tables: [copied], failures: ok ? [] : [{ relation: 'grad_probe', kind: 'digest', detail: 'probe differs' }],
        replay: { status: 'not_available', reason: 'no_caller_input' }, doctorFailingChecks: [] };
    },
    resolveTargetRoutes: ({ url, urlEnv, env }) => {
      const mainUrl = url ?? (urlEnv ? env?.[urlEnv] : undefined) ?? TARGET_URL;
      return { main: 'postgres://alice-example@db.example.test:5432/brain', ddl: 'postgres://alice-example@db.example.test:5432/brain', mainUrl, ddlUrl: mainUrl, ...(urlEnv ? { urlEnv } : {}) };
    },
    targetIdentity: () => ({ id: createHash('sha256').update('db.example.test|5432|brain|alice-example').digest('hex'), host: 'db.example.test', port: 5432, database: 'brain', user: 'alice-example' }),
    probeTarget: async () => ({ empty: (await probeRows(target)).length === 0 }),
    crossCheckRoutes: async () => {},
    graduationBlockers: async () => [],
    drainForGraduation: async () => { count('drain'); return { drained: [], blockers: [] }; },
    freezeSource: async () => {},
    detectTriggerBypass: async () => 'session_replication_role',
    copyTable: async (e, entry, o) => {
      count('copy');
      const rows = await probeRows(e.source);
      await withGraduationRun(e.target, o.runId, async tx => {
        await tx.executeRaw('DELETE FROM grad_probe');
        for (const row of rows) await tx.executeRaw('INSERT INTO grad_probe (id, v) VALUES ($1, $2)', [row.id, row.v]);
      });
      return { rows: rows.length };
    },
    copySequences: async () => {},
    deferIndexes: async () => {},
    buildDeferredIndexes: async () => {},
    reenableTriggers: async () => {},
    openTarget: async () => borrowed(target),
    initTargetSchema: async t => { await t.initSchema(); await t.executeRaw(PROBE_DDL); },
    claimAutopilotPause: async () => () => { count('pause_released'); },
    runTargetDoctor: async () => [],
    runSourceDoctor: async () => [],
    hostId: () => '00000000-0000-4000-8000-00000000beef',
    mountsPath: () => mountsPath,
  };
  return {
    root, home, gbrainDir, dataDir, mountsPath, target, deps, calls,
    inHome: fn => withEnv({ GBRAIN_HOME: home }, fn),
    close: async () => { await target.disconnect(); },
  };
}

/** A pause hook that simulates a crash at `step` (the process's cleanup stands in for process death). */
export function crashAt(step: string): (s: string) => Promise<void> {
  return async s => { if (s === step) throw new Error(`simulated crash at ${s}`); };
}
