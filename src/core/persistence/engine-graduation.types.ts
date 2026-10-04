/**
 * Engine graduation (PGLite -> Postgres): the shared contract between the
 * inventory, copy, verify, custody and CLI modules. One state table drives
 * reconciliation and the unit tests; an illegal transition throws.
 *
 * Module map (one owner each):
 * - graduation-inventory.ts  GRADUATION_INVENTORY, relation guard, FK order
 * - graduation-verify.ts     canonical batch digests, verifyGraduation, replay probe
 * - graduation-copy.ts       table copier, trigger bypass, sequences, transforms
 * - graduation-drain.ts      request-only drain under the kernel lock
 * - graduation-target.ts     target routes, identity, probes, nonce cross-check
 * - graduation-custody.ts    intent marker, tombstone, lock-retaining close, move-aside
 * - graduation-schema.ts     persistence_graduation table and gbrain_graduation_fence triggers
 * - engine-graduation.ts     orchestrator: plan, run, status, resume, rollback, reconcile
 */
import type { BrainEngine } from '../engine.ts';

export const GRADUATION_MANIFEST_VERSION = 3 as const;

export const MANIFEST_STATES = [
  'planned', 'quiesced', 'draining', 'copying', 'verifying', 'verified', 'cutover', 'tombstoned',
  'authoritative', 'graduated', 'verify_failed', 'rollback_fenced', 'rollback_approved',
  'source_restoring', 'rolled_back', 'abandoned',
] as const;
export type ManifestState = typeof MANIFEST_STATES[number];

export const SOURCE_ROW_STATES = ['quiesced', 'cutover', 'rolled_back'] as const;
export type SourceRowState = typeof SOURCE_ROW_STATES[number];

export const TARGET_ROW_STATES = [
  'copying', 'verifying', 'verified', 'authoritative', 'verify_failed',
  'rollback_fenced', 'rollback_approved', 'source_restoring', 'rolled_back', 'abandoned',
] as const;
export type TargetRowState = typeof TARGET_ROW_STATES[number];

export const MANIFEST_TRANSITIONS: Readonly<Record<ManifestState, readonly ManifestState[]>> = {
  planned: ['quiesced', 'abandoned'],
  quiesced: ['draining', 'abandoned'],
  draining: ['copying', 'abandoned'],
  copying: ['verifying', 'abandoned'],
  verifying: ['verified', 'verify_failed', 'abandoned'],
  verify_failed: ['copying', 'abandoned'],
  verified: ['cutover', 'abandoned'],
  cutover: ['tombstoned', 'rollback_fenced'],
  tombstoned: ['authoritative', 'rollback_fenced'],
  authoritative: ['graduated', 'rollback_fenced'],
  graduated: ['rollback_fenced'],
  rollback_fenced: ['rollback_approved', 'authoritative', 'graduated'],
  rollback_approved: ['source_restoring'],
  source_restoring: ['rolled_back'],
  rolled_back: [],
  abandoned: [],
};

export const TARGET_TRANSITIONS: Readonly<Record<TargetRowState, readonly TargetRowState[]>> = {
  copying: ['verifying', 'abandoned'],
  verifying: ['verified', 'verify_failed', 'abandoned'],
  verify_failed: ['copying', 'abandoned'],
  verified: ['authoritative', 'abandoned'],
  authoritative: ['rollback_fenced'],
  rollback_fenced: ['rollback_approved', 'authoritative'],
  rollback_approved: ['source_restoring'],
  source_restoring: ['rolled_back'],
  rolled_back: [],
  abandoned: ['copying'],
};

export const SOURCE_TRANSITIONS: Readonly<Record<SourceRowState, readonly SourceRowState[]>> = {
  quiesced: ['cutover', 'rolled_back'],
  cutover: ['rolled_back'],
  rolled_back: ['quiesced'],
};

export function assertTransition<S extends string>(table: Readonly<Record<S, readonly S[]>>, from: S, to: S): void {
  if (!table[from]?.includes(to)) throw new Error(`Illegal graduation transition ${from} -> ${to}`);
}

/** carry: verbatim, keys preserved. rebind: re-validated for this host. rebuild: regenerated. discard: transient. */
export type InventoryClass = 'carry' | 'rebind' | 'rebuild' | 'discard' | 'schema_owned';
/** Rollback loss classification of a table's post-cutover changes. */
export type LossKind = 'user_data' | 'operational' | 'security';

export interface ColumnTransform {
  column: string;
  /** Human-readable rule, also printed by --plan (e.g. "cleared", "active -> waiting"). */
  rule: string;
}

export interface InventoryEntry {
  relation: string;
  kind: 'table' | 'view';
  class: InventoryClass;
  engines: { pglite: boolean; postgres: boolean };
  lossKind: LossKind;
  /** The only differences verify tolerates between source snapshot and target. */
  transforms: readonly ColumnTransform[];
  reason: string;
}

export interface Inventory {
  version: number;
  entries: readonly InventoryEntry[];
}

export interface TargetIdentity {
  /** sha256 over [host, port, database, user]; never the password. */
  id: string;
  host: string;
  port: number;
  database: string;
  user: string;
}

export interface TargetRoutes {
  /** Redacted for display; the 0600 manifest stores the full URLs. */
  main: string;
  ddl: string;
  /** Name of the env var the URL came from when --url-env was used. */
  urlEnv?: string;
}

export interface SourceIdentity {
  dataDir: string;
  brainId: string;
  hostId: string;
}

export interface BatchDigest {
  /** Last primary key of the batch, rendered as canonical text. */
  lastKey: string;
  rows: number;
  sha256: string;
}

export interface TableReceipt {
  relation: string;
  rows: number;
  rootSha256: string;
  batches: readonly BatchDigest[];
}

export type TriggerBypass = 'session_replication_role' | 'disable_trigger';

export interface TableCheckpoint {
  relation: string;
  state: 'pending' | 'copying' | 'copied' | 'verified';
  /** Batches copied so far; a table whose state is not 'copied' is re-copied with its FK closure. */
  batches: number;
  disabledTriggers: boolean;
}

export interface GraduationManifest {
  version: typeof GRADUATION_MANIFEST_VERSION;
  runId: string;
  state: ManifestState;
  source: SourceIdentity;
  target: TargetIdentity;
  routes: TargetRoutes;
  inventoryVersion: number;
  schemaVersion: number;
  planHash: string;
  triggerBypass: TriggerBypass;
  tables: readonly TableCheckpoint[];
  /** persistence_requests.sequence high-water mark at cutover. */
  cutoverSequence?: string;
  timings: Record<string, number>;
  startedAt: string;
  updatedAt: string;
}

/** Sibling intent marker `<dataDir>.gbrain-graduation.json` (mode 0600). */
export interface IntentMarker {
  runId: string;
  state: ManifestState;
  pid: number;
  bootId: string | null;
  pidNs: string | null;
  processStart: string | null;
  target: TargetIdentity;
  updatedAt: string;
}

/** Regular file at the old data dir path (mode 0600) once the dir is moved aside. */
export interface Tombstone {
  kind: 'gbrain-engine-graduated';
  runId: string;
  brainId: string;
  movedTo: string;
  target: TargetIdentity;
  targetDisplayUrl: string;
  graduatedAt: string;
  fixArgv: readonly string[];
}

export interface GraduationBlocker {
  kind: 'request' | 'topology_recovery' | 'writer_admin_lock' | 'effect_recovery' | 'foreign_host_binding'
    | 'writer_held' | 'env_override' | 'embedding_dimension' | 'unclassified_relation' | 'target_not_empty'
    | 'target_unsupported' | 'unsupported_platform' | 'source_doctor';
  id: string;
  detail: string;
  /** Exact command or MCP call that clears it, with real values filled in. */
  argv?: readonly string[];
  needsUser: boolean;
}

export interface TablePlanRow {
  relation: string;
  class: InventoryClass;
  rows: number;
  bytes: number;
}

export interface GraduationPlan {
  planHash: string;
  source: SourceIdentity;
  target: TargetIdentity;
  routes: TargetRoutes;
  triggerBypass: TriggerBypass | null;
  tables: readonly TablePlanRow[];
  blockers: readonly GraduationBlocker[];
  estimateSeconds: { copy: number; verify: number; doctor: number; total: number };
  /** "measured at run start" when a live serve holds the source. */
  sourceMeasured: 'now' | 'at_run_start';
  nextArgv: readonly string[];
}

export type ReplayProbeResult =
  | { status: 'passed'; requestId: string }
  | { status: 'not_available'; reason: 'no_caller_input' | 'archived_source' | 'revoked_principal' | 'no_uncompacted_request' }
  | { status: 'failed'; requestId: string; detail: string };

export interface VerifyFailure {
  relation: string;
  kind: 'count' | 'digest' | 'sequence' | 'fk' | 'trigger' | 'relation_set' | 'replay' | 'doctor';
  firstKey?: string;
  column?: string;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  tables: readonly TableReceipt[];
  failures: readonly VerifyFailure[];
  replay: ReplayProbeResult;
  doctorFailingChecks: readonly string[];
}

/** Stored on the target persistence_graduation row and printed by --status/--json. */
export interface GraduationReceipt {
  runId: string;
  state: TargetRowState;
  tables: readonly TableReceipt[];
  triggerBypass: TriggerBypass;
  replay: ReplayProbeResult;
  timings: Record<string, number>;
}

export interface GraduationEngines {
  source: BrainEngine;
  target: BrainEngine;
}

/** Codes this feature adds to the error registry (one batch to the agent-contract owner). */
export const GRADUATION_ERROR_CODES = [
  'graduation_source_writer_held',
  'graduation_unclassified_table',
  'graduation_embedding_dimension_mismatch',
  'graduation_drain_timeout',
  'graduation_target_not_empty',
  'graduation_foreign_host_binding',
  'graduation_verify_failed',
  'graduation_interrupted',
  'graduation_in_progress',
  'graduation_split_brain',
  'graduation_rollback_writes_lost',
  'graduation_target_auth_failed',
  'graduation_target_ddl_unreachable',
  'graduation_target_unsupported',
  'graduation_unsupported_platform',
  'engine_graduated',
] as const;
export type GraduationErrorCode = typeof GRADUATION_ERROR_CODES[number];

/**
 * Custody boundaries, in run order, that the orchestrator announces with
 * `graduationBoundary(name)` right after the step's durable write commits.
 * The crash suite (test/e2e/graduation-crash.test.ts) SIGKILLs the real CLI
 * at each one, and the zero-mutation suite pauses there to poll --status.
 * `table_copied` fires after each table's copy transaction commits and
 * `batch_copied` after each committed batch inside a table, both with
 * `detail.relation`.
 */
export const GRADUATION_RUN_BOUNDARIES = [
  'quiesced', 'drain_started', 'drained', 'target_fenced', 'batch_copied', 'table_copied', 'copied', 'verified',
  'source_cutover', 'source_closed', 'moved_aside', 'tombstoned', 'authoritative', 'config_flipped', 'registry_rewritten', 'graduated',
] as const;
/** Rollback substeps after cutover, in order (§13 rollback custody). */
export const GRADUATION_ROLLBACK_BOUNDARIES = [
  'rollback_fenced', 'rollback_approved', 'source_restoring', 'tombstone_removed', 'renamed_back', 'config_restored', 'rolled_back',
] as const;
export type GraduationBoundary = typeof GRADUATION_RUN_BOUNDARIES[number] | typeof GRADUATION_ROLLBACK_BOUNDARIES[number];
export interface GraduationBoundaryDetail { runId?: string; relation?: string; batch?: number }
export interface GraduationHooks {
  boundary?(name: GraduationBoundary, detail: GraduationBoundaryDetail): Promise<void> | void;
}
/**
 * Test-only registration point: a crash-test preload (test/helpers/graduation-hooks-preload.ts)
 * stores hooks under this symbol before the CLI starts. Production code never sets it.
 */
export const GRADUATION_HOOKS = Symbol.for('gbrain.graduation.hooks');

/** Announce a custody boundary; a no-op unless a test registered hooks. */
export async function graduationBoundary(name: GraduationBoundary, detail: GraduationBoundaryDetail = {}): Promise<void> {
  const hooks = (globalThis as Record<symbol, GraduationHooks | undefined>)[GRADUATION_HOOKS];
  await hooks?.boundary?.(name, detail);
}
