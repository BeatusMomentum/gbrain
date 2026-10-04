import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { OperationError } from '../ops/contract.ts';
import { PersistenceConsumer, type PrepareMutation } from './consumer.ts';
import { preparePageMutation } from './page-prepare.ts';
import { prepareSemanticPageMutation } from './semantic-pages.ts';
import { getWriteRequestById, receiptFor } from './journal.ts';
import { isTerminal, type WriteRequest } from './model.ts';
import { isWriteErrorCode, type WriteReceipt } from './types.ts';
import { registerPgliteReopen } from '../pglite-lifecycle.ts';
import { assertMutationProtocol } from './protocol.ts';
import { pendingWriteHint } from './health.ts';
import { receiptDeliveredHint } from './connector-errors.ts';
import { contentRefusalFromReceipt } from '../import-screen.ts';
import { heldFileDiagnostic } from './verb-errors.ts';
import { isMissingPageMessage } from './page-identity.ts';

interface Service {
  consumer: PersistenceConsumer; stopping: boolean; unregisterStop?: () => void; unregisterReopen?: () => void;
  /** Waiters keyed by request row id; the consumer settles them in-process the moment it finishes a request. */
  settled: Map<string, Set<() => void>>;
  /** Recent claim-to-settle durations (ms), newest last, for pending retry_after_ms estimates. */
  publishMs: number[];
}
const services = new WeakMap<BrainEngine, Service>();
const receiptReads = new WeakMap<BrainEngine, Map<string, { read: Promise<WriteRequest | null>; abort: AbortController }>>();
/** Cross-process commits (another owner) are not signalled; waiters re-read at this cadence. */
const WAIT_FALLBACK_POLL_MS = 250;
const PUBLISH_SAMPLES = 20;
const preparers = new Map<string, { prepare: PrepareMutation; target: 'page' | 'skill_bundle' }>();
export function registerMutationPreparer(operation: string, prepare: PrepareMutation, target: 'page' | 'skill_bundle' = 'page'): void {
  preparers.set(operation, { prepare, target });
}
export async function preparePersistedMutation(e: BrainEngine, row: WriteRequest, cfg: GBrainConfig, signal?: AbortSignal) {
  assertMutationProtocol(row);
  const registered = preparers.get(row.operation);
  if (registered) {
    if (registered.target !== (row.target_kind ?? 'page')) throw new OperationError('unsupported_mutation_protocol', 'The registered preparer does not support this mutation target.', `Request ${row.request_id} (${row.operation}) was accepted by a gbrain version whose preparer this one lacks, so it has not run. Run gbrain upgrade on every host that serves this brain; the request stays journaled and resumes after the upgrade.`);
    return registered.prepare(e, row, cfg, signal);
  }
  if (row.target_kind === 'skill_bundle') {
    if (['put_skill', 'delete_skill'].includes(row.operation)) return (await import('../shared-skills/publication.ts')).prepareSharedSkillMutation(e, row, cfg);
    throw new OperationError('unsupported_mutation_protocol', 'No compatible skill mutation preparer is registered.', `Request ${row.request_id} (${row.operation}) was accepted by a gbrain version whose preparer this one lacks, so it has not run. Run gbrain upgrade on every host that serves this brain; the request stays journaled and resumes after the upgrade.`);
  }
  if (row.operation === 'submit_job' && String(row.intent?.kind).startsWith('managed_atom_')) return (await import('./atom-maintenance.ts')).prepareManagedAtomMutation(e, row, cfg);
  if (row.operation === 'extract_facts' && String(row.intent?.kind).startsWith('managed_facts_')) return (await import('./facts-prepare.ts')).prepareManagedFactsMutation(e, row, cfg);
  if (row.operation === 'submit_job' && String(row.intent?.kind).startsWith('connector_v2_')) return (await import('./connector-sync.ts')).prepareConnectorMutation(e, row);
  if (row.operation === 'submit_job' && String(row.intent?.kind).startsWith('managed_connector_')) return (await import('./connector-sync.ts')).prepareOutdatedConnectorMutation(e, row);
  if (row.operation === 'put_page' && row.intent?.kind === 'canonical_reconcile') return (await import('./reconcile-prepare.ts')).prepareReconcileMutation(e, row, cfg);
  if (row.operation === 'put_page' && row.intent?.kind === 'managed_grandfather') return (await import('./grandfather.ts')).prepareGrandfatherMutation(e, row);
  if (row.operation === 'submit_job' && row.intent?.kind === 'code_projection_reindex') return (await import('./projection-reindex.ts')).prepareCodeReindex(e, row);
  if (row.operation === 'submit_job' && String(row.intent?.kind).startsWith('managed_sync_')) return (await import('./sync-prepare.ts')).prepareManagedSyncMutation(e, row, cfg);
  if (row.operation === 'submit_job' && String(row.intent?.kind).startsWith('managed_maintenance_')) return (await import('./prepared-maintenance.ts')).prepareMaintenanceMutation(e, row, cfg);
  if (row.operation === 'put_page' && row.intent?.kind === 'managed_file_import') return (await import('./import-prepare.ts')).prepareManagedImportMutation(e, row, cfg);
  if (row.operation === 'put_page' && row.intent?.kind === 'managed_file_repair') return (await import('./file-repair.ts')).prepareManagedFileRepairMutation(e, row, cfg);
  if (row.operation === 'remember') return (await import('./memory-mutations.ts')).prepareMemoryMutation(e, row, cfg, signal);
  if (row.operation === 'loops_close' && row.intent?.kind === 'retire_loop_fact') return (await import('./loop-fact-retirement.ts')).prepareLoopFactRetirement(e, row, cfg);
  if (row.operation === 'decide_proposal') return (await import('../facts/proposal-supersede.ts')).prepareProposalMutation(e, row, cfg);
  if (row.operation === 'relink_facts') return (await import('../facts/relink-publish.ts')).prepareRelinkMutation(e, row, cfg);
  if (['takes_add','takes_update','takes_supersede','takes_resolve'].includes(row.operation)) return (await import('./takes-prepare.ts')).prepareTakesMutation(e,row,cfg);
  if (['add_tag','remove_tag','add_timeline_entry'].includes(row.operation)) return prepareSemanticPageMutation(e, row, cfg);
  if (['put_page','capture','delete_page','restore_page','revert_version','edit_page'].includes(row.operation)) return preparePageMutation(e, row, cfg, undefined, signal);
  throw new OperationError('unsupported_mutation_protocol', 'No compatible mutation preparer is registered for this operation.', `Request ${row.request_id} (${row.operation}) was accepted by a gbrain version whose preparer this one lacks, so it has not run. Run gbrain upgrade on every host that serves this brain; the request stays journaled and resumes after the upgrade.`);
}
export function startPersistenceConsumer(engine: BrainEngine, config: GBrainConfig): PersistenceConsumer {
  const prior = services.get(engine);
  if (prior) {
    if (prior.stopping) {
      throw new OperationError('unavailable', 'The persistence owner is closing.',
        'The persistence owner in this process is shutting down; start the command again after it exits. Accepted writes stay journaled and resume on the next owner.');
    }
    return prior.consumer;
  }
  const settled = new Map<string, Set<() => void>>();
  const publishMs: number[] = [];
  const consumer = new PersistenceConsumer(engine, config, preparePersistedMutation, {
    onSettled: (id, elapsedMs) => {
      publishMs.push(elapsedMs);
      if (publishMs.length > PUBLISH_SAMPLES) publishMs.shift();
      for (const wake of settled.get(id) ?? []) wake();
    },
  });
  const service: Service = { consumer, stopping: false, settled, publishMs };
  services.set(engine, service);
  const lifecycle = engine as BrainEngine & { registerBeforeDisconnect?: (run: () => Promise<void>) => unknown };
  const unregister = lifecycle.registerBeforeDisconnect?.(() => stopPersistenceConsumer(engine));
  if (typeof unregister === 'function') service.unregisterStop = unregister;
  if (engine.kind === 'pglite') service.unregisterReopen = registerPgliteReopen(engine, sameDatastore => {
    if (services.get(engine) !== service || !service.stopping) return;
    discardStoppedService(engine, service);
    // An explicit switch to another datastore must not inherit the old brain's config.
    if (sameDatastore) startPersistenceConsumer(engine, config);
  });
  consumer.start();
  return consumer;
}
export async function stopPersistenceConsumer(engine: BrainEngine): Promise<void> {
  const service = services.get(engine);
  if (!service) return;
  service.stopping = true;
  for (const listeners of service.settled.values()) for (const wake of listeners) wake();
  const pending = [...(receiptReads.get(engine)?.values() ?? [])];
  for (const entry of pending) entry.abort.abort();
  await service.consumer.stop();
  await Promise.all(pending.map(entry => entry.read));
}
/** Reset fixtures and drained lifecycle owners may discard a stopped service. */
export async function disposePersistenceConsumer(engine: BrainEngine): Promise<void> {
  const service = services.get(engine);
  await stopPersistenceConsumer(engine);
  if (service && services.get(engine) === service) discardStoppedService(engine, service);
}
function discardStoppedService(engine: BrainEngine, service: Service): void {
  service.unregisterStop?.(); service.unregisterReopen?.(); services.delete(engine);
}
export function foregroundWriteCompletions(engine: BrainEngine, worktreeId: string): number {
  return services.get(engine)?.consumer.foregroundCompletions(worktreeId) ?? 0;
}
export function persistenceConsumerStatus(engine: BrainEngine) {
  const service = services.get(engine);
  return service ? { state: service.stopping ? 'closing' : 'open', ...service.consumer.status() }
    : { state: 'not_running', accepting: false, active_preparations: 0, active_worktrees: 0 };
}
export function assertPersistenceAccepting(engine: BrainEngine): void {
  if (services.get(engine)?.stopping) {
    throw new OperationError('unavailable', 'The persistence owner is closing. Retry the same request_id after restart.',
      'Nothing new was accepted. After the owner restarts, resubmit with the same request_id so a write that was already accepted is never applied twice.');
  }
}
/**
 * The waiter never owns a provider, database connection, or kernel lock.
 * #6007: between receipt reads it sleeps until the in-process consumer settles
 * this request (or a short fallback for commits made by another process),
 * instead of re-reading every 50 ms for the whole wait.
 */
export async function waitForWrite(engine: BrainEngine, row: WriteRequest, config: GBrainConfig, waitMs = 5000): Promise<WriteRequest> {
  if (isTerminal(row)) return row;
  // The admission transaction has committed: publish now, not after the idle backoff.
  startPersistenceConsumer(engine, config).wake();
  const service = services.get(engine)!;
  let reads = receiptReads.get(engine);
  if (!reads) { reads = new Map(); receiptReads.set(engine, reads); }
  const deadline = performance.now() + waitMs;
  let signalled = false;
  let wake: (() => void) | undefined;
  const listener = () => { signalled = true; wake?.(); };
  let listeners = service.settled.get(row.id);
  if (!listeners) { listeners = new Set(); service.settled.set(row.id, listeners); }
  listeners.add(listener);
  let pause = 50;
  try {
    while (!service.stopping && performance.now() < deadline) {
      // The first pause is a plain 50 ms, as before: a commit that lands inside it
      // returns with its first effects already running, like it always has.
      if (pause === 50) await new Promise(resolve => setTimeout(resolve, Math.min(pause, Math.max(1, deadline - performance.now()))));
      else if (!signalled) {
        let sleeper: ReturnType<typeof setTimeout> | undefined;
        await new Promise<void>(resolve => { wake = resolve; sleeper = setTimeout(resolve, Math.min(pause, Math.max(1, deadline - performance.now()))); })
          .finally(() => { wake = undefined; if (sleeper) clearTimeout(sleeper); });
      }
      signalled = false;
      pause = WAIT_FALLBACK_POLL_MS;
      const remaining = deadline - performance.now();
      if (service.stopping || remaining <= 0) break;
      let pending = reads.get(row.id);
      const ownsRead = !pending;
      if (!pending) {
        if (reads.size >= 4) continue;
        const abort = new AbortController();
        const id = row.id;
        const read = getWriteRequestById(engine, row.id, engine.kind === 'postgres' ? abort.signal : undefined)
          .catch(() => null).finally(() => { if (reads.get(id)?.read === read) reads.delete(id); });
        pending = { read, abort };
        reads.set(id, pending);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const found = await Promise.race([
        pending.read,
        new Promise<null>(resolve => { timer = setTimeout(() => { if (ownsRead) pending.abort.abort(); resolve(null); }, remaining); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (found) row = found;
      if (isTerminal(row)) return row;
    }
    return row;
  } finally {
    listeners.delete(listener);
    if (!listeners.size && service.settled.get(row.id) === listeners) service.settled.delete(row.id);
  }
}
/**
 * #6007: wait for several admitted writes against one deadline. Requests of
 * one source publish oldest first, so waiting on each in order costs one
 * waiter at a time; rows not reached by the deadline keep their last state.
 */
export async function waitForWrites(engine: BrainEngine, rows: readonly WriteRequest[], config: GBrainConfig, waitMs = 5000): Promise<WriteRequest[]> {
  const deadline = performance.now() + waitMs;
  const settled: WriteRequest[] = [];
  for (const row of rows) settled.push(await waitForWrite(engine, row, config, Math.max(0, deadline - performance.now())));
  return settled;
}
/**
 * #6007: a pending receipt's retry_after_ms from this process's recent
 * publication times: `remaining` requests at the median duration, clamped to
 * 250 ms-30 s. Null when this process has not published anything yet.
 */
export function estimatedRetryAfterMs(engine: BrainEngine, remaining: number): number | null {
  const samples = [...(services.get(engine)?.publishMs ?? [])].sort((a, b) => a - b);
  if (!samples.length || remaining <= 0) return null;
  const median = samples[Math.floor(samples.length / 2)]!;
  return Math.round(Math.min(30_000, Math.max(250, median * remaining)));
}
/** B4: what a terminal receipt means for the caller, without guessing a mutation. */
function terminalReceiptHint(row: WriteRequest, reason: string): string {
  const what = `The ${row.operation ? `${row.operation} ` : ''}write (request_id ${row.request_id}) ended ${row.state} with ${reason}; it will not publish.`;
  return row.state === 'cancelled'
    ? `${what} Submit again only if the change is still wanted, with a new request_id.`
    : `${what} Read the receipt and the current state before deciding to submit again; a new attempt needs a new request_id.`;
}
export function writeResponse(row: WriteRequest, hints: { retryAfterMs?: number | null } = {}): Record<string, unknown> {
  const receipt = receiptFor(row);
  // #6007: an in-process estimate beats the fixed fallback, never an owner-inspection hold.
  if (!isTerminal(row) && hints.retryAfterMs != null && receipt.diagnostic?.next_action !== 'inspect_owner') receipt.retry_after_ms = hints.retryAfterMs;
  if (row.state === 'committed') return { ...receipt, write_request: receipt };
  const reason = !isTerminal(row) ? 'write_pending' : row.error_code ?? (row.state === 'cancelled' ? 'cancelled' : 'storage_error');
  const delivered = isTerminal(row) ? receiptDeliveredHint(row) : null;
  // #5988: a content refusal reports its typed code, reason, key and line, and the content fix.
  const content = isTerminal(row) ? contentRefusalFromReceipt(row.error_code, row.error_message) : null;
  // The page's file is held by sync: name the repair, so the caller does not retry into the same refusal.
  const held = isTerminal(row) && reason === 'source_changed' ? heldFileDiagnostic(row.error_message, row.source_id) : null;
  const error = new OperationError(reason, !isTerminal(row) ? 'The write is accepted and is still pending.'
    : row.error_message ?? 'The write did not commit.', !isTerminal(row)
      ? pendingWriteHint(receipt, row.operation)
      : delivered?.suggestion ?? content?.suggestion ?? held?.suggestion ?? terminalReceiptHint(row, reason), delivered?.docs);
  if (delivered?.detail ?? held?.reason) error.detail = delivered?.detail ?? held?.reason;
  if (content) {
    if (content.code !== reason) error.canonical = content.code;
    if (content.reason) error.reason = content.reason;
    if (content.key || content.line !== undefined) error.detail = [content.key ? `key ${content.key}` : '', content.line !== undefined ? `line ${content.line}` : ''].filter(Boolean).join(', ');
  }
  if (reason === 'page_identity_changed' && isMissingPageMessage(row.error_message)) error.canonical = 'page_not_found';
  error.receiptFields = { operation: row.operation, source_id: row.source_id, slug: row.slug || null, principal_kind: row.principal_kind, principal_id: row.principal_id };
  error.writeRequest = receipt as WriteReceipt;
  error.writeError = isWriteErrorCode(reason) ? reason : reason === 'page_identity_changed' ? 'source_changed' : 'storage_error';
  throw error;
}
