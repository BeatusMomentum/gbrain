/**
 * Engine graduation orchestrator (PGLite -> Postgres): plan, run, status,
 * resume, rollback and reconciliation over one custody protocol.
 *
 * The kernel lock on the source is held from step 1 to the end of step 8
 * (quiesce, record, drain, fence target, copy, verify, fence both then grant
 * authority, flip routing). Exactly one engine accepts writes at every
 * instant: before step 7 only the source (the target is fenced in the
 * database from step 4), during step 7 neither, after it only the target.
 * Every state change is driven by the transition tables in
 * engine-graduation.types.ts and recorded in the 0600 manifest
 * (`<GBRAIN_HOME>/graduation-manifest.json`), the sibling intent marker and
 * the `persistence_graduation` rows; restart reconciliation continues from the
 * first incomplete step using the recorded identities, never current routing.
 *
 * Graduation is CLI-only: no operations.ts entry, no remote caller.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Action } from '../agent-output.ts';
import type { BrainEngine } from '../engine.ts';
import type { EngineConfig } from '../types.ts';
import { configDir, loadConfigFileOnly, saveConfig, type GBrainConfig } from '../config.ts';
import { exclusiveFix, liveServeOwner } from '../exclusive-fix.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { acquireKernelLockOnly, PgliteBusyError, peekLock, releaseLock, type LockHandle } from '../pglite-lock.ts';
import { localHostId } from './identity.ts';
import { quiesceAutopilot } from '../../commands/migrate-engine.ts';
import { LATEST_VERSION } from '../migrate.ts';
import {
  assertTransition, GRADUATION_MANIFEST_VERSION, MANIFEST_TRANSITIONS,
  type GraduationBlocker, type GraduationErrorCode, type GraduationManifest, type GraduationPathState, type GraduationPlan,
  type GraduationReceipt, type GraduationStatusDoc, type IntentMarker, type Inventory, type InventoryEntry, type LossKind,
  type ManifestState, type TableCheckpoint, type TableReceipt, type TargetIdentity, type TargetRoutes, type TriggerBypass,
} from './engine-graduation.types.ts';
import {
  currentProcessIdentity, fsyncParent, graduatedPath, graduationDataDir, graduationError, graduationInProgressError,
  graduationInterruptedError, graduationSplitBrainError, inspectGraduationPath, markerLiveness, moveAsideHeld,
  readIntentMarker, readTombstone, registerGraduationRunInProcess, removeIntentMarker, removeTombstone, targetDisplayUrl,
  TERMINAL_STATES, TombstonePathOccupiedError, writeFileDurably, writeIntentMarker, writeTombstone,
} from './graduation-custody.ts';
import {
  dropGraduationFence, graduationFenceStatus, installGraduationFence, readGraduationRow, setSourceState, setTargetState,
  withGraduationRun,
} from './graduation-schema.ts';
import { moveHeldPglite } from './maintenance.ts';
import { assertRelationSet, copyOrder, fkClosure, GRADUATION_INVENTORY } from './graduation-inventory.ts';
import { digestTable } from './graduation-digest.ts';
import { verifyGraduation } from './graduation-verify.ts';
import { crossCheckRoutes, probeTarget, resolveTargetRoutes, targetIdentity, type TargetProbe } from './graduation-target.ts';
import { drainForGraduation, freezeSource, graduationBlockers } from './graduation-drain.ts';
import { buildDeferredIndexes, copySequences, copyTable, deferIndexes, detectTriggerBypass, reenableTriggers } from './graduation-copy.ts';

const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;
const HANDOFF_TIMEOUT_MS = 30_000;
const DOCS = 'docs/guides/move-to-postgres.md';
const STATUS_ARGV = ['gbrain', 'migrate', '--status', '--json'];
/** Usage-tracking columns that change on every authorized call; not a security change. */
const SECURITY_VOLATILE_COLUMNS = new Set(['last_used_at']);
const SECURITY_TABLES = ['access_tokens', 'oauth_clients', 'oauth_tokens', 'oauth_grant_audit', 'persistence_local_writers', 'fact_withdrawals'] as const;

const STATE_RANK: Readonly<Record<ManifestState, number>> = {
  planned: 0, quiesced: 1, draining: 2, copying: 3, verifying: 4, verify_failed: 4, verified: 5, cutover: 6, tombstoned: 7,
  authoritative: 8, graduated: 9, rollback_fenced: 10, rollback_approved: 11, source_restoring: 12, rolled_back: 13, abandoned: 13,
};

// ── dependencies ───────────────────────────────────────────────────────────

export interface GraduationSourceEngine extends BrainEngine {
  closeRetainingLock(): Promise<LockHandle>;
  connectWithHeldLock(config: EngineConfig, lock: LockHandle): Promise<void>;
}

type Routes = TargetRoutes & { mainUrl: string; ddlUrl: string };

/** Everything the orchestrator calls outside custody; tests replace any part. */
export interface GraduationDeps {
  inventory: Inventory;
  assertRelationSet: typeof assertRelationSet;
  copyOrder: typeof copyOrder;
  fkClosure: typeof fkClosure;
  digestTable: typeof digestTable;
  verifyGraduation: typeof verifyGraduation;
  resolveTargetRoutes: typeof resolveTargetRoutes;
  targetIdentity: typeof targetIdentity;
  probeTarget: typeof probeTarget;
  crossCheckRoutes: typeof crossCheckRoutes;
  graduationBlockers: typeof graduationBlockers;
  drainForGraduation: typeof drainForGraduation;
  freezeSource: typeof freezeSource;
  detectTriggerBypass: typeof detectTriggerBypass;
  copyTable: typeof copyTable;
  copySequences: typeof copySequences;
  deferIndexes: typeof deferIndexes;
  buildDeferredIndexes: typeof buildDeferredIndexes;
  reenableTriggers: typeof reenableTriggers;
  /** Open the PGLite source (full connect; `migrate` applies pending migrations). */
  openSource(dataDir: string, opts: { migrate: boolean }): Promise<GraduationSourceEngine>;
  /** A fresh, unconnected PGLite engine for a held-lock open. */
  newSourceEngine(): Promise<GraduationSourceEngine>;
  openTarget(url: string): Promise<BrainEngine>;
  /** Target schema bootstrap, sized from the source's embedding layout. */
  initTargetSchema(target: BrainEngine, source: BrainEngine): Promise<void>;
  claimAutopilotPause(): Promise<(() => void) | null>;
  /** Failing check names of `gbrain doctor --no-migrate --json` against the fenced target. */
  runTargetDoctor(runId: string, mainUrl: string): Promise<readonly string[]>;
  /** Failing source checks, measured with the source open under the run's lock. */
  runSourceDoctor(source: BrainEngine): Promise<readonly string[]>;
  hostId(): string;
  mountsPath(): string;
}

export function defaultGraduationDeps(): GraduationDeps {
  return {
    inventory: GRADUATION_INVENTORY,
    assertRelationSet, copyOrder, fkClosure, digestTable, verifyGraduation,
    resolveTargetRoutes, targetIdentity, probeTarget, crossCheckRoutes,
    graduationBlockers, drainForGraduation, freezeSource,
    detectTriggerBypass, copyTable, copySequences, deferIndexes, buildDeferredIndexes, reenableTriggers,
    async openSource(dataDir, opts) {
      const engine = await this.newSourceEngine();
      await engine.connect({ engine: 'pglite', database_path: dataDir });
      if (opts.migrate) {
        try {
          const { hasPendingMigrations } = await import('../migrate.ts');
          if (await hasPendingMigrations(engine)) await engine.initSchema();
        } catch (error) { await engine.disconnect(); throw error; }
      }
      return engine;
    },
    async newSourceEngine() {
      const { createEngine } = await import('../engine-factory.ts');
      return await createEngine({ engine: 'pglite' }) as GraduationSourceEngine;
    },
    async openTarget(url) {
      const { createEngine } = await import('../engine-factory.ts');
      const engine = await createEngine({ engine: 'postgres' });
      try { await engine.connect({ engine: 'postgres', database_url: url }); }
      catch (error) { throw mapTargetConnectError(error); }
      return engine;
    },
    async initTargetSchema(target) { await target.initSchema(); },
    claimAutopilotPause: () => withStdoutOnStderr(() => quiesceAutopilot()),
    async runTargetDoctor(runId, mainUrl) { return spawnTargetDoctor(runId, mainUrl); },
    async runSourceDoctor() { return []; },
    hostId: () => localHostId(),
    mountsPath: () => process.env.GBRAIN_MOUNTS_PATH || join(homedir(), '.gbrain', 'mounts.json'),
  };
}

async function withStdoutOnStderr<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  try { return await fn(); } finally { console.log = log; }
}

function spawnTargetDoctor(runId: string, mainUrl: string): readonly string[] {
  const script = process.argv[1] && /\.(ts|js|mjs)$/.test(process.argv[1]) ? [process.argv[1]] : [];
  const child = spawnSync(process.execPath, [...script, 'doctor', '--no-migrate', '--json'], {
    env: { ...process.env, GBRAIN_DATABASE_URL: mainUrl, GBRAIN_GRADUATION_RUN: runId },
    encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
  });
  try {
    const doc = JSON.parse(child.stdout) as { checks?: Array<{ name?: string; status?: string }> };
    if (!Array.isArray(doc.checks)) return ['doctor_output_unreadable'];
    return doc.checks.filter(c => c.status === 'fail').map(c => String(c.name ?? 'unnamed'));
  } catch { return ['doctor_unavailable']; }
}

function mapTargetConnectError(error: unknown): unknown {
  const e = error as { code?: string; message?: string };
  if (e?.code === '28P01' || /password authentication failed/i.test(e?.message ?? '')) {
    return graduationError('graduation_target_auth_failed', 'The target database refused the recorded credentials.',
      'Ask the user for the current URL of the same database, put it in an environment variable, and rerun with `--url-env <VAR>`; the host, port, database and user must match the recorded target.',
      'The password changed since the run started; the manifest identity excludes the password so the same database is recognised.',
      { argv: ['gbrain', 'migrate', '--resume', '--url-env', 'GBRAIN_TARGET_URL'], consent: ['credentials'], actor: 'agent', requires_exclusive: true,
        why: 'Reconnects to the same target with the new password and continues the run.', verify: { argv: STATUS_ARGV } });
  }
  return error;
}

// ── manifest v3 ────────────────────────────────────────────────────────────

export function graduationManifestPath(): string { return join(configDir(), 'graduation-manifest.json'); }

export function readGraduationManifest(path = graduationManifestPath()): GraduationManifest | null {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const parsed = JSON.parse(raw) as GraduationManifest;
  if (parsed?.version !== GRADUATION_MANIFEST_VERSION) throw new Error(`Unsupported graduation manifest at ${path} (version ${String(parsed?.version)}).`);
  return parsed;
}

/** Atomic write + fsync, mode 0600 (it holds the full target URLs). */
export function writeGraduationManifest(manifest: GraduationManifest, path = graduationManifestPath()): void {
  writeFileDurably(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Apply a manifest transition from MANIFEST_TRANSITIONS; an illegal one throws. */
export function transitionManifest(manifest: GraduationManifest, to: ManifestState): void {
  if (manifest.state !== to) assertTransition(MANIFEST_TRANSITIONS, manifest.state, to);
  manifest.state = to;
  manifest.updatedAt = new Date().toISOString();
}

export function redactManifest(manifest: GraduationManifest): Omit<GraduationManifest, 'targetUrls'> {
  const { targetUrls: _secret, ...rest } = manifest;
  return rest;
}

// ── options ────────────────────────────────────────────────────────────────

export interface GraduationProgressEvent {
  phase: string;
  state?: ManifestState;
  relation?: string;
  rows?: number;
  done?: number;
  total?: number;
  message?: string;
}

interface CommonOptions {
  env?: NodeJS.ProcessEnv;
  manifestPath?: string;
  deps?: Partial<GraduationDeps>;
  onProgress?: (event: GraduationProgressEvent) => void;
  /** Crash-test seam; defaults to GBRAIN_GRADUATION_PAUSE_AT. */
  pauseAt?: string;
  /** In-process tests: awaited at the pause seam instead of blocking. */
  pauseHook?: (step: string) => Promise<void>;
  handoffTimeoutMs?: number;
}

export interface GraduationPlanOptions extends CommonOptions {
  config: GBrainConfig;
  url?: string;
  urlEnv?: string;
  invokedAs?: 'postgres' | 'supabase';
  force?: boolean;
  triggerBypass?: TriggerBypass;
  batchBytes?: number;
}

export interface GraduationRunOptions extends GraduationPlanOptions {
  /** The plan hash the user approved (`--yes --expect <plan_hash>`). */
  expect: string;
  drainTimeoutMs?: number;
}

export interface GraduationResumeOptions extends CommonOptions {
  url?: string;
  urlEnv?: string;
  drainTimeoutMs?: number;
  batchBytes?: number;
}

export interface GraduationRollbackOptions extends CommonOptions {
  yes?: boolean;
  expect?: string;
  url?: string;
  urlEnv?: string;
}

// ── run context ────────────────────────────────────────────────────────────

interface Run {
  m: GraduationManifest;
  path: string;
  deps: GraduationDeps;
  opts: CommonOptions & { drainTimeoutMs?: number; batchBytes?: number; config?: GBrainConfig };
  dataDir: string;
  source: GraduationSourceEngine | null;
  lock: LockHandle | null;
  main: BrainEngine | null;
  ddl: BrainEngine | null;
  resumePause: (() => void) | null;
  unregister: () => void;
}

function newRun(m: GraduationManifest, path: string, opts: Run['opts']): Run {
  return {
    m, path, opts, deps: { ...defaultGraduationDeps(), ...opts.deps }, dataDir: m.source.dataDir,
    source: null, lock: null, main: null, ddl: null, resumePause: null, unregister: registerGraduationRunInProcess(m.runId),
  };
}

function progress(run: Pick<Run, 'opts'>, event: GraduationProgressEvent): void { run.opts.onProgress?.(event); }

function markerFor(run: Run): IntentMarker {
  return { runId: run.m.runId, state: run.m.state, ...currentProcessIdentity(), target: run.m.target, updatedAt: new Date().toISOString() };
}

/** Persist a manifest transition and mirror it into the intent marker (terminal states remove the marker). */
function advance(run: Run, to: ManifestState, patch: Partial<GraduationManifest> = {}): void {
  transitionManifest(run.m, to);
  Object.assign(run.m, patch);
  writeGraduationManifest(run.m, run.path);
  if (to === 'rolled_back' || to === 'abandoned') removeIntentMarker(run.dataDir);
  else writeIntentMarker(run.dataDir, markerFor(run));
  progress(run, { phase: 'state', state: to });
}

function save(run: Run): void {
  run.m.updatedAt = new Date().toISOString();
  writeGraduationManifest(run.m, run.path);
}

async function pauseSeam(run: Pick<Run, 'opts'>, step: string): Promise<void> {
  const env = run.opts.env ?? process.env;
  if ((run.opts.pauseAt ?? env.GBRAIN_GRADUATION_PAUSE_AT) !== step) return;
  progress(run, { phase: 'paused', message: step });
  if (run.opts.pauseHook) { await run.opts.pauseHook(step); return; }
  process.stderr.write(`[graduation] paused at ${step} (GBRAIN_GRADUATION_PAUSE_AT)\n`);
  const release = env.GBRAIN_GRADUATION_PAUSE_RELEASE;
  for (;;) {
    if (release && existsSync(release)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function cleanup(run: Run): Promise<void> {
  const errors: unknown[] = [];
  const attempt = async (fn: () => Promise<void> | void) => { try { await fn(); } catch (error) { errors.push(error); } };
  if (run.source) { const source = run.source; run.source = null; await attempt(() => source.disconnect()); }
  if (run.lock) { const lock = run.lock; run.lock = null; await attempt(() => releaseLock(lock)); }
  const targets = new Set([run.main, run.ddl].filter((e): e is BrainEngine => !!e));
  run.main = null; run.ddl = null;
  for (const engine of targets) await attempt(() => engine.disconnect());
  if (run.resumePause) { const resume = run.resumePause; run.resumePause = null; await attempt(resume); }
  run.unregister();
  if (errors.length) process.stderr.write(`[graduation] cleanup: ${errors.map(String).join('; ')}\n`);
}

function invokedAs(run: { m: GraduationManifest }): 'postgres' | 'supabase' { return run.m.invokedAs ?? 'postgres'; }
function urlEnvName(routes: TargetRoutes): string { return routes.urlEnv ?? 'GBRAIN_TARGET_URL'; }

function runArgv(spelling: 'postgres' | 'supabase', routes: TargetRoutes, planHash: string): string[] {
  return ['gbrain', 'migrate', '--to', spelling, '--url-env', urlEnvName(routes), '--yes', '--expect', planHash];
}

// ── plan ───────────────────────────────────────────────────────────────────

interface PlanInputs {
  config: GBrainConfig;
  env: NodeJS.ProcessEnv;
  routes: Routes;
  target: TargetIdentity;
  invokedAs: 'postgres' | 'supabase';
  force: boolean;
  triggerBypassOverride?: TriggerBypass;
  batchBytes?: number;
}

function sourceDataDir(config: GBrainConfig): string {
  if (config.engine !== 'pglite' || !config.database_path) {
    throw opError('invalid_params', 'Engine graduation moves a PGLite brain; this brain is not configured as PGLite.',
      'Run graduation only from a PGLite brain (`gbrain engine status --json` shows the configured engine).',
      { why: 'Graduation copies a PGLite datastore into Postgres; other directions use the legacy copier.',
        fix: { argv: ['gbrain', 'engine', 'status', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows the configured engine and datastore.' } });
  }
  return graduationDataDir(config.database_path);
}

function planHashOf(input: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value as object).sort().map(k => [k, canonical((value as Record<string, unknown>)[k])]))
      : value;
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex').slice(0, 16);
}

function probeTargetEmpty(probe: TargetProbe): boolean { return probe.empty; }

async function countTables(source: BrainEngine, inventory: Inventory): Promise<GraduationPlan['tables']> {
  const relations = inventory.entries.filter(e => e.kind === 'table' && e.engines.pglite).map(e => e.relation);
  const present = await source.executeRaw<{ relname: string; q: string; bytes: string }>(
    `SELECT c.relname, quote_ident(c.relname) AS q, pg_total_relation_size(c.oid)::text AS bytes FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind IN ('r','p') AND c.relname = ANY($1::text[])`, [relations]);
  const byName = new Map(present.map(r => [r.relname, r]));
  const rows: GraduationPlan['tables'][number][] = [];
  for (const entry of inventory.entries) {
    const found = byName.get(entry.relation);
    if (!found) continue;
    const [count] = await source.executeRaw<{ n: string }>(`SELECT count(*)::text AS n FROM ${found.q}`);
    rows.push({ relation: entry.relation, class: entry.class, rows: Number(count?.n ?? 0), bytes: Number(found.bytes) });
  }
  return rows;
}

function envOverrideBlockers(env: NodeJS.ProcessEnv, routes: Routes): GraduationBlocker[] {
  return (['GBRAIN_DATABASE_URL', 'DATABASE_URL'] as const)
    .filter(name => env[name] && env[name] !== routes.mainUrl)
    .map(name => ({ kind: 'env_override' as const, id: name, needsUser: true,
      detail: `${name} is set in this environment and would override the routing flip; unset it (or point it at the target) before graduating.` }));
}

/** Read-only plan assembly over an open source (or none when a live serve holds it) and a target session. */
async function assemblePlan(deps: GraduationDeps, input: PlanInputs, source: BrainEngine | null, main: BrainEngine | null, targetOurs: boolean): Promise<GraduationPlan> {
  const dataDir = sourceDataDir(input.config);
  const hostId = deps.hostId();
  const blockers: GraduationBlocker[] = [...envOverrideBlockers(input.env, input.routes)];
  if (process.platform === 'win32') {
    blockers.push({ kind: 'unsupported_platform', id: 'win32', needsUser: true, detail: 'Engine graduation is unavailable on Windows until its tombstone and crash tests run there.' });
  }
  let brainId = '';
  let tables: GraduationPlan['tables'] = [];
  if (source) {
    try { await deps.assertRelationSet(source, 'pglite', deps.inventory); }
    catch (error) { blockers.push({ kind: 'unclassified_relation', id: 'source', needsUser: false, detail: (error as Error).message }); }
    blockers.push(...await deps.graduationBlockers(source, hostId));
    for (const failing of await deps.runSourceDoctor(source)) {
      blockers.push({ kind: 'source_doctor', id: failing, needsUser: true, detail: `Doctor check ${failing} fails on the source; fix it before graduating.`, argv: ['gbrain', 'doctor', '--json'] });
    }
    const [brain] = await source.executeRaw<{ brain_id: string }>('SELECT brain_id::text AS brain_id FROM persistence_brain WHERE singleton = 1');
    brainId = brain?.brain_id ?? '';
    tables = await countTables(source, deps.inventory);
  }
  const probe = await deps.probeTarget(input.routes);
  const targetAcceptable = targetOurs || probeTargetEmpty(probe);
  if (!targetAcceptable && !input.force) {
    blockers.push({ kind: 'target_not_empty', id: input.target.id, needsUser: true, detail: 'The target database already holds gbrain data that this run did not write.' });
  }
  const triggerBypass = input.triggerBypassOverride ?? (main ? await deps.detectTriggerBypass(main) : null);
  if (!triggerBypass) blockers.push({ kind: 'target_unsupported', id: 'trigger_bypass', needsUser: true, detail: 'The target role can neither SET session_replication_role nor disable user triggers on the gbrain tables.' });
  let forceSnapshot: Array<[string, string]> | null = null;
  if (input.force && !targetAcceptable && main) {
    forceSnapshot = [];
    for (const entry of deps.inventory.entries.filter(e => e.lossKind === 'user_data' && e.engines.postgres && e.kind === 'table')) {
      const [present] = await main.executeRaw<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [entry.relation]);
      if (present?.ok) forceSnapshot.push([entry.relation, (await deps.digestTable(main, entry)).rootSha256]);
    }
  }
  const planHash = planHashOf({
    v: 1, source: { dataDir, hostId }, target: input.target.id, inventory: deps.inventory.version, schema: LATEST_VERSION,
    classes: deps.inventory.entries.map(e => `${e.relation}:${e.class}`).sort(),
    blockers: blockers.filter(b => b.needsUser).map(b => `${b.kind}:${b.id}`).sort(),
    triggerBypass, targetAcceptable, force: input.force, forceSnapshot, batchBytes: input.batchBytes ?? null,
  });
  const rows = tables.filter(t => t.class === 'carry' || t.class === 'rebind').reduce((sum, t) => sum + t.rows, 0);
  const bytes = tables.filter(t => t.class === 'carry' || t.class === 'rebind').reduce((sum, t) => sum + t.bytes, 0);
  const copy = Math.ceil(rows / 5_000 + bytes / 20_000_000);
  const verify = Math.ceil(copy * 0.6);
  const doctor = 30;
  return {
    planHash, source: { dataDir, brainId, hostId }, target: input.target, routes: { main: input.routes.main, ddl: input.routes.ddl, ...(input.routes.urlEnv ? { urlEnv: input.routes.urlEnv } : {}) },
    triggerBypass, tables, blockers, estimateSeconds: { copy, verify, doctor, total: copy + verify + doctor },
    sourceMeasured: source ? 'now' : 'at_run_start',
    nextArgv: runArgv(input.invokedAs, input.routes, planHash),
  };
}

function planInputs(deps: GraduationDeps, opts: GraduationPlanOptions): PlanInputs {
  const env = opts.env ?? process.env;
  const routes = deps.resolveTargetRoutes({ url: opts.url, urlEnv: opts.urlEnv, env });
  return { config: opts.config, env, routes, target: deps.targetIdentity(routes.mainUrl), invokedAs: opts.invokedAs ?? 'postgres',
    force: !!opts.force, triggerBypassOverride: opts.triggerBypass, batchBytes: opts.batchBytes };
}

function refuseOnPathState(state: GraduationPathState): void {
  if (state.kind === 'graduated') throw graduationAlreadyGraduated(state);
  if (state.kind === 'split_brain') throw graduationSplitBrainError(state);
  if (state.kind === 'in_progress' && state.marker) throw graduationInProgressError({ runId: state.marker.runId, state: state.marker.state, where: 'source' });
}

function graduationAlreadyGraduated(state: GraduationPathState): OperationError {
  return graduationError('engine_graduated', `This PGLite datastore already moved to Postgres (run ${state.tombstone?.runId ?? 'unknown'}).`,
    'Run `gbrain migrate --resume` to finish any pending routing flip on this host; `gbrain migrate --status --json` shows the recorded run.',
    'The datastore path holds a graduation tombstone, so there is nothing left to move.',
    { argv: ['gbrain', 'migrate', '--resume'], consent: [], actor: 'agent', requires_exclusive: true, why: 'Finishes the recorded graduation.', verify: { argv: STATUS_ARGV } });
}

/**
 * The read-only plan: zero mutations on either engine (no schema migration,
 * no target DDL, no marker). The source opens through a probe-only connect
 * under a short kernel-lock hold; a live serve holding it marks counts
 * `measured at run start`.
 */
export async function planGraduation(opts: GraduationPlanOptions): Promise<GraduationPlan> {
  const deps = { ...defaultGraduationDeps(), ...opts.deps };
  const input = planInputs(deps, opts);
  const dataDir = sourceDataDir(opts.config);
  refuseOnPathState(inspectGraduationPath(dataDir));
  let source: GraduationSourceEngine | null = null;
  let main: BrainEngine | null = null;
  try {
    try { source = await deps.openSource(dataDir, { migrate: false }); }
    catch (error) { if (!(error instanceof PgliteBusyError)) throw error; }
    main = await deps.openTarget(input.routes.mainUrl);
    return await assemblePlan(deps, input, source, main, false);
  } finally {
    if (source) await source.disconnect();
    if (main) await main.disconnect();
  }
}

// ── run ────────────────────────────────────────────────────────────────────

function blockerRefusal(blocker: GraduationBlocker, run: { m: GraduationManifest }): OperationError {
  const codeByKind: Partial<Record<GraduationBlocker['kind'], GraduationErrorCode>> = {
    foreign_host_binding: 'graduation_foreign_host_binding', target_not_empty: 'graduation_target_not_empty',
    unsupported_platform: 'graduation_unsupported_platform', unclassified_relation: 'graduation_unclassified_table',
    embedding_dimension: 'graduation_embedding_dimension_mismatch', target_unsupported: 'graduation_target_unsupported',
    writer_held: 'graduation_source_writer_held', env_override: 'graduation_target_unsupported', source_doctor: 'graduation_verify_failed',
  };
  const code = codeByKind[blocker.kind] ?? 'graduation_drain_timeout';
  const fix: Action = blocker.argv?.length
    ? { argv: [...blocker.argv], consent: blocker.needsUser ? ['destructive'] : [], actor: 'agent', requires_exclusive: false, why: blocker.detail, verify: { argv: planArgv(run) } }
    : blocker.needsUser
      ? { argv: planArgv(run), consent: ['egress'], actor: 'agent', requires_exclusive: false, why: `${blocker.detail} Ask the user to resolve it, then show the plan again.`, user_message: blocker.detail }
      : { consent: [], actor: 'agent', requires_exclusive: false, why: blocker.detail };
  return graduationError(code, `Graduation is blocked: ${blocker.detail}`,
    blocker.needsUser ? 'Relay the blocker to the user; nothing was changed and the source stays authoritative.' : 'Follow the fix; nothing was changed and the source stays authoritative.',
    `Blocker ${blocker.kind} (${blocker.id}) must clear before any copy starts.`, fix, `${blocker.kind}:${blocker.id}`);
}

function planArgv(run: { m: GraduationManifest }): string[] {
  return ['gbrain', 'migrate', '--to', invokedAs(run), '--url-env', urlEnvName(run.m.routes), '--plan', '--json'];
}

function writerHeldError(run: Run, error: unknown): OperationError {
  const peek = peekLock(run.dataDir);
  const owner = liveServeOwner(error) ?? (peek.held && peek.pid ? { pid: peek.pid, transport: peek.http ? 'http' as const : 'stdio' as const, is_self: false } : null);
  const rerun: Action = { argv: runArgv(invokedAs(run), run.m.routes, run.m.planHash), consent: [], actor: 'agent', requires_exclusive: true,
    why: 'Reruns the approved graduation once the datastore is free.', verify: { argv: STATUS_ARGV } };
  const fix = owner ? exclusiveFix(rerun, owner)
    : { ...rerun, actor: 'user' as const, user_message: 'Another gbrain process holds this brain; please stop it, then I will rerun the move.' };
  return graduationError('graduation_source_writer_held',
    `Another process holds this PGLite datastore${owner ? ` (PID ${owner.pid}, ${owner.transport})` : ''} and did not hand it off within ${Math.round((run.opts.handoffTimeoutMs ?? HANDOFF_TIMEOUT_MS) / 1000)} s.`,
    'Stop the named server or daemon, then rerun the same command; the plan approval still holds.',
    'Graduation needs the kernel lock on the source for the whole move; a holder that keeps writing would race the copy.', fix);
}

async function openSourceUnderLock(run: Run): Promise<void> {
  const deadline = Date.now() + (run.opts.handoffTimeoutMs ?? HANDOFF_TIMEOUT_MS);
  for (;;) {
    try { run.source = await run.deps.openSource(run.dataDir, { migrate: true }); return; }
    catch (error) {
      if (!(error instanceof PgliteBusyError)) throw error;
      if (Date.now() >= deadline) throw writerHeldError(run, error);
      progress(run, { phase: 'handoff', message: 'waiting for the live serve to hand off the datastore' });
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

async function claimPause(run: Run): Promise<void> {
  if (run.resumePause) return;
  const resume = await run.deps.claimAutopilotPause();
  if (!resume) {
    throw graduationError('graduation_in_progress', 'Another migration or an operator hold owns the autopilot pause marker.',
      'Wait for the other migration to finish, then retry; `gbrain migrate --status --json` shows a graduation run.',
      'The autopilot pause marker is the migration mutex; running without it would let two moves race.',
      { argv: STATUS_ARGV, consent: [], actor: 'provider', requires_exclusive: false, why: 'Shows whether a graduation run holds the machine.', verify: { argv: STATUS_ARGV } });
  }
  run.resumePause = resume;
}

async function openTargets(run: Run): Promise<void> {
  const urls = run.m.targetUrls;
  if (!urls) throw new Error('The graduation manifest has no target URLs.');
  if (!run.main) run.main = await run.deps.openTarget(urls.main);
  if (!run.ddl) run.ddl = urls.ddl === urls.main ? run.main : await run.deps.openTarget(urls.ddl);
}

/** Step 1 (fresh run): marker before the lock, pause marker, source under the lock, in-run plan bound to the approval. */
async function quiesceFresh(run: Run, input: PlanInputs, expect: string): Promise<void> {
  writeGraduationManifest(run.m, run.path);
  writeIntentMarker(run.dataDir, markerFor(run));
  await claimPause(run);
  await openSourceUnderLock(run);
  await openTargets(run);
  const plan = await assemblePlan(run.deps, input, run.source, run.main, false);
  if (plan.planHash !== expect) {
    throw opError('preview_changed', 'The brain or target changed since the approved plan; nothing was moved.',
      'Show the user the fresh plan (the preview command) and rerun with its plan_hash after they agree.',
      { why: 'The approval binds identities, inventory, blockers, trigger bypass and target emptiness; one of them changed.',
        fix: { argv: runArgv(input.invokedAs, input.routes, plan.planHash), consent: ['egress', 'destructive'], actor: 'agent', requires_exclusive: true,
          why: 'Runs the move against the fresh plan once the user agrees.', plan_hash: plan.planHash, preview_argv: planArgv(run), verify: { argv: STATUS_ARGV } } });
  }
  const blocker = plan.blockers.find(b => b.needsUser || b.kind === 'unclassified_relation');
  if (blocker) throw blockerRefusal(blocker, run);
  run.m.source = plan.source;
  run.m.triggerBypass = plan.triggerBypass!;
  const [pending] = await run.source!.executeRaw<{ request_id: string | null }>(
    `SELECT request_id::text AS request_id FROM persistence_requests WHERE state IN ('queued','running','recovering') ORDER BY sequence LIMIT 1`).catch(() => [{ request_id: null }]);
  run.m.replayRequestId = pending?.request_id ?? null;
  save(run);
}

/** Step 1 on resume: same custody, recorded identities; before cutover the recorded approval must still match. */
async function quiesceResume(run: Run): Promise<void> {
  writeIntentMarker(run.dataDir, markerFor(run));
  await claimPause(run);
  await openSourceUnderLock(run);
  const [brain] = await run.source!.executeRaw<{ brain_id: string }>('SELECT brain_id::text AS brain_id FROM persistence_brain WHERE singleton = 1');
  if (run.m.source.brainId && brain?.brain_id !== run.m.source.brainId) {
    throw graduationSplitBrainError({ dataDir: run.dataDir, movedTo: null, marker: readIntentMarker(run.dataDir),
      detail: `The datastore at ${run.dataDir} has brain_id ${brain?.brain_id ?? 'unknown'}, not the recorded ${run.m.source.brainId}.` });
  }
  await openTargets(run);
  if (STATE_RANK[run.m.state] < STATE_RANK.cutover) await recheckApproval(run);
}

async function recheckApproval(run: Run): Promise<void> {
  const config = loadConfigFileOnly() ?? run.opts.config ?? ({ engine: 'pglite', database_path: run.dataDir } as GBrainConfig);
  const row = await readGraduationRow(run.main!);
  const input: PlanInputs = {
    config: { ...config, engine: 'pglite', database_path: run.dataDir }, env: run.opts.env ?? process.env,
    routes: { ...run.m.routes, mainUrl: run.m.targetUrls!.main, ddlUrl: run.m.targetUrls!.ddl }, target: run.m.target,
    invokedAs: invokedAs(run), force: false, triggerBypassOverride: run.m.triggerBypass, batchBytes: run.opts.batchBytes,
  };
  const ours = row?.role === 'target' && row.run_id === run.m.runId;
  const plan = await assemblePlan(run.deps, input, run.source, run.main, ours);
  const blocker = plan.blockers.find(b => b.needsUser || b.kind === 'unclassified_relation');
  if (blocker) throw blockerRefusal(blocker, run);
  if (!run.m.force && plan.planHash !== run.m.planHash) {
    throw opError('preview_changed', 'The brain or target changed since the approved plan; the run did not continue.',
      'Show the user the fresh plan and, after they agree, roll this run back (`gbrain migrate --rollback-to-source`) and start again with the new plan_hash.',
      { why: 'Resume reuses the recorded approval only while identities, inventory, person-needed blockers and trigger bypass are unchanged.',
        fix: { argv: planArgv(run), consent: ['egress'], actor: 'agent', requires_exclusive: false, why: 'Shows the fresh plan.', plan_hash: plan.planHash, verify: { argv: STATUS_ARGV } } });
  }
}

async function sourceReceipts(run: Run): Promise<TableReceipt[]> {
  const receipts: TableReceipt[] = [];
  for (const entry of await run.deps.copyOrder(run.source!, run.deps.inventory)) {
    receipts.push(await run.deps.digestTable(run.source!, entry, { applyTransforms: true }));
  }
  return receipts;
}

function changedRelations(before: readonly TableReceipt[], after: readonly TableReceipt[]): string[] {
  const old = new Map(before.map(r => [r.relation, r.rootSha256]));
  return after.filter(r => old.get(r.relation) !== r.rootSha256).map(r => r.relation)
    .concat(before.filter(r => !after.some(a => a.relation === r.relation)).map(r => r.relation));
}

/** Mark relations and their FK dependency closure for re-copy. */
async function markForRecopy(run: Run, relations: readonly string[]): Promise<void> {
  const closure = new Set<string>();
  for (const relation of relations) {
    closure.add(relation);
    for (const child of await run.deps.fkClosure(run.source!, relation)) closure.add(child);
  }
  run.m.tables = run.m.tables.map(t => closure.has(t.relation) ? { ...t, state: 'pending' as const, batches: 0 } : t);
}

/** Lock-gap re-check: a resumed run before the tombstone recomputes source digests; any change returns it to the drain. */
async function lockGapRecheck(run: Run): Promise<void> {
  const state = run.m.state;
  if (!run.m.sourceReceipts?.length || STATE_RANK[state] < STATE_RANK.copying || STATE_RANK[state] > STATE_RANK.cutover) return;
  const changed = changedRelations(run.m.sourceReceipts, await sourceReceipts(run));
  const failed = state === 'verify_failed' ? (run.m.verifyFailures ?? []).map(f => f.relation).filter(Boolean) : [];
  if (!changed.length && !failed.length) return;
  await markForRecopy(run, [...changed, ...failed]);
  progress(run, { phase: 'lock_gap', message: changed.length ? `source changed while unlocked: ${changed.join(', ')}` : `re-copying ${failed.join(', ')}` });
  if (state === 'cutover') await withGraduationRun(run.source!, run.m.runId, tx => setSourceState(tx, run.m.runId, 'quiesced'), { readWrite: true });
  const row = await readGraduationRow(run.main!);
  if (row?.run_id === run.m.runId && (row.state === 'verifying' || row.state === 'verified')) {
    await withGraduationRun(run.main!, run.m.runId, tx => setTargetState(tx, run.m.runId, 'copying'));
  }
  advance(run, changed.length ? 'draining' : 'copying');
}

async function stepRecord(run: Run): Promise<void> {
  await withGraduationRun(run.source!, run.m.runId, tx => setSourceState(tx, run.m.runId, 'quiesced', { sourceBrainId: run.m.source.brainId || null, sourceDataDir: run.dataDir }), { readWrite: true });
  advance(run, 'quiesced');
  await pauseSeam(run, 'quiesced');
}

async function stepDrain(run: Run): Promise<void> {
  if (run.m.state !== 'draining') advance(run, 'draining');
  await pauseSeam(run, 'draining');
  const started = Date.now();
  const timeoutMs = run.opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const { blockers } = await run.deps.drainForGraduation(run.source!, { timeoutMs, hostId: run.m.source.hostId, config: run.opts.config ?? loadConfigFileOnly() ?? ({ engine: 'pglite' } as GBrainConfig) });
  if (blockers.length) throw drainTimeoutError(run, blockers, timeoutMs);
  await run.deps.freezeSource(run.source!);
  const receipts = await sourceReceipts(run);
  if (run.m.sourceReceipts?.length) await markForRecopy(run, changedRelations(run.m.sourceReceipts, receipts));
  run.m.sourceReceipts = receipts;
  run.m.timings = { ...run.m.timings, drain_ms: Date.now() - started };
  save(run);
}

function drainTimeoutError(run: Run, blockers: readonly GraduationBlocker[], timeoutMs: number): OperationError {
  const personal = blockers.find(b => b.needsUser);
  if (personal) return blockerRefusal(personal, run);
  const doubled = String(Math.ceil((timeoutMs * 2) / 1000));
  return graduationError('graduation_drain_timeout', `The drain did not finish within ${Math.round(timeoutMs / 1000)} s; ${blockers.length} blocker(s) are still progressing.`,
    `Rerun with a longer drain: \`gbrain migrate --resume --drain-timeout ${doubled}\`. Nothing was copied yet and the source stays authoritative and writable.`,
    'Queued and running requests must reach a terminal state before the copy, so their outcomes carry verbatim.',
    { argv: ['gbrain', 'migrate', '--resume', '--drain-timeout', doubled], consent: [], actor: 'agent', requires_exclusive: true,
      why: 'Resumes the run and drains again with twice the time.', verify: { argv: STATUS_ARGV } },
    blockers.map(b => `${b.kind}:${b.id}`).join(','));
}

/** Step 4: route cross-check, read-only emptiness, schema, target row `copying`, fence, emptiness again under the fence. */
async function stepFenceTarget(run: Run, opts: { force?: boolean }): Promise<void> {
  const { main, ddl } = run as Required<Pick<Run, 'main' | 'ddl'>>;
  await run.deps.crossCheckRoutes(main!, ddl!, run.m.runId);
  const existing = await readGraduationRow(main!);
  const ours = existing?.role === 'target' && existing.run_id === run.m.runId;
  const reuse = !!opts.force && existing?.role === 'target' && existing.state === 'abandoned';
  if (!ours) {
    const routes = { ...run.m.routes, mainUrl: run.m.targetUrls!.main, ddlUrl: run.m.targetUrls!.ddl };
    if (existing && !reuse) throw targetNotEmptyError(run, `it records graduation run ${existing.run_id} (${existing.state})`);
    if (!existing && !probeTargetEmpty(await run.deps.probeTarget(routes)) && !opts.force) throw targetNotEmptyError(run, 'it already holds gbrain data');
    await run.deps.initTargetSchema(ddl!, run.source!);
    await withGraduationRun(main!, existing?.run_id ?? run.m.runId, tx => setTargetState(tx, run.m.runId, 'copying', { sourceBrainId: run.m.source.brainId || null, sourceDataDir: run.dataDir, triggerBypass: run.m.triggerBypass }, { reuse }));
    await installGraduationFence(ddl!, run.m.runId);
    if (!opts.force && !probeTargetEmpty(await run.deps.probeTarget(routes))) throw targetNotEmptyError(run, 'rows appeared while the schema was bootstrapped');
    if (opts.force) await wipeUncopiedTables(run);
    return;
  }
  if ((await graduationFenceStatus(ddl!)).unfenced.length && existing!.state !== 'authoritative') await installGraduationFence(ddl!, run.m.runId);
}

/** `--force`: clear the tables the copy does not replace (rebuild and discard classes); carried tables are replaced by the copy. */
async function wipeUncopiedTables(run: Run): Promise<void> {
  const relations = run.deps.inventory.entries.filter(e => (e.class === 'rebuild' || e.class === 'discard') && e.engines.postgres && e.kind === 'table').map(e => e.relation);
  await withGraduationRun(run.main!, run.m.runId, async tx => {
    const present = await tx.executeRaw<{ q: string }>(`SELECT quote_ident(c.relname) AS q FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname = ANY($1::text[])`, [relations]);
    if (present.length) await tx.executeRaw(`TRUNCATE ${present.map(r => r.q).join(', ')}`);
  });
}

function targetNotEmptyError(run: Run, why: string): OperationError {
  return graduationError('graduation_target_not_empty', `The target database is not empty: ${why}.`,
    'Ask the user to pick an empty database, or to approve `--force` after the plan lists what it deletes.',
    'Graduation copies into an empty database (or one only this run wrote) so nothing foreign is merged into the brain.',
    { argv: [...planArgv(run), '--force'], consent: ['destructive'], actor: 'agent', requires_exclusive: false,
      why: 'Shows what a forced run would delete from the target, so the user can decide.', verify: { argv: planArgv(run) } });
}

/** Step 5: per-table copy with manifest checkpoints, then sequences, deferred indexes and trigger re-enable. */
async function stepCopy(run: Run): Promise<void> {
  if (run.m.state !== 'copying') advance(run, 'copying');
  const row = await readGraduationRow(run.main!);
  if (row?.state === 'verifying' || row?.state === 'verified' || row?.state === 'verify_failed') {
    await withGraduationRun(run.main!, run.m.runId, tx => setTargetState(tx, run.m.runId, 'copying'));
  }
  await pauseSeam(run, 'copying');
  const started = Date.now();
  const engines = { source: run.source!, target: run.main! };
  const order = await run.deps.copyOrder(run.source!, run.deps.inventory);
  const known = new Map(run.m.tables.map(t => [t.relation, t]));
  run.m.tables = order.map(e => known.get(e.relation) ?? { relation: e.relation, state: 'pending', batches: 0, disabledTriggers: false });
  save(run);
  const pending = order.filter(e => !['copied', 'verified'].includes(known.get(e.relation)?.state ?? 'pending'));
  if (pending.length) await run.deps.deferIndexes(run.main!);
  let done = order.length - pending.length;
  for (const entry of pending) {
    setCheckpoint(run, entry.relation, { state: 'copying', batches: 0, disabledTriggers: run.m.triggerBypass === 'disable_trigger' });
    let batches = 0;
    await run.deps.copyTable(engines, entry, { bypass: run.m.triggerBypass, batchBytes: run.opts.batchBytes, runId: run.m.runId,
      onBatch: rows => { batches += 1; progress(run, { phase: 'copy', relation: entry.relation, rows, done, total: order.length }); } });
    setCheckpoint(run, entry.relation, { state: 'copied', batches });
    done += 1;
    await pauseSeam(run, 'copy_table');
  }
  await run.deps.copySequences(engines);
  if (pending.length) await run.deps.buildDeferredIndexes(run.main!);
  const disabled = run.m.tables.filter(t => t.disabledTriggers).map(t => t.relation);
  if (disabled.length) {
    await run.deps.reenableTriggers(run.main!, disabled);
    run.m.tables = run.m.tables.map(t => ({ ...t, disabledTriggers: false }));
  }
  run.m.timings = { ...run.m.timings, copy_ms: (run.m.timings.copy_ms ?? 0) + Date.now() - started };
  save(run);
}

function setCheckpoint(run: Run, relation: string, patch: Partial<TableCheckpoint>): void {
  run.m.tables = run.m.tables.map(t => t.relation === relation ? { ...t, ...patch } : t);
  save(run);
}

/** Step 6: verify with the target fenced; only a passing verify writes `verified`. */
async function stepVerify(run: Run): Promise<void> {
  const prior = run.m.verifyFailures ?? [];
  if (run.m.state !== 'verifying') advance(run, 'verifying');
  await withGraduationRun(run.main!, run.m.runId, tx => setTargetState(tx, run.m.runId, 'verifying'));
  await pauseSeam(run, 'verifying');
  const started = Date.now();
  await run.deps.assertRelationSet(run.main!, 'postgres', run.deps.inventory);
  const result = await run.deps.verifyGraduation({ source: run.source!, target: run.main! }, {
    inventory: run.deps.inventory, sourceReceipts: run.m.sourceReceipts ?? [], replayRequestId: run.m.replayRequestId ?? undefined,
    runDoctor: () => run.deps.runTargetDoctor(run.m.runId, run.m.targetUrls!.main),
  });
  const timings = { ...run.m.timings, verify_ms: Date.now() - started };
  if (!result.ok) {
    await withGraduationRun(run.main!, run.m.runId, tx => setTargetState(tx, run.m.runId, 'verify_failed', { tableReceipts: result.tables, replayProbe: result.replay, timings, doctor: { target: result.doctorFailingChecks } }));
    advance(run, 'verify_failed', { verifyFailures: result.failures, timings });
    const repeated = result.failures.some(f => prior.some(p => p.relation === f.relation && p.kind === f.kind));
    const first = result.failures[0];
    throw graduationError('graduation_verify_failed',
      `Verify failed: ${result.failures.map(f => `${f.relation} (${f.kind}${f.firstKey ? ` at ${f.firstKey}` : ''}${f.column ? `, column ${f.column}` : ''})`).join('; ')}.`,
      repeated ? 'The same mismatch repeated after a re-copy: report it with the detail below. `gbrain migrate --rollback-to-source` discards the target and keeps the source.'
        : 'Run `gbrain migrate --resume`; it re-copies the mismatched tables with their dependants and verifies again. The source stays authoritative and writable.',
      first ? `Verify sub-cause ${first.kind}: ${first.detail}` : 'Verify reported a failure.',
      repeated ? { consent: [], actor: 'agent', requires_exclusive: false, why: 'A repeated mismatch is a gbrain bug: report it with the table, first key and column; the source is untouched.' }
        : { argv: ['gbrain', 'migrate', '--resume'], consent: [], actor: 'agent', requires_exclusive: true, why: 'Re-copies the mismatched tables once and verifies again.', verify: { argv: STATUS_ARGV } },
      JSON.stringify(result.failures.slice(0, 20)));
  }
  await withGraduationRun(run.main!, run.m.runId, tx => setTargetState(tx, run.m.runId, 'verified', { tableReceipts: result.tables, replayProbe: result.replay, timings, triggerBypass: run.m.triggerBypass, doctor: { target: result.doctorFailingChecks } }));
  run.m.tables = run.m.tables.map(t => ({ ...t, state: 'verified' as const }));
  advance(run, 'verified', { verifyFailures: [], timings });
  await pauseSeam(run, 'verified');
}

/** Step 7a: re-apply sequences, fence the source (`cutover`), close it keeping the lock, move aside, tombstone. */
async function stepCutover(run: Run): Promise<void> {
  await run.deps.copySequences({ source: run.source!, target: run.main! });
  const [brain] = await run.source!.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton = 1');
  const [seq] = await run.source!.executeRaw<{ s: string }>('SELECT COALESCE(max(sequence), 0)::text AS s FROM persistence_requests');
  const row = await readGraduationRow(run.source!);
  if (row?.state !== 'cutover') await withGraduationRun(run.source!, run.m.runId, tx => setSourceState(tx, run.m.runId, 'cutover', { cutoverSequence: seq?.s ?? '0' }), { readWrite: true });
  if (run.m.state !== 'cutover') advance(run, 'cutover', { sourceEnabled: brain?.enabled === true, cutoverSequence: seq?.s ?? '0' });
  await pauseSeam(run, 'cutover');
  const source = run.source!;
  run.lock = await source.closeRetainingLock();
  run.source = null;
  await source.disconnect();
  await pauseSeam(run, 'before_rename');
  moveAsideHeld(run.dataDir, run.lock, run.m.runId);
  await pauseSeam(run, 'after_rename');
  await tombstoneUnderLock(run);
}

async function tombstoneUnderLock(run: Run): Promise<void> {
  const movedTo = graduatedPath(run.dataDir, run.m.runId);
  const existing = readTombstone(run.dataDir);
  if (!(existing && existing.runId === run.m.runId)) {
    try {
      writeTombstone(run.dataDir, {
        kind: 'gbrain-engine-graduated', runId: run.m.runId, brainId: run.m.source.brainId, movedTo, target: run.m.target,
        targetDisplayUrl: targetDisplayUrl(run.m.target), graduatedAt: new Date().toISOString(),
        fixArgv: ['gbrain', 'config', 'set', 'database_url', '<GBRAIN_TARGET_URL>'],
      });
    } catch (error) {
      if (error instanceof TombstonePathOccupiedError) throw graduationSplitBrainError(inspectGraduationPath(run.dataDir));
      throw error;
    }
  }
  advance(run, 'tombstoned', { graduatedAt: run.m.graduatedAt ?? new Date().toISOString() });
  await pauseSeam(run, 'tombstoned');
}

/** Step 7b: one target transaction grants authority (persistence enabled as on the source) and drops the fence. */
async function stepAuthority(run: Run): Promise<void> {
  const state = inspectGraduationPath(run.dataDir);
  if (state.kind === 'split_brain' || readTombstone(run.dataDir)?.runId !== run.m.runId) throw graduationSplitBrainError(state);
  await openTargets(run);
  await withGraduationRun(run.main!, run.m.runId, async tx => {
    await tx.executeRaw('UPDATE persistence_brain SET enabled = $1 WHERE singleton = 1', [run.m.sourceEnabled === true]);
    await dropGraduationFence(tx);
    await setTargetState(tx, run.m.runId, 'authoritative', { cutoverSequence: run.m.cutoverSequence ?? '0', graduatedAt: 'now', timings: run.m.timings });
  });
  advance(run, 'authoritative');
  await pauseSeam(run, 'authoritative');
}

/** Step 8: routing flip, registry/mount rewrite, manifest `graduated`, then the caller releases lock and pause marker. */
async function stepFlip(run: Run): Promise<void> {
  const file = loadConfigFileOnly() ?? run.opts.config ?? ({ engine: 'pglite' } as GBrainConfig);
  const next = { ...file, engine: 'postgres' as const, database_url: run.m.targetUrls!.main };
  delete (next as { database_path?: string }).database_path;
  saveConfig(next as GBrainConfig);
  const mounts = rewriteMounts(run.deps.mountsPath(), mount => mount.engine === 'pglite' && !!mount.database_path && graduationDataDir(mount.database_path) === run.dataDir,
    mount => { const { database_path: _p, ...rest } = mount; return { ...rest, engine: 'postgres', database_url: run.m.targetUrls!.main }; });
  await pauseSeam(run, 'routing_flipped');
  advance(run, 'graduated', { rewrittenMounts: [...new Set([...(run.m.rewrittenMounts ?? []), ...mounts])] });
}

interface MountRecord { id: string; engine: string; database_path?: string; database_url?: string; [key: string]: unknown }

function rewriteMounts(path: string, match: (m: MountRecord) => boolean, rewrite: (m: MountRecord) => MountRecord): string[] {
  if (!existsSync(path)) return [];
  const file = JSON.parse(readFileSync(path, 'utf8')) as { version: number; mounts?: MountRecord[] };
  const ids: string[] = [];
  const mounts = (file.mounts ?? []).map(m => { if (!match(m)) return m; ids.push(m.id); return rewrite(m); });
  if (ids.length) writeFileDurably(path, `${JSON.stringify({ ...file, mounts }, null, 2)}\n`);
  return ids;
}

async function receiptOf(run: Run): Promise<GraduationReceipt> {
  if (!run.main) await openTargets(run);
  const row = await readGraduationRow(run.main!);
  return { runId: run.m.runId, state: (row?.state ?? 'authoritative') as GraduationReceipt['state'], tables: row?.table_receipts ?? [],
    triggerBypass: run.m.triggerBypass, replay: row?.replay_probe ?? { status: 'not_available', reason: 'no_uncompacted_request' }, timings: run.m.timings };
}

async function takeKernelLock(run: Run): Promise<void> {
  if (run.lock) return;
  const movedTo = graduatedPath(run.dataDir, run.m.runId);
  run.lock = await acquireKernelLockOnly(run.dataDir, { lockDir: join(existsSync(movedTo) ? movedTo : run.dataDir, '.gbrain-lock'), timeoutMs: run.opts.handoffTimeoutMs ?? HANDOFF_TIMEOUT_MS });
}

/** Continue a run from its recorded state to `graduated`. */
async function continueRun(run: Run, opts: { force?: boolean } = {}): Promise<GraduationReceipt> {
  if (run.m.state === 'cutover') {
    const path = inspectGraduationPath(run.dataDir);
    if (path.kind === 'split_brain') throw graduationSplitBrainError(path);
    const tombstone = readTombstone(run.dataDir);
    if (tombstone?.runId === run.m.runId || (!existsSync(run.dataDir) && path.movedTo)) {
      await claimPause(run);
      await takeKernelLock(run);
      await tombstoneUnderLock(run);
    }
  }
  if (STATE_RANK[run.m.state] < STATE_RANK.tombstoned) {
    if (run.m.state !== 'planned' || !run.source) await quiesceResume(run);
    if (run.m.state === 'planned') await stepRecord(run);
    await stepFenceTargetIfStarted(run, opts);
    await lockGapRecheck(run);
    if (run.m.state === 'quiesced' || run.m.state === 'draining') await stepDrain(run);
    else await run.deps.freezeSource(run.source!);
    if (STATE_RANK[run.m.state] <= STATE_RANK.draining) await stepFenceTarget(run, opts);
    if (STATE_RANK[run.m.state] <= STATE_RANK.copying || run.m.state === 'verify_failed') await stepCopy(run);
    if (run.m.state === 'copying' || run.m.state === 'verifying') await stepVerify(run);
    await stepCutover(run);
  }
  if (run.m.state === 'tombstoned') { await claimPause(run); await takeKernelLock(run); await stepAuthority(run); }
  if (run.m.state === 'authoritative') { await claimPause(run); await takeKernelLock(run); await stepFlip(run); }
  return receiptOf(run);
}

/** Past the fence step the target row must stay fenced; reconnect and repair before the lock-gap re-check reads it. */
async function stepFenceTargetIfStarted(run: Run, opts: { force?: boolean }): Promise<void> {
  if (STATE_RANK[run.m.state] > STATE_RANK.draining) await stepFenceTarget(run, opts);
}

function newManifest(input: PlanInputs, expect: string, runId: string): GraduationManifest {
  const now = new Date().toISOString();
  return {
    version: GRADUATION_MANIFEST_VERSION, runId, state: 'planned',
    source: { dataDir: sourceDataDir(input.config), brainId: '', hostId: '' }, target: input.target,
    routes: { main: input.routes.main, ddl: input.routes.ddl, ...(input.routes.urlEnv ? { urlEnv: input.routes.urlEnv } : {}) },
    inventoryVersion: 0, schemaVersion: LATEST_VERSION, planHash: expect, triggerBypass: input.triggerBypassOverride ?? 'session_replication_role',
    tables: [], timings: {}, startedAt: now, updatedAt: now,
    targetUrls: { main: input.routes.mainUrl, ddl: input.routes.ddlUrl }, invokedAs: input.invokedAs, force: input.force,
  };
}

/** Abandon a run that never fenced anything (refused at step 1): the source stays exactly as it was. */
function abandonUnstarted(run: Run): void {
  try { transitionManifest(run.m, 'abandoned'); writeGraduationManifest(run.m, run.path); } catch { /* best effort */ }
  try { removeIntentMarker(run.dataDir); } catch { /* best effort */ }
}

/**
 * Run the approved graduation end to end. Refusals before the fence leave
 * the source unchanged and writable; a drain timeout or verify failure is
 * resumable with `resumeGraduation`.
 */
export async function runGraduation(opts: GraduationRunOptions): Promise<GraduationReceipt> {
  const path = opts.manifestPath ?? graduationManifestPath();
  const existing = readGraduationManifest(path);
  if (existing && !TERMINAL_STATES.has(existing.state)) throw existingRunError(existing);
  const deps = { ...defaultGraduationDeps(), ...opts.deps };
  const input = planInputs(deps, opts);
  const dataDir = sourceDataDir(opts.config);
  refuseOnPathState(inspectGraduationPath(dataDir));
  if (existing) renameSync(path, `${path.replace(/\.json$/, '')}.${existing.runId}.json`);
  const manifest = newManifest(input, opts.expect, randomUUID());
  manifest.inventoryVersion = deps.inventory.version;
  const run = newRun(manifest, path, { ...opts, deps });
  try {
    try { await quiesceFresh(run, input, opts.expect); }
    catch (error) { abandonUnstarted(run); throw error; }
    return await continueRun(run, { force: opts.force });
  } finally { await cleanup(run); }
}

function existingRunError(m: GraduationManifest): OperationError {
  const marker = (() => { try { return readIntentMarker(m.source.dataDir); } catch { return null; } })();
  if (marker && markerLiveness(marker) === 'alive') return graduationInProgressError({ runId: m.runId, state: m.state, where: 'source' });
  return graduationInterruptedError({ runId: m.runId, state: m.state, detail: 'Finish it with `gbrain migrate --resume` or discard it with `gbrain migrate --rollback-to-source` before starting another.' });
}

function loadRun(opts: CommonOptions & { url?: string; urlEnv?: string }): Run {
  const path = opts.manifestPath ?? graduationManifestPath();
  const m = readGraduationManifest(path);
  if (!m) {
    throw opError('not_found', 'No graduation run is recorded on this machine.',
      'Start one with the plan command: `gbrain migrate --to postgres --url-env GBRAIN_TARGET_URL --plan --json`.',
      { why: 'Resume, rollback and reconcile act on the run recorded in the graduation manifest.',
        fix: { argv: ['gbrain', 'migrate', '--to', 'postgres', '--url-env', 'GBRAIN_TARGET_URL', '--plan', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows the read-only graduation plan.' } });
  }
  const run = newRun(m, path, opts);
  if (opts.url || opts.urlEnv) {
    const routes = run.deps.resolveTargetRoutes({ url: opts.url, urlEnv: opts.urlEnv, env: opts.env ?? process.env });
    if (run.deps.targetIdentity(routes.mainUrl).id !== m.target.id) {
      run.unregister();
      throw opError('invalid_params', 'The given target is not the database this run recorded.',
        'Drop --url/--url-env to use the recorded target, or pass a URL for the same host, port, database and user.',
        { why: 'A run continues against the target identity recorded in its manifest.', fix: { argv: STATUS_ARGV, consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows the recorded target (redacted).' } });
    }
    m.targetUrls = { main: routes.mainUrl, ddl: routes.ddlUrl };
    if (routes.urlEnv) m.routes = { ...m.routes, urlEnv: routes.urlEnv };
    writeGraduationManifest(m, path);
  }
  return run;
}

/** Continue the recorded run from its first incomplete step (reconciling first). */
export async function resumeGraduation(opts: GraduationResumeOptions = {}): Promise<GraduationReceipt> {
  const run = loadRun(opts);
  try {
    await reconcileRun(run);
    if (run.m.state === 'graduated') return await receiptOf(run);
    if (STATE_RANK[run.m.state] >= STATE_RANK.rollback_fenced) throw existingRunError(run.m);
    return await continueRun(run, { force: run.m.force });
  } finally { await cleanup(run); }
}

// ── reconciliation ─────────────────────────────────────────────────────────

export interface ReconcileResult { state: ManifestState | 'none'; actions: readonly string[]; detail: string }

async function reconcileRun(run: Run): Promise<ReconcileResult> {
  const actions: string[] = [];
  const path = inspectGraduationPath(run.dataDir);
  if (path.kind === 'split_brain') throw graduationSplitBrainError(path);
  if (run.m.state === 'rollback_fenced') {
    if (run.m.rollbackFrom === 'authoritative' || run.m.rollbackFrom === 'graduated') { await returnToAuthority(run); actions.push('returned target to authority'); }
    else { await approveAndRestore(run); actions.push('finished rollback'); }
  } else if (run.m.state === 'rollback_approved' || run.m.state === 'source_restoring') {
    await finishRollback(run);
    actions.push('finished rollback');
  } else if (STATE_RANK[run.m.state] >= STATE_RANK.copying && STATE_RANK[run.m.state] <= STATE_RANK.tombstoned && run.m.state !== 'cutover' || run.m.state === 'cutover') {
    await openTargets(run);
    const row = await readGraduationRow(run.main!);
    if (row?.role === 'target' && row.run_id === run.m.runId && row.state !== 'authoritative' && (await graduationFenceStatus(run.ddl!)).unfenced.length) {
      await installGraduationFence(run.ddl!, run.m.runId);
      actions.push('re-installed target fence');
    }
  }
  return { state: run.m.state, actions, detail: actions.join('; ') };
}

/** Repair after a crash: fence re-install, rollback roll-forward or return to authority. Never starts a move. */
export async function reconcileGraduation(opts: CommonOptions = {}): Promise<ReconcileResult> {
  const path = opts.manifestPath ?? graduationManifestPath();
  if (!readGraduationManifest(path)) return { state: 'none', actions: [], detail: '' };
  const run = loadRun(opts);
  try { return await reconcileRun(run); } finally { await cleanup(run); }
}

// ── rollback ───────────────────────────────────────────────────────────────

export interface RollbackLoss {
  relation: string;
  lossKind: LossKind;
  change: 'changed' | 'added' | 'missing' | 'requests_after_cutover';
  rows: number;
  /** Withdrawals and security changes are never confirmable (nothing is written back to the source). */
  final: boolean;
}

export interface GraduationRollbackResult { runId: string; state: 'rolled_back' | 'abandoned'; dropped: readonly RollbackLoss[] }

/**
 * Roll back to the source. Before cutover: mark the target abandoned (it keeps
 * its fence) and release the source. After cutover: fence the target
 * (`rollback_fenced`), take the kernel lock, then compare; withdrawals and
 * security changes refuse finally, other user-data loss needs
 * `--yes --expect <hash>`; a refusal returns the target to authority.
 */
export async function rollbackGraduation(opts: GraduationRollbackOptions = {}): Promise<GraduationRollbackResult> {
  const run = loadRun(opts);
  try {
    await reconcileRun(run);
    const state = run.m.state;
    if (state === 'rolled_back' || state === 'abandoned') return { runId: run.m.runId, state, dropped: [] };
    if (STATE_RANK[state] <= STATE_RANK.verified) return await rollbackBeforeCutover(run);
    return await rollbackAfterCutover(run, opts);
  } finally { await cleanup(run); }
}

async function rollbackBeforeCutover(run: Run): Promise<GraduationRollbackResult> {
  writeIntentMarker(run.dataDir, markerFor(run));
  await claimPause(run);
  await openSourceUnderLock(run);
  const sourceRow = await readGraduationRow(run.source!);
  if (sourceRow?.run_id === run.m.runId && sourceRow.state === 'quiesced') {
    await withGraduationRun(run.source!, run.m.runId, tx => setSourceState(tx, run.m.runId, 'rolled_back'), { readWrite: true });
  }
  if (STATE_RANK[run.m.state] >= STATE_RANK.draining) {
    await openTargets(run);
    const row = await readGraduationRow(run.main!);
    if (row?.role === 'target' && row.run_id === run.m.runId && row.state !== 'abandoned') {
      await withGraduationRun(run.main!, run.m.runId, tx => setTargetState(tx, run.m.runId, 'abandoned'));
      await installGraduationFence(run.ddl!, run.m.runId);
    }
  }
  advance(run, 'abandoned');
  return { runId: run.m.runId, state: 'abandoned', dropped: [] };
}

async function rollbackAfterCutover(run: Run, opts: GraduationRollbackOptions): Promise<GraduationRollbackResult> {
  const from = run.m.state;
  const hadAuthority = from === 'authoritative' || from === 'graduated';
  await openTargets(run);
  if (hadAuthority) {
    const carried = run.deps.inventory.entries.filter(e => (e.class === 'carry' || e.class === 'rebind') && e.engines.postgres && e.kind === 'table').map(e => e.relation);
    await withGraduationRun(run.main!, run.m.runId, async tx => {
      await setTargetState(tx, run.m.runId, 'rollback_fenced');
      await installGraduationFence(tx, run.m.runId);
      const present = await tx.executeRaw<{ q: string }>(`SELECT quote_ident(c.relname) AS q FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname = ANY($1::text[])`, [carried]);
      if (present.length) await tx.executeRaw(`LOCK TABLE ${present.map(r => r.q).join(', ')} IN EXCLUSIVE MODE`);
    });
  }
  advance(run, 'rollback_fenced', { rollbackFrom: from });
  await pauseSeam(run, 'rollback_fenced');
  let losses: RollbackLoss[] = [];
  try {
    await claimPause(run);
    await takeKernelLock(run);
    if (hadAuthority) losses = await detectRollbackLosses(run);
  } catch (error) {
    if (hadAuthority) await returnToAuthority(run);
    throw error;
  }
  const final = losses.filter(l => l.final);
  if (final.length) {
    await returnToAuthority(run);
    throw rollbackLostError(run, final, null);
  }
  const confirmable = losses.filter(l => l.lossKind !== 'operational');
  if (confirmable.length) {
    const hash = lossHash(run.m.runId, confirmable);
    if (!(opts.yes && opts.expect === hash)) {
      await returnToAuthority(run);
      throw rollbackLostError(run, confirmable, hash);
    }
  }
  await approveAndRestore(run);
  return { runId: run.m.runId, state: 'rolled_back', dropped: losses };
}

async function approveAndRestore(run: Run): Promise<void> {
  const row = run.main ? await readGraduationRow(run.main) : null;
  if (row?.run_id === run.m.runId && row.state === 'rollback_fenced') {
    await withGraduationRun(run.main!, run.m.runId, tx => setTargetState(tx, run.m.runId, 'rollback_approved'));
  }
  advance(run, 'rollback_approved');
  await pauseSeam(run, 'rollback_approved');
  await finishRollback(run);
}

/** After approval, reconciliation only rolls forward: restore the datastore, reset the source row, flip routing back. */
async function finishRollback(run: Run): Promise<void> {
  await openTargets(run);
  await claimPause(run);
  await takeKernelLock(run);
  const row = await readGraduationRow(run.main!);
  const authorityPath = row?.run_id === run.m.runId && ['rollback_approved', 'source_restoring'].includes(row.state);
  if (authorityPath && row!.state === 'rollback_approved') await withGraduationRun(run.main!, run.m.runId, tx => setTargetState(tx, run.m.runId, 'source_restoring'));
  if (run.m.state !== 'source_restoring') advance(run, 'source_restoring');
  await pauseSeam(run, 'source_restoring');
  const movedTo = graduatedPath(run.dataDir, run.m.runId);
  if (readTombstone(run.dataDir)) removeTombstone(run.dataDir, run.m.runId);
  if (existsSync(movedTo)) {
    if (existsSync(run.dataDir)) throw graduationSplitBrainError(inspectGraduationPath(run.dataDir));
    moveHeldPglite(movedTo, run.dataDir, run.lock!);
  }
  const source = await run.deps.newSourceEngine();
  await source.connectWithHeldLock({ engine: 'pglite', database_path: run.dataDir }, run.lock!);
  run.lock = null;
  run.source = source;
  const sourceRow = await readGraduationRow(source);
  if (sourceRow?.run_id === run.m.runId && sourceRow.state !== 'rolled_back') {
    await withGraduationRun(source, run.m.runId, tx => setSourceState(tx, run.m.runId, 'rolled_back'), { readWrite: true });
  }
  const file = loadConfigFileOnly();
  if (file && file.engine === 'postgres') {
    const next = { ...file, engine: 'pglite' as const, database_path: run.dataDir };
    delete (next as { database_url?: string }).database_url;
    saveConfig(next as GBrainConfig);
  }
  const ids = new Set(run.m.rewrittenMounts ?? []);
  rewriteMounts(run.deps.mountsPath(), mount => ids.has(mount.id) && mount.engine === 'postgres',
    mount => { const { database_url: _u, ...rest } = mount; return { ...rest, engine: 'pglite', database_path: run.dataDir }; });
  const target = await readGraduationRow(run.main!);
  if (target?.run_id === run.m.runId) {
    if (target.state === 'source_restoring') await withGraduationRun(run.main!, run.m.runId, tx => setTargetState(tx, run.m.runId, 'rolled_back'));
    else if (target.state === 'verified' || target.state === 'verifying' || target.state === 'copying' || target.state === 'verify_failed') {
      await withGraduationRun(run.main!, run.m.runId, tx => setTargetState(tx, run.m.runId, 'abandoned'));
    }
    if ((await graduationFenceStatus(run.ddl!)).unfenced.length) await installGraduationFence(run.ddl!, run.m.runId);
  }
  advance(run, 'rolled_back');
  fsyncParent(run.dataDir);
}

/** Any refusal, decline or timeout returns the target from `rollback_fenced` to authority, dropping the fence in the same transaction. */
async function returnToAuthority(run: Run): Promise<void> {
  await openTargets(run);
  await withGraduationRun(run.main!, run.m.runId, async tx => {
    const row = await readGraduationRow(tx);
    if (row?.state === 'rollback_fenced') await setTargetState(tx, run.m.runId, 'authoritative');
    await dropGraduationFence(tx);
  });
  const back = run.m.rollbackFrom === 'graduated' ? 'graduated' : 'authoritative';
  if (run.m.state === 'rollback_fenced') advance(run, back);
  if (run.lock) { const lock = run.lock; run.lock = null; await releaseLock(lock); }
}

function lossHash(runId: string, losses: readonly RollbackLoss[]): string {
  return planHashOf({ runId, losses: losses.map(l => `${l.relation}:${l.change}:${l.rows}`).sort() });
}

function rollbackLostError(run: Run, losses: readonly RollbackLoss[], hash: string | null): OperationError {
  const list = losses.map(l => `${l.relation}: ${l.rows} ${l.change} (${l.lossKind})`).join('; ');
  if (!hash) {
    return graduationError('graduation_rollback_writes_lost',
      `Rollback refused: the target has withdrawals or security changes since cutover that the source does not have (${list}).`,
      'Stay on Postgres: the target is authoritative again and keeps every change. Report this if the user still needs the PGLite copy; nothing is ever written back to the source.',
      'Rolling back would resurrect withdrawn facts or revoked credentials, so it is refused even with --yes.',
      { consent: [], actor: 'agent', requires_exclusive: false, why: 'Forward recovery on the target is the only safe path; report the listed changes.' }, list);
  }
  return graduationError('graduation_rollback_writes_lost',
    `Rolling back would drop changes made on the target since cutover: ${list}.`,
    'Ask the user whether to drop those changes; after they agree, run the command in fix. The target is authoritative again until then.',
    'Nothing is written back to the source, so changes made on Postgres after cutover are lost by a rollback.',
    { argv: ['gbrain', 'migrate', '--rollback-to-source', '--yes', '--expect', hash], consent: ['destructive'], actor: 'agent', requires_exclusive: true,
      plan_hash: hash, why: 'Rolls back to the PGLite source and drops the listed target changes.', verify: { argv: STATUS_ARGV },
      user_message: `Rolling back to PGLite drops these changes made since the move: ${list}. Should I roll back?` }, list);
}

async function detectRollbackLosses(run: Run): Promise<RollbackLoss[]> {
  const losses: RollbackLoss[] = [];
  const row = await readGraduationRow(run.main!);
  const receipts = new Map((row?.table_receipts ?? []).map(r => [r.relation, r]));
  const securityNames = new Set<string>(SECURITY_TABLES);
  for (const entry of run.deps.inventory.entries) {
    if (!(entry.class === 'carry' || entry.class === 'rebind') || !entry.engines.postgres || securityNames.has(entry.relation)) continue;
    const before = receipts.get(entry.relation);
    if (!before) continue;
    const now = await run.deps.digestTable(run.main!, entry);
    if (now.rootSha256 !== before.rootSha256) {
      losses.push({ relation: entry.relation, lossKind: entry.lossKind, change: 'changed', rows: Math.abs(now.rows - before.rows) || now.rows, final: false });
    }
  }
  const [after] = await run.main!.executeRaw<{ n: string }>('SELECT count(*)::text AS n FROM persistence_requests WHERE sequence > $1::bigint', [run.m.cutoverSequence ?? '0']);
  if (Number(after?.n ?? 0) > 0) losses.push({ relation: 'persistence_requests', lossKind: 'user_data', change: 'requests_after_cutover', rows: Number(after!.n), final: false });
  losses.push(...await compareSecurityState(run));
  return losses;
}

async function primaryKey(engine: BrainEngine, relation: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ attname: string }>(
    `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = to_regclass($1) AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)`, [relation]);
  return rows.map(r => r.attname);
}

async function securityRows(engine: BrainEngine, relation: string): Promise<Map<string, { content: string; row: Record<string, unknown> }> | null> {
  const [present] = await engine.executeRaw<{ q: string | null }>(`SELECT CASE WHEN to_regclass($1) IS NULL THEN NULL ELSE quote_ident($1) END AS q`, [relation]);
  if (!present?.q) return null;
  const pk = await primaryKey(engine, relation);
  const rows = await engine.transaction(async tx => {
    await tx.executeRaw(`SELECT set_config('TimeZone', 'UTC', true)`);
    return tx.executeRaw<{ r: unknown }>(`SELECT to_jsonb(t) AS r FROM ${present.q} t`);
  });
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value as object).sort().map(k => [k, canonical((value as Record<string, unknown>)[k])])) : value;
  const out = new Map<string, { content: string; row: Record<string, unknown> }>();
  for (const { r } of rows) {
    const row = (typeof r === 'string' ? JSON.parse(r) : r) as Record<string, unknown>;
    const key = JSON.stringify(pk.map(c => row[c]));
    const content = JSON.stringify(canonical(Object.fromEntries(Object.entries(row).filter(([k]) => !SECURITY_VOLATILE_COLUMNS.has(k)))));
    out.set(key, { content, row });
  }
  return out;
}

/** Security state by identity and content against the retained source (revocations delete rows; timestamps cannot show them). */
async function compareSecurityState(run: Run): Promise<RollbackLoss[]> {
  const movedTo = graduatedPath(run.dataDir, run.m.runId);
  if (!existsSync(movedTo)) return [];
  const retained = await run.deps.openSource(movedTo, { migrate: false });
  const losses: RollbackLoss[] = [];
  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const relation of SECURITY_TABLES) {
      const [source, target] = [await securityRows(retained, relation), await securityRows(run.main!, relation)];
      if (!source || !target) continue;
      let missing = 0, changed = 0, added = 0;
      for (const [key, value] of source) {
        const other = target.get(key);
        if (!other) {
          const expires = Number(value.row.expires_at);
          if (relation === 'oauth_tokens' && Number.isFinite(expires) && expires > 0 && expires < nowSeconds) continue;
          missing += 1;
        } else if (other.content !== value.content) changed += 1;
      }
      for (const key of target.keys()) if (!source.has(key)) added += 1;
      const withdrawal = relation === 'fact_withdrawals';
      if (missing) losses.push({ relation, lossKind: withdrawal ? 'user_data' : 'security', change: 'missing', rows: missing, final: true });
      if (changed) losses.push({ relation, lossKind: withdrawal ? 'user_data' : 'security', change: 'changed', rows: changed, final: true });
      if (added) losses.push({ relation, lossKind: withdrawal ? 'user_data' : 'security', change: 'added', rows: added, final: withdrawal });
    }
  } finally { await retained.disconnect(); }
  return losses;
}

// ── status ─────────────────────────────────────────────────────────────────

/** `gbrain migrate --status`: files only; never reconciles, migrates, repairs fences, rewrites routing or touches markers. */
export async function graduationStatus(opts: { manifestPath?: string; config?: GBrainConfig | null } = {}): Promise<GraduationStatusDoc> {
  const m = readGraduationManifest(opts.manifestPath ?? graduationManifestPath());
  const configured = opts.config === undefined ? loadConfigFileOnly() : opts.config;
  const dataDir = m?.source.dataDir ?? (configured?.engine === 'pglite' && configured.database_path ? graduationDataDir(configured.database_path) : null);
  const path = dataDir ? inspectGraduationPath(dataDir) : null;
  const live = !!path?.marker && path.liveness === 'alive';
  if (!m) {
    return { state: 'none', runId: path?.marker?.runId ?? null, manifest: null, path, targetDisplayUrl: path?.tombstone?.targetDisplayUrl ?? null, live,
      nextArgv: path?.kind === 'graduated' ? ['gbrain', 'config', 'set', 'database_url', '<GBRAIN_TARGET_URL>'] : null,
      detail: path?.detail || 'No graduation run is recorded on this machine.' };
  }
  const nextArgv = TERMINAL_STATES.has(m.state) ? null
    : path?.kind === 'split_brain' ? null
      : live ? STATUS_ARGV
        : STATE_RANK[m.state] >= STATE_RANK.rollback_fenced ? ['gbrain', 'migrate', '--rollback-to-source'] : ['gbrain', 'migrate', '--resume'];
  return { state: m.state, runId: m.runId, manifest: redactManifest(m), path, targetDisplayUrl: targetDisplayUrl(m.target), live, nextArgv,
    detail: path?.detail ?? '' };
}

export type { InventoryEntry };
