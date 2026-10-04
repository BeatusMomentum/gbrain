/**
 * Driver for the crash robot phase of the persistence gate. For each
 * schedule (the five cross-boundary sequences first, then seeded random
 * sequences until the time budget runs out) it runs a counting pass that
 * finds every seam the schedule reaches, then one process-separated run per
 * chosen crash point: a worker freezes at the seam, the driver SIGKILLs it,
 * and a fresh worker recovers, resubmits the interrupted requests and
 * finishes the schedule. Every run is checked by the reference model.
 * Process faults (stale index.lock, hung git child) run once per engine.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type postgres from '#postgres';
import { random } from './harness.ts';
import { crossBoundarySequences, randomSchedule, type GeneratorTopology, type Schedule } from './generator.ts';
import type { ProcessFault, RobotConfig, RobotOutcome } from './crash-robot.ts';
import type { FaultPoint } from '../../src/core/persistence/fault-points.ts';
import type { OpDescriptor } from './ops.ts';
import type { spawnWorker as SpawnWorker } from './validate.ts';

export const ROBOT_TOPOLOGY: GeneratorTopology = { sources: ['robot-0', 'robot-1'],
  remotes: [{ name: 'agent-oauth', sourceId: 'robot-0' }, { name: 'agent-token', sourceId: 'robot-1' }] };
export const PROCESS_FAULTS: ProcessFault[] = ['stale_index_lock', 'hung_git'];

/** One executed run, enough to replay it exactly: `--replay` re-injects this entry. */
export interface RobotRun {
  schedule: string; seed: number; length: number; fault?: { point: FaultPoint; nth: number }; process?: ProcessFault;
  ops?: string[]; crashed: boolean; violations: RobotOutcome['violations']; duration_ms: number;
}
export interface RobotOptions {
  engine: 'pglite' | 'postgres'; seed: number; seconds: number; scratch: string; home: string;
  admin?: ReturnType<typeof postgres>; databaseUrl?: string; databases: string[];
  spawn: typeof SpawnWorker; track: (child: ReturnType<typeof SpawnWorker>) => void;
  /** Re-run exactly these entries instead of generating. */
  replay?: RobotRun[];
  /** Keep only these op ids of a schedule (shrinking). */
  keep?: Map<string, Set<string>>;
  worktrees?: number;
  log?: (line: string) => void;
}

export function scheduleFor(label: string, seed: number, length: number): Schedule {
  if (label.startsWith('random-')) return randomSchedule(ROBOT_TOPOLOGY, seed, length);
  const found = crossBoundarySequences(ROBOT_TOPOLOGY, seed).find(s => s.label === label);
  if (!found) throw new Error(`Unknown crash-robot schedule ${label}`);
  return found;
}
/** Drop ops not in `keep`, and any op whose dependencies were dropped; groups shrink with them. */
export function restrict(schedule: Schedule, keep?: Set<string>): Schedule {
  if (!keep) return schedule;
  const kept = new Set<string>();
  const ops: OpDescriptor[] = [];
  for (const d of schedule.ops) {
    if (!keep.has(d.id)) continue;
    if ((d.deps ?? []).some(dep => !kept.has(dep) && schedule.ops.some(o => o.id === dep))) continue;
    kept.add(d.id); ops.push(d);
  }
  return { ...schedule, ops, groups: schedule.groups.map(g => g.filter(id => kept.has(id))).filter(g => g.length > 1) };
}

export async function runRobotPhase(o: RobotOptions) {
  const started = performance.now();
  const runs: RobotRun[] = [];
  const log = o.log ?? (line => process.stderr.write(`[crash-robot] ${o.engine}: ${line}\n`));
  async function fresh(name: string): Promise<{ root: string; dataDir: string; databaseUrl?: string }> {
    const root = join(o.scratch, `robot-${name}-${randomUUID().slice(0, 8)}`); mkdirSync(root, { recursive: true });
    let databaseUrl: string | undefined;
    if (o.admin) {
      const database = `gbrain_persistence_test_${randomUUID().replaceAll('-', '')}`;
      await o.admin.unsafe(`CREATE DATABASE ${database}`); o.databases.push(database);
      const url = new URL(o.databaseUrl!); url.pathname = `/${database}`; databaseUrl = url.toString();
    }
    return { root, dataDir: join(root, 'data'), databaseUrl };
  }
  async function execute(schedule: Schedule, role: 'count' | 'run', extra: Partial<RobotConfig> = {}): Promise<RobotRun & { counts?: Record<string, number> }> {
    const at = performance.now();
    const place = await fresh(`${schedule.label}-${role}`);
    const config: RobotConfig = { kind: o.engine, ...place, schedule, worktrees: o.worktrees ?? 2, statePath: join(place.root, 'state.json'), ...extra };
    const path = join(place.root, 'robot.json'); writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    const base = { schedule: schedule.label, seed: schedule.seed, length: schedule.ops.length, ...(extra.fault ? { fault: extra.fault } : {}),
      ...(extra.process ? { process: extra.process } : {}), ...(o.keep?.has(schedule.label) ? { ops: schedule.ops.map(d => d.id) } : {}) };
    const child = o.spawn(path, o.home, 'robot', [role]); o.track(child);
    if (role === 'run' && extra.fault) {
      const reached = await Promise.race([child.event('fault', 600_000).then(e => ({ fault: e })), child.event('done', 600_000).then(e => ({ done: e }))]);
      if ('done' in reached) {
        const result = reached.done.result as RobotOutcome;
        return { ...base, crashed: false, violations: result.violations, duration_ms: performance.now() - at };
      }
      await child.kill();
      const recovered = o.spawn(path, o.home, 'robot', ['recover']); o.track(recovered);
      const result = (await recovered.done()).result as RobotOutcome;
      return { ...base, crashed: true, violations: result.violations, duration_ms: performance.now() - at };
    }
    const result = (await child.done()).result as RobotOutcome;
    return { ...base, crashed: false, violations: result.violations, counts: result.counts, duration_ms: performance.now() - at };
  }
  const record = (run: RobotRun) => {
    runs.push(run);
    const what = run.fault ? `${run.fault.point}#${run.fault.nth}` : run.process ?? 'no crash';
    log(`${run.schedule} ${what}: ${run.violations.length ? `${run.violations.length} VIOLATION(S) ${run.violations.map(v => v.class).join(',')}` : 'ok'} (${Math.round(run.duration_ms)} ms)`);
  };

  if (o.replay) {
    for (const entry of o.replay) {
      const schedule = restrict(scheduleFor(entry.schedule, entry.seed, entry.length), entry.ops ? new Set(entry.ops) : o.keep?.get(entry.schedule));
      record(await execute(schedule, entry.fault || entry.process ? 'run' : 'count', { ...(entry.fault ? { fault: entry.fault } : {}), ...(entry.process ? { process: entry.process } : {}) }));
    }
    return summarize(runs, started, o);
  }

  const rand = random(o.seed);
  const budgetMs = o.seconds * 1000;
  const schedules = function* (): Generator<Schedule> {
    yield* crossBoundarySequences(ROBOT_TOPOLOGY, o.seed);
    for (let i = 0; ; i++) yield randomSchedule(ROBOT_TOPOLOGY, (o.seed + 1 + i) >>> 0, 24);
  };
  const crossBoundary = new Set(crossBoundarySequences(ROBOT_TOPOLOGY, o.seed).map(s => s.label));
  for (const schedule of schedules()) {
    // The cross-boundary sequences always run; random sequences fill the remaining budget.
    if (!crossBoundary.has(schedule.label) && performance.now() - started > budgetMs) break;
    const counted = await execute(schedule, 'count'); record(counted);
    const points = Object.entries(counted.counts ?? {}).sort(([a], [b]) => a.localeCompare(b)) as [FaultPoint, number][];
    for (const [point, count] of points) {
      if (!crossBoundary.has(schedule.label) && performance.now() - started > budgetMs) break;
      record(await execute(schedule, 'run', { fault: { point, nth: 1 + Math.floor(rand() * count) } }));
    }
  }
  for (const fault of PROCESS_FAULTS) record(await execute(crossBoundarySequences(ROBOT_TOPOLOGY, o.seed)[1], 'run', { process: fault }));
  return summarize(runs, started, o);
}

function summarize(runs: RobotRun[], started: number, o: RobotOptions) {
  const crashRuns = runs.filter(r => r.fault);
  const points = new Set(crashRuns.map(r => r.fault!.point));
  const violations = runs.flatMap(r => r.violations.map(v => ({ ...v, schedule: r.schedule, seed: r.seed, fault: r.fault, process: r.process })));
  return {
    seed: o.seed, budget_seconds: o.seconds, duration_ms: performance.now() - started,
    schedules: new Set(runs.map(r => `${r.schedule}:${r.seed}`)).size,
    crash_runs: crashRuns.length, crashed_runs: crashRuns.filter(r => r.crashed).length,
    sequences_x_crash_points: crashRuns.length, distinct_crash_points: [...points].sort(),
    process_faults: runs.filter(r => r.process).map(r => ({ fault: r.process, violations: r.violations.length })),
    violations, failing_runs: runs.filter(r => r.violations.length), runs,
  };
}

/** The replay entries of a manifest: its failing runs, or every run of one seed. */
export function replayEntries(source: string, engine: string): RobotRun[] {
  if (/^\d+$/.test(source)) throw new Error('A bare seed replays through --seed; pass a manifest path to --replay');
  const manifest = JSON.parse(readFileSync(resolve(source), 'utf8'));
  const robot = manifest.robot ?? manifest;
  if (manifest.engine && manifest.engine !== engine) throw new Error(`Manifest ${source} was recorded on ${manifest.engine}, not ${engine}`);
  return (robot.failing_runs?.length ? robot.failing_runs : robot.runs) as RobotRun[];
}
export function runDigest(run: Pick<RobotRun, 'schedule' | 'seed' | 'fault' | 'process' | 'ops'>): string {
  return createHash('sha256').update(JSON.stringify([run.schedule, run.seed, run.fault ?? null, run.process ?? null, run.ops ?? null])).digest('hex').slice(0, 12);
}
