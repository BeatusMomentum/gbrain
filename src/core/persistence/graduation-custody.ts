/**
 * Engine graduation filesystem custody for a PGLite data dir: the sibling
 * intent marker `<dataDir>.gbrain-graduation.json`, the regular-file
 * tombstone left at the old path after the move-aside, the lock-free path
 * inspection every opener runs, the held-lock move-aside, and the refusal
 * builders shared by the connect path and writer admission.
 *
 * Every file here is written 0600 with fsync of the file and its parent
 * directory. The marker is replaced atomically at every state change; the
 * tombstone is created once with O_CREAT|O_EXCL so an occupied path is
 * detected (`graduation_split_brain`) instead of overwritten.
 */
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Action } from '../agent-output.ts';
import type { RegistryCode } from '../error-registry.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { inspectLockHolder, isProcessAlive, readBootId, readPidNs, type LockHandle } from '../pglite-lock.ts';
import { moveHeldPglite } from './maintenance.ts';
import type { BrainEngine } from '../engine.ts';
import { GRADUATION_RUN_SETTING, graduationTablePresent, readGraduationRow } from './graduation-schema.ts';
import type {
  GraduationErrorCode, GraduationPathState, IntentMarker, ManifestState, TargetIdentity, TargetRowState, Tombstone,
} from './engine-graduation.types.ts';

const MOVE_TO_POSTGRES_DOC = 'docs/guides/move-to-postgres.md';

/** Manifest states before the source is fenced; a dead run here leaves the source authoritative. */
export const PRE_CUTOVER_STATES: ReadonlySet<ManifestState> = new Set([
  'planned', 'quiesced', 'draining', 'copying', 'verifying', 'verified', 'verify_failed',
]);
/** Terminal states: the marker no longer stops anyone. */
export const TERMINAL_STATES: ReadonlySet<ManifestState> = new Set(['graduated', 'rolled_back', 'abandoned']);

// ── paths ──────────────────────────────────────────────────────────────────

function canonical(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(canonical(parent), basename(absolute));
  }
}
/** The data dir path with its parent resolved; the data dir itself may be a tombstone file or missing. */
export function graduationDataDir(dataDir: string): string {
  const absolute = resolve(dataDir);
  return join(canonical(dirname(absolute)), basename(absolute));
}
export function intentMarkerPath(dataDir: string): string {
  return `${graduationDataDir(dataDir)}.gbrain-graduation.json`;
}
export function graduatedPath(dataDir: string, runId: string): string {
  return `${graduationDataDir(dataDir)}.graduated-${runId}`;
}

// ── durable writes ─────────────────────────────────────────────────────────

function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try { fd = openSync(dir, 'r'); fsyncSync(fd); }
  catch (error) { if (process.platform !== 'win32') throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function fsyncParent(path: string): void { fsyncDirectory(dirname(path)); }

/** tmp + fsync + rename + fsync(parent), mode 0600. */
export function writeFileDurably(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch (error) { rmSync(tmp, { force: true }); throw error; }
  fsyncParent(path);
}

// ── in-process run identity ────────────────────────────────────────────────

const inProcessRuns = new Set<string>();
/** The orchestrator registers its run so its own connects pass the marker and target-row checks. */
export function registerGraduationRunInProcess(runId: string): () => void {
  inProcessRuns.add(runId);
  return () => { inProcessRuns.delete(runId); };
}
export function isGraduationRunInProcess(runId: string): boolean { return inProcessRuns.has(runId); }

// ── process identity (marker liveness) ─────────────────────────────────────

/** Kernel start time of `pid` (Linux /proc clock ticks), or null when unknowable. */
export function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] ?? null;
  } catch { return null; }
}

export function currentProcessIdentity(): Pick<IntentMarker, 'pid' | 'bootId' | 'pidNs' | 'processStart'> {
  return { pid: process.pid, bootId: readBootId(), pidNs: readPidNs(), processStart: processStartTime(process.pid) };
}

/**
 * Whether the marker's requesting process is still running. `unknown` when
 * the marker comes from another boot or PID namespace (another host on a
 * shared filesystem, or a container); callers then treat the kernel lock as
 * the authority (an acquirable lock means the run is gone).
 */
export function markerLiveness(marker: IntentMarker): 'alive' | 'dead' | 'unknown' {
  if (marker.pid === process.pid) return isGraduationRunInProcess(marker.runId) ? 'alive' : 'dead';
  const bootId = readBootId(), pidNs = readPidNs();
  if (marker.bootId && bootId && marker.bootId !== bootId) return 'unknown';
  if (marker.pidNs && pidNs && marker.pidNs !== pidNs) return 'unknown';
  if (!isProcessAlive(marker.pid)) return 'dead';
  if (marker.processStart) {
    const start = processStartTime(marker.pid);
    if (start && start !== marker.processStart) return 'dead';
  }
  return 'alive';
}

// ── intent marker ──────────────────────────────────────────────────────────

/** Atomic replace + fsync. Written at step 1 before the kernel lock, then at every state change. */
export function writeIntentMarker(dataDir: string, marker: IntentMarker): void {
  writeFileDurably(intentMarkerPath(dataDir), `${JSON.stringify(marker, null, 2)}\n`);
}

function isMarker(value: unknown): value is IntentMarker {
  const m = value as IntentMarker | null;
  return !!m && typeof m === 'object' && typeof m.runId === 'string' && typeof m.state === 'string' && typeof m.pid === 'number';
}

/** Null when absent. An unreadable marker throws: it is never read as "no graduation". */
export function readIntentMarker(dataDir: string): IntentMarker | null {
  let raw: string;
  try { raw = readFileSync(intentMarkerPath(dataDir), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const parsed = JSON.parse(raw) as unknown;
  if (!isMarker(parsed)) throw new Error(`Unrecognised graduation intent marker at ${intentMarkerPath(dataDir)}`);
  return parsed;
}

export function removeIntentMarker(dataDir: string): void {
  const path = intentMarkerPath(dataDir);
  try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return; }
  fsyncParent(path);
}

// ── tombstone ──────────────────────────────────────────────────────────────

export class TombstonePathOccupiedError extends Error {
  readonly code = 'graduation_split_brain';
  constructor(readonly path: string) { super(`Something already exists at ${path}; the graduation tombstone was not written.`); }
}

/**
 * Create the tombstone at the old data dir path with O_CREAT|O_EXCL (mode
 * 0600), fsync it and its parent. An occupied path throws
 * `TombstonePathOccupiedError`: a stray datastore appeared after the rename.
 */
export function writeTombstone(dataDir: string, tombstone: Tombstone): void {
  const path = graduationDataDir(dataDir);
  let fd: number;
  try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new TombstonePathOccupiedError(path); throw error; }
  try {
    writeSync(fd, `${JSON.stringify(tombstone, null, 2)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  fsyncParent(path);
}

/** The tombstone when the path is a regular file holding one; null otherwise (including a directory). */
export function readTombstone(dataDir: string): Tombstone | null {
  const path = graduationDataDir(dataDir);
  try {
    if (!lstatSync(path).isFile()) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Tombstone;
    return parsed?.kind === 'gbrain-engine-graduated' && typeof parsed.runId === 'string' ? parsed : null;
  } catch { return null; }
}

/** Rollback only: remove this run's tombstone (never anything else) and fsync the parent. */
export function removeTombstone(dataDir: string, runId: string): void {
  const path = graduationDataDir(dataDir);
  const tombstone = readTombstone(path);
  if (!tombstone) { if (existsSync(path)) throw new Error(`${path} is not a graduation tombstone; refusing to remove it.`); return; }
  if (tombstone.runId !== runId) throw new Error(`${path} belongs to graduation run ${tombstone.runId}, not ${runId}.`);
  unlinkSync(path);
  fsyncParent(path);
}

// ── path inspection ────────────────────────────────────────────────────────

/**
 * What a data dir path shows, without opening or locking it: `graduated`
 * (tombstone file), `split_brain` (a directory at the old path while this
 * run's moved copy exists and the marker says the rename happened),
 * `in_progress` (non-terminal marker whose run is alive or unknowable),
 * `interrupted` (non-terminal marker whose run is dead, or the moved copy
 * without its tombstone), or `none`.
 */
export function inspectGraduationPath(dataDir: string): GraduationPathState {
  const path = graduationDataDir(dataDir);
  let marker: IntentMarker | null = null;
  let markerError: string | null = null;
  try { marker = readIntentMarker(path); } catch (error) { markerError = (error as Error).message; }
  let stat: ReturnType<typeof lstatSync> | null = null;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const movedTo = marker && existsSync(graduatedPath(path, marker.runId)) ? graduatedPath(path, marker.runId) : null;
  const base = { dataDir: path, marker, movedTo };

  if (stat?.isFile()) {
    const tombstone = readTombstone(path);
    if (tombstone) {
      const moved = existsSync(tombstone.movedTo) ? tombstone.movedTo : movedTo;
      return { ...base, kind: 'graduated', tombstone, liveness: null, movedTo: moved, detail: `This datastore moved to Postgres (run ${tombstone.runId}).` };
    }
    return { ...base, kind: 'interrupted', tombstone: null, liveness: null, detail: `${path} is a file but not a readable graduation tombstone.` };
  }
  if (markerError) {
    return { ...base, kind: 'interrupted', tombstone: null, liveness: 'unknown', detail: markerError };
  }
  if (!marker || TERMINAL_STATES.has(marker.state)) {
    if (stat === null && marker?.state === 'graduated' && movedTo) {
      return { ...base, kind: 'interrupted', tombstone: null, liveness: null, detail: `The graduated datastore at ${movedTo} has no tombstone at ${path}.` };
    }
    return { ...base, kind: 'none', tombstone: null, liveness: null, detail: '' };
  }
  const liveness = markerLiveness(marker);
  const renamed = !PRE_CUTOVER_STATES.has(marker.state) && marker.state !== 'cutover';
  if (stat?.isDirectory() && movedTo && (renamed || marker.state === 'cutover')) {
    return { ...base, kind: 'split_brain', tombstone: null, liveness,
      detail: `A datastore exists at ${path} while graduation run ${marker.runId} already moved the original to ${movedTo}.` };
  }
  if (stat === null && movedTo) {
    return { ...base, kind: liveness === 'alive' ? 'in_progress' : 'interrupted', tombstone: null, liveness,
      detail: `Graduation run ${marker.runId} moved the datastore to ${movedTo}; the tombstone is not written yet.` };
  }
  if (liveness === 'dead') {
    return { ...base, kind: 'interrupted', tombstone: null, liveness, detail: `Graduation run ${marker.runId} stopped at ${marker.state} (pid ${marker.pid} is gone).` };
  }
  return { ...base, kind: 'in_progress', tombstone: null, liveness, detail: `Graduation run ${marker.runId} is at ${marker.state} (pid ${marker.pid}).` };
}

/**
 * A resident serve that owns `dataDir` calls this on its idle loop: it returns
 * the marker when a live graduation run on another process asks for the
 * datastore, so the serve finishes in-flight work, releases the lock and exits
 * with `graduation_in_progress`. A dead requester before cutover never stops
 * the serve.
 */
export function graduationHandOffRequested(dataDir: string): IntentMarker | null {
  let marker: IntentMarker | null;
  try { marker = readIntentMarker(dataDir); } catch { return null; }
  if (!marker || TERMINAL_STATES.has(marker.state) || marker.pid === process.pid) return null;
  return markerLiveness(marker) === 'alive' ? marker : null;
}

/**
 * The PGLite open-path check. `pre_lock` runs before `acquireLock`: a
 * tombstone refuses with `engine_graduated`, a stray datastore with
 * `graduation_split_brain`, a live run (or the lock holder recorded as
 * `migrate`) with `graduation_in_progress`. `locked` runs once this process
 * holds the kernel lock, which proves any other run is gone: a marker past
 * the source fence refuses with `graduation_interrupted`; one before it lets
 * the open proceed (the source is still authoritative).
 */
export function assertPgliteGraduationOpenable(dataDir: string, phase: 'pre_lock' | 'locked'): void {
  const state = inspectGraduationPath(dataDir);
  if (state.kind === 'none') return;
  const ours = !!state.marker && state.marker.pid === process.pid && isGraduationRunInProcess(state.marker.runId);
  if (state.kind === 'graduated') throw engineGraduatedError(state.tombstone!);
  if (state.kind === 'split_brain') throw graduationSplitBrainError(state);
  if (ours) return;
  if (phase === 'pre_lock') {
    if (state.kind === 'in_progress' && state.liveness === 'alive') {
      throw graduationInProgressError({ runId: state.marker!.runId, state: state.marker!.state, where: 'source' });
    }
    if (state.kind === 'in_progress') {
      const holder = inspectLockHolder(state.dataDir);
      if (holder.held && holder.subcommand === 'migrate') {
        throw graduationInProgressError({ runId: state.marker!.runId, state: state.marker!.state, where: 'source' });
      }
    }
    return;
  }
  if (!state.marker || PRE_CUTOVER_STATES.has(state.marker.state)) return;
  throw graduationInterruptedError({ runId: state.marker.runId, state: state.marker.state, detail: state.detail });
}

// ── held-lock move-aside ───────────────────────────────────────────────────

/**
 * Step 7: rename the data dir to `<dataDir>.graduated-<run_id>` under the
 * already-held kernel lock (no release, no gap) and retarget the lock
 * metadata into the moved dir. Returns the moved path.
 */
export function moveAsideHeld(dataDir: string, lock: LockHandle, runId: string): string {
  const movedTo = graduatedPath(dataDir, runId);
  moveHeldPglite(graduationDataDir(dataDir), movedTo, lock);
  return movedTo;
}

// ── refusals ───────────────────────────────────────────────────────────────

const STATUS_ARGV = ['gbrain', 'migrate', '--status', '--json'];

/** opError for a graduation code. The registry rows are added with the error-code batch. */
export function graduationError(code: GraduationErrorCode, message: string, suggestion: string, why: string, fix: Action, detail?: string): OperationError {
  return opError(code as RegistryCode, message, suggestion, { why, fix: { docs: fix.docs ?? `${MOVE_TO_POSTGRES_DOC}#${code.replace(/_/g, '-')}`, ...fix }, ...(detail ? { detail } : {}) });
}

export function graduationInProgressError(ctx: { runId: string; state: ManifestState | TargetRowState; where: 'source' | 'target' }): OperationError {
  const where = ctx.where === 'source'
    ? 'This PGLite datastore is being moved to Postgres by another gbrain process'
    : 'This Postgres database is the target of a gbrain engine graduation that has not granted it authority';
  return graduationError('graduation_in_progress', `${where} (run ${ctx.runId}, state ${ctx.state}).`,
    'Wait for the graduation run to finish, then retry the same command; `gbrain migrate --status --json` shows its progress.',
    'Exactly one engine accepts writes at a time during a graduation; this one is fenced until the run finishes or rolls back.',
    { argv: STATUS_ARGV, consent: [], actor: 'provider', requires_exclusive: false,
      why: 'Shows the graduation run state; retry the original command once it reports graduated, rolled_back or abandoned.',
      verify: { argv: STATUS_ARGV } });
}

export function graduationInterruptedError(ctx: { runId: string; state: ManifestState | TargetRowState; detail: string }): OperationError {
  return graduationError('graduation_interrupted', `Engine graduation run ${ctx.runId} stopped at ${ctx.state}. ${ctx.detail}`,
    'Run `gbrain migrate --resume` on the host that started the move; it continues from the first incomplete step using the recorded identities. `gbrain migrate --rollback-to-source` is the alternative.',
    'The run fenced this datastore before it stopped, so neither engine may be written until the run is resumed or rolled back.',
    { argv: ['gbrain', 'migrate', '--resume'], consent: [], actor: 'agent', requires_exclusive: true,
      why: 'Continues the interrupted graduation from its recorded state and ends with exactly one authoritative engine.',
      verify: { argv: STATUS_ARGV } });
}

export function engineGraduatedError(tombstone: Tombstone, opts: { onRunHost?: boolean } = {}): OperationError {
  const message = `This PGLite datastore moved to Postgres at ${tombstone.targetDisplayUrl} (run ${tombstone.runId}, ${tombstone.graduatedAt}); the original is retained at ${tombstone.movedTo}.`;
  if (opts.onRunHost) {
    return graduationError('engine_graduated', message,
      'Run `gbrain migrate --resume` to finish pointing this machine at the new engine.',
      'The datastore was moved aside and replaced by a tombstone; only the Postgres target accepts writes.',
      { argv: ['gbrain', 'migrate', '--resume'], consent: [], actor: 'agent', requires_exclusive: true,
        why: 'Finishes the routing flip and registry rewrites recorded in the graduation manifest.', verify: { argv: ['gbrain', 'doctor', '--no-migrate', '--json'] } });
  }
  return graduationError('engine_graduated', message,
    `Point this client at the new engine: \`gbrain config set database_url "$GBRAIN_TARGET_URL"\` with GBRAIN_TARGET_URL holding the Postgres URL for ${tombstone.targetDisplayUrl}. Rolling back is \`gbrain migrate --rollback-to-source\` on the host that ran the move and drops writes made since.`,
    'The datastore was moved aside and replaced by a tombstone; only the Postgres target accepts writes.',
    { argv: ['gbrain', 'config', 'set', 'database_url', '<GBRAIN_TARGET_URL>'], consent: ['credentials'], actor: 'user', requires_exclusive: false,
      inputs: [{ name: 'GBRAIN_TARGET_URL', how: `The Postgres connection URL for ${tombstone.targetDisplayUrl}; the user or the brain host's operator supplies it.` }],
      why: 'Points this client at the Postgres engine that now holds the brain.',
      user_message: `This brain moved to Postgres at ${tombstone.targetDisplayUrl}. Please run \`gbrain config set database_url "$GBRAIN_TARGET_URL"\` with that database's URL.`,
      verify: { argv: ['gbrain', 'doctor', '--no-migrate', '--json'] } });
}

export function graduationSplitBrainError(state: Pick<GraduationPathState, 'dataDir' | 'movedTo' | 'marker' | 'detail'>, counts?: string): OperationError {
  const runId = state.marker?.runId ?? 'unknown';
  const stray = state.dataDir;
  return graduationError('graduation_split_brain',
    `Two datastores claim this brain: a stray one at ${stray} and graduation run ${runId}'s original at ${state.movedTo ?? 'unknown'}. ${state.detail}${counts ? ` ${counts}` : ''}`,
    'Ask the user which copy to keep. To continue the move, move the stray datastore aside (the command in fix) and run `gbrain migrate --resume`; to keep PGLite, move it aside and run `gbrain migrate --rollback-to-source`.',
    'A process created a new datastore at the old path after the original was moved aside; the target is withheld from authority until one copy is chosen.',
    { argv: ['mv', stray, `${stray}.stray-${runId}`], consent: ['destructive'], actor: 'agent', requires_exclusive: true,
      why: 'Moves the stray datastore out of the way without deleting it, so the graduation can finish or roll back.',
      user_message: `Two copies of this brain exist: a stray one at ${stray} and the original at ${state.movedTo ?? 'unknown'}. Should I move the stray copy aside and continue?`,
      then: { argv: ['gbrain', 'migrate', '--resume'], consent: [], actor: 'agent', requires_exclusive: true, why: 'Continues the graduation once the stray datastore is out of the way.' },
      verify: { argv: STATUS_ARGV } });
}

/** Display form of a target identity: never the password. */
export function targetDisplayUrl(target: TargetIdentity): string {
  return `postgres://${encodeURIComponent(target.user)}@${target.host}:${target.port}/${encodeURIComponent(target.database)}`;
}

// ── database connect and admission checks ──────────────────────────────────

function exemptRun(runId: string, env: NodeJS.ProcessEnv): boolean {
  return env.GBRAIN_GRADUATION_RUN === runId || isGraduationRunInProcess(runId);
}

/**
 * Connect-path check for any engine: a target that is not yet (or no longer)
 * authoritative refuses every connect except the graduation run's own
 * (in-process, or `GBRAIN_GRADUATION_RUN` naming the row's run); a source that
 * recorded `cutover` refuses with `engine_graduated` once its tombstone exists,
 * otherwise `graduation_interrupted`.
 */
export async function assertGraduationConnectAllowed(engine: BrainEngine, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const row = await readGraduationRow(engine);
  if (!row || exemptRun(row.run_id, env)) return;
  if (row.role === 'target') {
    if (row.state === 'authoritative') return;
    throw graduationInProgressError({ runId: row.run_id, state: row.state, where: 'target' });
  }
  if (row.state !== 'cutover') return;
  const tombstone = row.source_data_dir ? readTombstone(row.source_data_dir) : null;
  if (tombstone) throw engineGraduatedError(tombstone);
  throw graduationInterruptedError({ runId: row.run_id, state: 'cutover', detail: 'The source recorded cutover but its datastore was not moved aside yet.' });
}

/**
 * Writer-admission check (`admitWrite*`): the same rules inside the admitting
 * transaction, where the run's identity is the `gbrain.graduation_run` setting
 * (the verify-step replay probe sets it).
 */
export async function assertGraduationAdmission(tx: BrainEngine): Promise<void> {
  if (!await graduationTablePresent(tx)) return;
  const [row] = await tx.executeRaw<{ role: string; run_id: string; state: string; source_data_dir: string | null; run: string | null }>(
    `SELECT role, run_id::text AS run_id, state, source_data_dir, NULLIF(current_setting('${GRADUATION_RUN_SETTING}', true), '') AS run
     FROM persistence_graduation WHERE singleton = 1`);
  if (!row || row.run === row.run_id) return;
  if (row.role === 'target') {
    if (row.state === 'authoritative') return;
    throw graduationInProgressError({ runId: row.run_id, state: row.state as TargetRowState, where: 'target' });
  }
  if (row.state !== 'cutover') return;
  const tombstone = row.source_data_dir ? readTombstone(row.source_data_dir) : null;
  if (tombstone) throw engineGraduatedError(tombstone);
  throw graduationInterruptedError({ runId: row.run_id, state: 'cutover', detail: 'The source recorded cutover; writes here are refused.' });
}
