/**
 * Crash robot: runs generated op schedules through the real operation
 * handlers on a managed brain and checks the reference model after every step,
 * after every injected crash and recovery, and after the final drain.
 *
 * `runSchedule` executes one schedule inside the current process (the owner
 * consumer runs here too). The process-separated crash mode in `worker.ts`
 * reuses it: a worker installs a fault hook, the driver SIGKILLs it at the
 * chosen point, and a fresh worker recovers and resumes the schedule.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { disposePersistenceConsumer, startPersistenceConsumer } from '../../src/core/persistence/service.ts';
import { installFaultHook, type FaultPoint } from '../../src/core/persistence/fault-points.ts';
import { assertSafeE2eDatabaseUrl } from '../../test/helpers/db-guard.ts';
import { prepareTopology } from './history-fixture.ts';
import { executeOp, type OpDescriptor, type OpObservation, type World } from './ops.ts';
import { ReferenceModel, SAFETY_CLASSES, type Violation } from './model.ts';
import type { Schedule } from './generator.ts';
import { pageBody } from './generator.ts';
import { descriptor } from './ops.ts';
import { randomUUID } from 'node:crypto';

export interface ScheduleResult { label: string; seed: number; steps: number; violations: Violation[]; safety: Violation[]; observations: OpObservation[] }

/**
 * How long a drain may take before the robot calls it a wedge. Every claim a
 * dead owner left behind must be resumable well inside this bound; a lease
 * that only expires later (requests 30 s, effects 2 min) is reported.
 */
export const DRAIN_BOUND_MS = 20_000;

/** Wait until no request is pending and no effect is runnable; false when the bound passes (a wedge). */
export async function drain(engine: BrainEngine, world: World, timeoutMs = 60_000): Promise<boolean> {
  startPersistenceConsumer(engine, world.config).wake();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await engine.executeRaw<{ n: number }>(`SELECT
      (SELECT count(*) FROM persistence_requests WHERE state IN ('queued','running','recovering'))
      + (SELECT count(*) FROM persistence_effects WHERE (state IN ('queued','running') AND next_attempt_at <= now() + interval '30 seconds') OR recovery IS NOT NULL) AS n`);
    if (Number(row.n) === 0) return true;
    if (Date.now() > deadline) return false;
    await Bun.sleep(100);
  }
}

/** Run `ops` from `start`, honoring concurrent groups; every observation is folded into `model`. */
export async function runSteps(world: World, model: ReferenceModel, schedule: Schedule, start = 0,
  onStep?: (next: number, batch: OpDescriptor[]) => void): Promise<number> {
  const groupOf = new Map<string, string[]>();
  for (const group of schedule.groups) for (const id of group) groupOf.set(id, group);
  let i = start;
  while (i < schedule.ops.length) {
    const d = schedule.ops[i];
    const group = groupOf.get(d.id);
    const batch = group ? schedule.ops.slice(i).filter(op => group.includes(op.id)) : [d];
    onStep?.(i, batch);
    const observed = await Promise.all(batch.map(op => executeOp(world, op)));
    model.beginStep(batch.length > 1);
    for (let k = 0; k < batch.length; k++) {
      const op = batch[k];
      await model.observe(op, observed[k], op.replayOf ? world.observations.get(op.replayOf) : undefined);
    }
    if (batch.length > 1) await model.settleGroup(batch, observed);
    await model.checkGlobal(`after ${batch.map(op => op.id).join('+')}`);
    i += batch.length;
  }
  return i;
}

/** Resubmit every request whose caller stopped waiting while it was pending; its final receipt is folded like a first observation. */
export async function settlePending(world: World, model: ReferenceModel): Promise<void> {
  const pending = [...model.pending.values()];
  if (!pending.length) return;
  model.beginStep(false);
  for (const d of pending) {
    const seen = await executeOp(world, d);
    await model.observe({ ...d, replayOf: undefined }, seen);
    if (seen.status === 'pending') model.violate({ class: 'wedge', op: d.id, detail: `request ${d.requestId} still pending after the drain` });
  }
}

/** Finish a schedule: drain, check drained invariants, prove a fresh write still admits. */
export async function finish(world: World, model: ReferenceModel, label: string, drainMs = DRAIN_BOUND_MS): Promise<void> {
  const drained = await drain(world.engine, world, drainMs);
  if (!drained) model.violate({ class: 'wedge', detail: `${label}: requests or effects did not drain within ${drainMs / 1000} s` });
  await settlePending(world, model);
  await model.checkDrained(`${label}: drained`);
  await model.checkGlobal(`${label}: drained`);
  const source = world.remotes[0].sourceId;
  const probe = descriptor(`probe-${randomUUID().slice(0, 8)}`, 'put_page', 'local', source,
    { slug: `notes/probe-${randomUUID().slice(0, 8)}`, content: pageBody('notes/probe', 'mk-probe0') });
  const seen = await executeOp(world, probe);
  if (seen.status !== 'committed') model.violate({ class: 'wedge', detail: `${label}: a fresh write after the schedule ended ${seen.status}/${seen.code}` });
}

export async function runSchedule(world: World, schedule: Schedule): Promise<ScheduleResult> {
  const model = new ReferenceModel(world);
  world.descriptors = new Map(schedule.ops.map(d => [d.id, d]));
  await runSteps(world, model, schedule);
  await finish(world, model, schedule.label);
  return { label: schedule.label, seed: schedule.seed, steps: schedule.ops.length, violations: model.violations,
    safety: model.violations.filter(v => SAFETY_CLASSES.has(v.class)), observations: schedule.ops.map(d => world.observations.get(d.id)!) };
}

/* ------------------------------------------------------------------------ */
/* Process-separated crash mode: the worker side.                            */
/* ------------------------------------------------------------------------ */

export type ProcessFault = 'stale_index_lock' | 'hung_git';
export interface RobotConfig {
  kind: 'pglite' | 'postgres'; root: string; dataDir: string; databaseUrl?: string;
  schedule: Schedule; worktrees: number; statePath: string;
  /** SIGKILL at the nth time this seam is reached (1-based). */
  fault?: { point: FaultPoint; nth: number };
  process?: ProcessFault;
}
interface RobotState {
  remotes: World['remotes']; checkouts: string[]; next: number; inFlight: string[];
  model: Record<string, unknown>; observations: [string, OpObservation][]; submitted: [string, Record<string, unknown>][];
}
export interface RobotOutcome extends Omit<ScheduleResult, 'observations'> {
  crashed: boolean; fault?: RobotConfig['fault']; process?: ProcessFault; counts?: Record<string, number>; inFlight?: string[];
}

function writeState(config: RobotConfig, world: World, model: ReferenceModel, checkouts: string[], next: number, inFlight: string[]): void {
  const state: RobotState = { remotes: world.remotes, checkouts, next, inFlight, model: model.toJSON(),
    observations: [...world.observations], submitted: [...(world.submitted ?? [])] };
  const staged = `${config.statePath}.tmp`;
  writeFileSync(staged, JSON.stringify(state), { mode: 0o600 }); renameSync(staged, config.statePath);
}

async function openRobotEngine(config: RobotConfig, initialize: boolean): Promise<BrainEngine> {
  const engine: BrainEngine = config.kind === 'pglite' ? new PGLiteEngine() : new PostgresEngine();
  if (engine instanceof PostgresEngine) {
    assertSafeE2eDatabaseUrl(config.databaseUrl!);
    await engine.connect({ database_url: config.databaseUrl!, poolSize: 4 });
  } else await engine.connect({ database_path: config.dataDir });
  if (initialize) await engine.initSchema();
  return engine;
}

/** Freeze the whole process at a seam until the driver's SIGKILL arrives; nothing after this point runs. */
function freeze(event: Record<string, unknown>): never {
  const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
  for (let offset = 0; offset < bytes.length;) offset += writeSync(1, bytes, offset, bytes.length - offset);
  const blocked = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(blocked, 0, 0);
}

function finalize(config: RobotConfig, model: ReferenceModel, extra: Partial<RobotOutcome>): RobotOutcome {
  return { label: config.schedule.label, seed: config.schedule.seed, steps: config.schedule.ops.length, crashed: false,
    violations: model.violations, safety: model.violations.filter(v => SAFETY_CLASSES.has(v.class)), ...extra };
}

/** A git shim that hangs `git commit` while the marker file exists (a stuck child, never answering). */
function installHungGit(root: string): { marker: string; release(): void } {
  const dir = join(root, 'hung-git-bin'); mkdirSync(dir, { recursive: true });
  const real = Bun.which('git')!; const marker = join(root, 'hung-git.marker');
  writeFileSync(join(dir, 'git'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = commit ] && [ -e '${marker}' ]; then echo $$ >> '${marker}.pids'; exec sleep 600; fi; done\nexec '${real}' "$@"\n`);
  chmodSync(join(dir, 'git'), 0o755); writeFileSync(marker, '');
  process.env.PATH = `${dir}:${process.env.PATH}`;
  return { marker, release: () => rmSync(marker, { force: true }) };
}

/**
 * Process faults SIGKILL cannot model. Each must end in a terminal state or a
 * typed, agent-facing error, never a wedge, and must clear once the fault does.
 */
async function processFault(config: RobotConfig, world: World, model: ReferenceModel, checkouts: string[]): Promise<void> {
  const engine = world.engine;
  const typedGitErrors = new Set(['git_index_locked', 'git_index_stale', 'git_failed', 'git_timeout', 'targets_parked', 'storage_error']);
  const gitEffects = () => engine.executeRaw<{ id: string; state: string; error_code: string | null }>(
    "SELECT id::text,state,error_code FROM persistence_effects WHERE kind='git' AND state<>'committed'");
  if (config.process === 'stale_index_lock') {
    const lock = join(checkouts[0], '.git', 'index.lock'); writeFileSync(lock, '');
    const old = new Date(Date.now() - 3_600_000); utimesSync(lock, old, old);
    await runSteps(world, model, config.schedule);
    const deadline = Date.now() + 30_000;
    let stuck = await gitEffects();
    while (Date.now() < deadline && stuck.some(e => e.state === 'running' || !e.error_code)) { await Bun.sleep(250); stuck = await gitEffects(); }
    for (const e of stuck) if (!e.error_code || !typedGitErrors.has(e.error_code)) {
      model.violate({ class: 'wedge', detail: `stale index.lock: git effect ${e.id} is ${e.state} without a typed error (${e.error_code})` });
    }
    rmSync(lock, { force: true });
    await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE kind='git' AND state='queued'");
  } else if (config.process === 'hung_git') {
    const shim = installHungGit(config.root);
    await runSteps(world, model, config.schedule);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !existsSync(`${shim.marker}.pids`)) await Bun.sleep(100);
    if (existsSync(`${shim.marker}.pids`)) {
      const started = Date.now();
      const stopped = await Promise.race([disposePersistenceConsumer(engine).then(() => true), Bun.sleep(45_000).then(() => false)]);
      if (!stopped) model.violate({ class: 'wedge', detail: 'hung git child: consumer shutdown did not finish within 45 s' });
      else if (Date.now() - started > 30_000) model.violate({ class: 'wedge', detail: `hung git child: consumer shutdown took ${Date.now() - started} ms` });
    }
    shim.release();
    await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE kind='git' AND state='queued'");
  }
  await finish(world, model, `${config.schedule.label}+${config.process}`);
}

/**
 * Worker entry for one crash-robot role. `count` runs the schedule with a
 * counting hook; `run` starts a fresh brain and freezes at `config.fault`;
 * `recover` reopens the brain after the driver's SIGKILL, checks the
 * pre-recovery state, drains, resubmits the in-flight requests and finishes.
 */
export async function robotWorker(role: 'count' | 'run' | 'recover', config: RobotConfig): Promise<RobotOutcome> {
  const fresh = role !== 'recover';
  const engine = await openRobotEngine(config, fresh);
  try {
    let world: World; let model: ReferenceModel; let checkouts: string[]; let state: RobotState | undefined;
    if (fresh) {
      const topology = await prepareTopology(engine, { sources: 2, worktrees: config.worktrees, root: join(config.root, 'checkouts'), prefix: 'robot' });
      world = topology.world; checkouts = topology.checkouts; model = new ReferenceModel(world);
    } else {
      state = JSON.parse(readFileSync(config.statePath, 'utf8')) as RobotState;
      world = { engine, config: { engine: engine.kind, embedding_disabled: true } as GBrainConfig, remotes: state.remotes, auth: new Map(),
        observations: new Map(state.observations), submitted: new Map(state.submitted) };
      checkouts = state.checkouts; model = ReferenceModel.fromJSON(world, state.model);
    }
    world.descriptors = new Map(config.schedule.ops.map(d => [d.id, d]));
    const counts: Record<string, number> = {};
    if (role === 'count') installFaultHook(point => { counts[point] = (counts[point] ?? 0) + 1; });
    if (role === 'run' && config.fault) {
      let seen = 0; const fault = config.fault;
      installFaultHook((point, detail) => {
        if (point !== fault.point || ++seen !== fault.nth) return;
        freeze({ event: 'fault', point, nth: seen, detail });
      });
    }
    if (role === 'run') {
      let next = 0; let inFlight: string[] = [];
      world.onSubmit = () => writeState(config, world, model, checkouts, next, inFlight);
      writeState(config, world, model, checkouts, 0, []);
      if (config.process) { await processFault(config, world, model, checkouts); return finalize(config, model, { process: config.process }); }
      await runSteps(world, model, config.schedule, 0, (i, batch) => { next = i; inFlight = batch.map(d => d.id); writeState(config, world, model, checkouts, next, inFlight); });
      await finish(world, model, config.schedule.label);
      return finalize(config, model, { fault: config.fault });
    }
    if (role === 'count') {
      await runSteps(world, model, config.schedule);
      await finish(world, model, config.schedule.label);
      return finalize(config, model, { counts });
    }
    // recover
    const inFlight = state!.inFlight.map(id => world.descriptors!.get(id)!);
    model.beginStep(inFlight.length > 1);
    model.allowInFlight(inFlight); model.relaxInFlight(inFlight);
    await model.checkGlobal('after SIGKILL, before recovery');
    const drained = await drain(engine, world, DRAIN_BOUND_MS);
    if (!drained) model.violate({ class: 'wedge', detail: `recovery: requests or effects did not drain within ${DRAIN_BOUND_MS / 1000} s after restart` });
    await model.checkDrained('recovered');
    await settlePending(world, model);
    model.allowInFlight(inFlight);
    await model.checkGlobal('recovered');
    // The interrupted callers resubmit with their original request ids.
    if (inFlight.length) {
      const observed = await Promise.all(inFlight.map(d => executeOp(world, d)));
      model.beginStep(inFlight.length > 1);
      for (let k = 0; k < inFlight.length; k++) await model.observe(inFlight[k], observed[k], inFlight[k].replayOf ? world.observations.get(inFlight[k].replayOf!) : undefined);
      if (inFlight.length > 1) await model.settleGroup(inFlight, observed);
      await model.checkGlobal('after resubmission');
    }
    await runSteps(world, model, config.schedule, state!.next + inFlight.length);
    await finish(world, model, config.schedule.label);
    return finalize(config, model, { crashed: true, fault: config.fault, inFlight: state!.inFlight });
  } finally {
    installFaultHook(undefined);
    await disposePersistenceConsumer(engine).catch(() => {});
    await engine.disconnect();
  }
}
