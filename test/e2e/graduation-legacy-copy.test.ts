/**
 * The independent legacy fixture through the real drain, copier and digest
 * (G1/G2b modules), checked against expected.json by a checker that shares no
 * code with them.
 *
 * Protects: the copy layer's handling of every hand-built legacy state
 * (unattributed rows kept unattributed, the withdrawal overlay, take and fact
 * supersession, byte-heavy jsonb, vectors as text, collation-sensitive text
 * keys) and its permitted transforms (stale lease -> waiting, orphan running
 * effect -> queued, worktree heartbeat reset, cycle locks discarded, queued
 * request drained), under both trigger-bypass mechanisms. Custody (G2a) is
 * not involved, so `persistence_brain.enabled` stays false on the target and
 * that single expectation is excluded here; the crash and CLI suites cover it.
 * Regressions it catches: a transform the inventory applies but the plan does
 * not allow (or the reverse), digest and independent checker disagreeing.
 * Not covered elsewhere: the copier's own E2E uses only the generated history.
 * The modules load dynamically so this file typechecks before the lanes merge.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import type { GraduationEngines, InventoryEntry, TableReceipt, TriggerBypass } from '../../src/core/persistence/engine-graduation.types.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { legacyTargetMismatches, snapshotLegacySource } from '../fixtures/graduation/legacy-brain.ts';
import { DATABASE_URL, REPO } from '../helpers/graduation-e2e.ts';
import { legacyCase, scratchRoot, withSource } from '../helpers/graduation-scenarios.ts';

const module = (name: string) => join(REPO, 'src', 'core', 'persistence', `${name}.ts`);
const LANDED = ['graduation-copy', 'graduation-drain', 'graduation-inventory', 'graduation-digest'].every(name => existsSync(module(name)));
const laneTest = LANDED ? test : (test.todo as unknown as typeof test);

interface Lanes {
  copyOrder(engine: BrainEngine): Promise<readonly InventoryEntry[]>;
  copyTable(e: GraduationEngines, entry: InventoryEntry, opts: { bypass: TriggerBypass; batchBytes?: number; runId: string }): Promise<{ rows: number }>;
  copySequences(e: GraduationEngines, opts: { runId: string }): Promise<unknown>;
  deferIndexes(target: BrainEngine, opts: { runId: string }): Promise<unknown>;
  buildDeferredIndexes(target: BrainEngine, opts: { runId: string; log: (line: string) => void }): Promise<unknown>;
  drainForGraduation(source: BrainEngine, opts: { timeoutMs: number; hostId: string; config: GBrainConfig }): Promise<{ drained: readonly string[]; blockers: readonly unknown[] }>;
  freezeSource(source: BrainEngine): Promise<void>;
  digestTable(engine: BrainEngine, entry: InventoryEntry, opts?: { applyTransforms?: boolean }): Promise<TableReceipt>;
}
async function lanes(): Promise<Lanes> {
  const parts = await Promise.all(['graduation-copy', 'graduation-drain', 'graduation-inventory', 'graduation-digest'].map(name => import(module(name))));
  return Object.assign({}, ...parts) as Lanes;
}

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const close of closers.reverse()) await close().catch(() => {});
  rmSync(scratchRoot, { recursive: true, force: true });
});

describe.skipIf(!DATABASE_URL)('graduation copy layer on the legacy fixture', () => {
  for (const bypass of ['session_replication_role', 'disable_trigger'] as const) {
    laneTest(`${bypass}: drained, copied and digested; every expected.json target expectation except custody's enabled flag`, async () => {
      const g = await lanes();
      const c = await legacyCase(`legacy-copy-${bypass}`);
      closers.push(() => c.target.close());
      const result = await withSource(c.fx, async source => {
        const drained = await g.drainForGraduation(source, { timeoutMs: 60_000, hostId: localHostId(), config: { engine: 'pglite', embedding_disabled: true } as GBrainConfig });
        expect(drained.blockers).toEqual([]);
        expect(drained.drained).toContain('00000000-0000-4000-8000-0000000000a1');
        await g.freezeSource(source);
        const before = await snapshotLegacySource(source);
        const target = new PostgresEngine();
        await target.connect({ database_url: c.target.url, poolSize: 4 });
        try {
          await target.initSchema();
          const present = new Set((await target.executeRaw<{ name: string }>(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind='r'`)).map(r => r.name));
          const entries = (await g.copyOrder(source)).filter(entry => present.has(entry.relation));
          const e = { source, target };
          const runId = randomUUID();
          await g.deferIndexes(target, { runId });
          for (const entry of entries) await g.copyTable(e, entry, { bypass, runId, batchBytes: 256 * 1024 });
          await g.copySequences(e, { runId });
          await g.buildDeferredIndexes(target, { runId, log: () => {} });
          const digestDiffs: string[] = [];
          for (const entry of entries) {
            const [a, b] = [await g.digestTable(source, entry, { applyTransforms: true }), await g.digestTable(target, entry)];
            if (a.rows !== b.rows || a.rootSha256 !== b.rootSha256) digestDiffs.push(`${entry.relation}: ${a.rows}/${b.rows}`);
          }
          const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(target) });
          const mismatches = await legacyTargetMismatches(target, before, token => provider.verifyAccessToken(token));
          return { digestDiffs, mismatches };
        } finally { await target.disconnect(); }
      });
      expect(result.digestDiffs).toEqual([]);
      expect(result.mismatches.filter(m => !m.startsWith('target brain:'))).toEqual([]);
      expect(result.mismatches.join('\n')).toContain('"enabled":false');
    }, 600_000);
  }
});

