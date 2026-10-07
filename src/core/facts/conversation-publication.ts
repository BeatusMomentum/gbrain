/**
 * Receipted publication of one conversation page's derived facts on a managed
 * brain (wave 9 follow-ups, item 1).
 *
 * `gbrain extract-conversation-facts` replaces a page's
 * `cli:extract-conversation-facts*` rows with a fresh batch: the facts the
 * model extracted plus the page outcome (EXTRACTION_COMPLETE or
 * EXTRACTION_NOT_APPLICABLE). On a managed brain that batch is frozen into a
 * database-only `managed_maintenance_conversation_facts` request, so every
 * row change commits in the same transaction as its receipt.
 *
 * Generation identity. A request belongs to one logical extraction
 * generation, keyed by the intent protocol, the source incarnation, the page
 * id, its revision and parser-input version token (sidecar bytes included),
 * the extractor version (`CONVERSATION_EXTRACTOR_VERSION`), the selectors
 * (`--since`, `--segment-limit`) and the page's newest extractor row id (so
 * every committed batch, an approved repair or `--force` after a commit
 * starts the next generation). Request ids are `(generation, attempt)`
 * digests under the caller's principal, so:
 *   - a crash after admission replays the stored batch: the rerun finds the
 *     accepted request and waits for it, with zero model calls;
 *   - a retryable failure (lock, claim loss, owner change) resubmits the
 *     stored batch under the next attempt, still with zero model calls;
 *   - a deterministic failure (validation, authorization, size) blocks the
 *     generation: no model call until the page changes;
 *   - at most MAX_GENERATION_ATTEMPTS requests are admitted per generation.
 * A committed batch without an outcome row (a `--segment-limit` run that did
 * not reach the last segment) is not a completed page.
 *
 * Apply re-pins source, page slug, source prefix and visibility from the
 * request, rechecks authority, page identity, revision and version token,
 * the embedding signature and entity merges (a slug that became an alias
 * moves to its canonical page), allocates row numbers under the page lock,
 * and fails the request when an insert is lost.
 */
import type { BrainEngine, NewFact } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { Page } from '../types.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import type { FrozenExtractedFact } from '../persistence/facts-maintenance.ts';
import type { FactEmbeddingSignature } from './extract.ts';
import { ALL_FACT_KINDS } from '../engine.ts';
import { isTerminal } from '../persistence/model.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { authorizeStoredRequest, authorizeWrite } from '../persistence/authority.ts';
import { digest, jsonBytes } from '../persistence/digest.ts';
import { assertLifetimeIdHeadroom, getWriteRequest } from '../persistence/journal.ts';
import { readJournalLimits } from '../persistence/limits.ts';
import { principalKey } from '../persistence/model.ts';
import { PERSISTENCE_IPC_MAX_BYTES } from '../persistence/ipc.ts';
import { assertManagedFactsEmbedding, resolveManagedFactsEmbedding } from '../persistence/facts-maintenance.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { loadConfig } from '../config.ts';
import { waitForWrite, writeResponse } from '../persistence/service.ts';
import { catalogueError } from '../error-catalogue.ts';
import { CONVERSATION_EXTRACTOR_VERSION, NON_EXTRACTABLE_AUDIT_SOURCE, TERMINAL_AUDIT_SOURCE } from './audit-sources.ts';

export const CONVERSATION_FACTS_INTENT = 'managed_maintenance_conversation_facts';
export const CONVERSATION_FACTS_PROTOCOL = 1;
export const CONVERSATION_FACTS_SOURCE_PREFIX = 'cli:extract-conversation-facts';
export const MAX_GENERATION_ATTEMPTS = 3;
/** Admission stops once the principal's outstanding requests reach this share of `principalOutstanding`. */
export const OUTSTANDING_ADMISSION_SHARE = 0.8;
/** Facts per segment the extractor returns at most (extractFactsFromTurn's default maxFactsPerTurn). */
const MAX_FACTS_PER_SEGMENT = 10;
/** Upper bound for one frozen row without its vector: claim, context, provenance and JSON overhead. */
const ROW_BYTES = 4096;
/** One embedding dimension as JSON text ("-0.012345678901234567,"). */
const DIMENSION_BYTES = 24;

/** Request error codes that fail the same way on every retry of one generation. */
const DETERMINISTIC_CODES = new Set(['invalid_params', 'permission_denied', 'request_too_large', 'payload_too_large']);
/** Retryable codes whose stored batch is stale: the next attempt extracts again. */
const REEXTRACT_CODES = new Set(['embedding_configuration', 'revision_conflict', 'page_identity_changed', 'page_not_found']);
const OUTCOME_SOURCES = new Set([TERMINAL_AUDIT_SOURCE, NON_EXTRACTABLE_AUDIT_SOURCE]);

export type ConversationFactRow = NewFact & { row_num: number; source_markdown_slug: string };
/** A frozen row: no source, page or row number (the request pins them) and no visibility (one per batch). */
export type FrozenConversationFact = Omit<FrozenExtractedFact, 'visibility' | 'entity_inferred'>;

export interface ConversationFactsIntent extends Record<string, unknown> {
  kind: typeof CONVERSATION_FACTS_INTENT;
  protocol: number;
  expected_revision: string;
  page_id: number;
  version_token: string;
  extractor_version: number;
  generation: string;
  selectors: { since: string | null; segment_limit: number };
  /** True when the batch carries the page outcome (EXTRACTION_COMPLETE / EXTRACTION_NOT_APPLICABLE). */
  complete: boolean;
  /** The checkpoint end of the newest extracted segment, echoed in the receipt. */
  newest_end: string | null;
  visibility: 'private' | 'world';
  embedding: FactEmbeddingSignature | null;
  rows: FrozenConversationFact[];
}

export interface ConversationGenerationInput {
  slug: string;
  page: Page;
  versionToken: string;
  since: string | null;
  segmentLimit: number;
}

interface Generation { key: string; revision: string; pageId: number; input: ConversationGenerationInput }

export type GenerationStart =
  /** No admitted request for this generation yet (or a retry that must extract again): model work runs. */
  | { kind: 'extract'; generation: Generation; attempt: number }
  /** A retryable failure left a stored batch: resubmit it under `attempt`, with no model call. */
  | { kind: 'resubmit'; generation: Generation; attempt: number; intent: ConversationFactsIntent }
  /** An admitted request already settled (committed, or replayed after a crash): no model call. */
  | { kind: 'settled'; receipt: Record<string, unknown> }
  /** Still pending after the job's wait: unfinished, retried next run. */
  | { kind: 'pending'; requestId: string }
  /** A deterministic failure or the attempt cap: no model call until the page changes. */
  | { kind: 'blocked'; requestId: string; code: string; message: string };

function requestIdFor(generationKey: string, attempt: number): string {
  const h = digest([generationKey, attempt]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const receiptFix = (requestId: string) => readFix('Reads the conversation facts request\'s durable receipt: its state, outcome and recorded error, read-only.',
  { argv: ['gbrain', 'write-request', '--', requestId] });

/**
 * Before any model work for one page: resolve its generation and find what
 * this principal already admitted for it. Throws `revision_conflict` when the
 * page moved since the caller read it.
 */
export async function startConversationGeneration(engine: BrainEngine, authority: MaintenanceAuthority,
  config: GBrainConfig, input: ConversationGenerationInput): Promise<GenerationStart> {
  const sourceId = authority.writer.sourceId;
  const snapshot = await engine.readPageSnapshot(input.slug, { sourceId });
  if (!snapshot || snapshot.page.id !== input.page.id || snapshot.page.knowledge_revision !== input.page.knowledge_revision) {
    throw opError('revision_conflict', 'The conversation page changed before extraction started; nothing was submitted.',
      `Page ${input.slug} in source ${sourceId} changed or was replaced after it was read, so no model work ran for it. The next run extracts the current page.`);
  }
  const [base] = await engine.executeRaw<{ id: number | string | null }>(
    `SELECT max(id) AS id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND source LIKE '${CONVERSATION_FACTS_SOURCE_PREFIX}%'`,
    [sourceId, input.slug]);
  const key = digest(['conversation-facts', CONVERSATION_FACTS_PROTOCOL, authority.writer.sourceIncarnation, snapshot.page.id,
    snapshot.revision, input.versionToken, CONVERSATION_EXTRACTOR_VERSION, input.since, input.segmentLimit,
    base?.id == null ? null : Number(base.id)]);
  const generation: Generation = { key, revision: snapshot.revision, pageId: snapshot.page.id, input };
  let reuse: ConversationFactsIntent | null = null;
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
    const requestId = requestIdFor(key, attempt);
    const prior = await getWriteRequest(engine, authority.writer.principal, requestId);
    if (!prior) return reuse ? { kind: 'resubmit', generation, attempt, intent: reuse } : { kind: 'extract', generation, attempt };
    if (!isTerminal(prior)) {
      await authorizeStoredRequest(engine, prior);
      const wait = authority.wait!;
      const row = wait.observe(await waitForWrite(engine, prior, config, wait.ms()));
      if (!isTerminal(row)) return { kind: 'pending', requestId };
      if (row.state === 'committed') return { kind: 'settled', receipt: writeResponse(row) };
      reuse = null;
      if (!classifyFailure(row, attempt)) return blocked(row, requestId);
      if (!REEXTRACT_CODES.has(row.error_code ?? '')) reuse = storedIntent(row);
      continue;
    }
    if (prior.state === 'committed') return { kind: 'settled', receipt: writeResponse(prior) };
    if (!classifyFailure(prior, attempt)) return blocked(prior, requestId);
    reuse = REEXTRACT_CODES.has(prior.error_code ?? '') ? null : storedIntent(prior);
  }
  const last = requestIdFor(key, MAX_GENERATION_ATTEMPTS - 1);
  return { kind: 'blocked', requestId: last, code: 'attempts_exhausted',
    message: `${MAX_GENERATION_ATTEMPTS} requests for this page generation ended without committing; no model call runs again until the page changes. Read the last receipt: gbrain write-request -- ${last}` };
}

/** True when the failed request may be retried under the next attempt. */
function classifyFailure(row: WriteRequest, attempt: number): boolean {
  return attempt + 1 < MAX_GENERATION_ATTEMPTS && !DETERMINISTIC_CODES.has(row.error_code ?? '');
}

function blocked(row: WriteRequest, requestId: string): GenerationStart {
  const code = row.error_code ?? row.state;
  return { kind: 'blocked', requestId, code,
    message: `request ${requestId} ended ${row.state} (${code}) for this page generation, so no model call runs again until the page changes. Read the receipt: gbrain write-request -- ${requestId}` };
}

function storedIntent(row: WriteRequest): ConversationFactsIntent | null {
  const intent = row.intent as ConversationFactsIntent | null;
  return !row.compacted && intent?.kind === CONVERSATION_FACTS_INTENT && Array.isArray(intent.rows) ? intent : null;
}

/** The largest frozen batch `segments` segments can produce, in intent bytes. */
export function estimateConversationIntentBytes(segments: number, embedding: FactEmbeddingSignature | null): number {
  const perRow = ROW_BYTES + (embedding ? embedding.dimensions * DIMENSION_BYTES : 0);
  return 16_384 + (segments * MAX_FACTS_PER_SEGMENT + 1) * perRow;
}

/** The byte ceiling one conversation facts request may carry on this brain. */
export async function conversationIntentByteLimit(engine: BrainEngine): Promise<number> {
  const limits = await readJournalLimits(engine);
  return Math.min(limits.principalIntentBytes, limits.brainIntentBytes, PERSISTENCE_IPC_MAX_BYTES);
}

/**
 * Before a page's model work: stop the run once this principal's outstanding
 * requests reach OUTSTANDING_ADMISSION_SHARE of its limit, and refuse when
 * its permanent request ids cannot cover `needed` more admissions.
 */
export async function assertConversationAdmissionHeadroom(engine: BrainEngine, authority: MaintenanceAuthority, needed = 1): Promise<void> {
  const limits = await readJournalLimits(engine);
  const [counter] = await engine.executeRaw<{ outstanding_count: number | string }>(
    'SELECT outstanding_count FROM persistence_counters WHERE key=$1', [principalKey(authority.writer.principal)]);
  const outstanding = Number(counter?.outstanding_count ?? 0);
  const ceiling = Math.max(1, Math.floor(limits.principalOutstanding * OUTSTANDING_ADMISSION_SHARE));
  if (outstanding >= ceiling) {
    throw catalogueError('maintenance_backpressure',
      `Conversation fact extraction stopped admitting: ${outstanding} of this writer's ${limits.principalOutstanding} outstanding requests are still pending.`,
      `Let the pending requests settle (gbrain sources writer status --source ${authority.writer.sourceId} --json shows them; a resident gbrain serve or the next CLI run publishes them), then rerun the same command. Pages already published keep their facts.`);
  }
  await assertLifetimeIdHeadroom(engine, authority.writer.principal, needed);
}

function freezeRow(row: ConversationFactRow): FrozenConversationFact {
  return {
    fact: row.fact, kind: row.kind ?? 'fact', entity_slug: row.entity_slug ?? null, context: row.context ?? null,
    valid_from: (row.valid_from ?? new Date()).toISOString(), valid_until: row.valid_until ? row.valid_until.toISOString() : null,
    source: row.source, source_session: row.source_session ?? null, confidence: row.confidence ?? 1.0,
    notability: row.notability ?? 'medium', embedding: row.embedding ? Array.from(row.embedding) : null,
    embedding_model: row.embedding ? row.embedding_model ?? null : null,
    claim_metric: row.claim_metric ?? null, claim_value: row.claim_value ?? null, claim_unit: row.claim_unit ?? null,
    claim_period: row.claim_period ?? null, event_type: row.event_type ?? null, attributed_to: row.attributed_to ?? null,
  };
}

/** Builds the frozen intent for one generation attempt. */
export async function buildConversationIntent(engine: BrainEngine, config: GBrainConfig, start: { generation: Generation },
  rows: ConversationFactRow[], opts: { complete: boolean; newestEnd: string | null; visibility: 'private' | 'world' }): Promise<ConversationFactsIntent> {
  const { generation } = start;
  // Vectors freeze only under the brain's current facts embedding signature; any other
  // vector is dropped and its row is embedded later, as an unembedded fact is.
  const signature = rows.some(row => row.embedding) ? await resolveManagedFactsEmbedding(engine, config) : null;
  const keep = (row: ConversationFactRow) => !!signature && !!row.embedding && row.embedding.length === signature.dimensions
    && (!row.embedding_model || row.embedding_model === signature.model);
  return {
    kind: CONVERSATION_FACTS_INTENT, protocol: CONVERSATION_FACTS_PROTOCOL, expected_revision: generation.revision,
    page_id: generation.pageId, version_token: generation.input.versionToken, extractor_version: CONVERSATION_EXTRACTOR_VERSION,
    generation: generation.key, selectors: { since: generation.input.since, segment_limit: generation.input.segmentLimit },
    complete: opts.complete, newest_end: opts.newestEnd, visibility: opts.visibility,
    embedding: signature, rows: rows.map(row => freezeRow(keep(row) ? { ...row, embedding_model: signature!.model } : { ...row, embedding: null })),
  };
}

/**
 * Submits one generation attempt and returns its committed receipt. A
 * request still pending after the job's wait throws `write_pending`.
 */
export async function submitConversationIntent(engine: BrainEngine, authority: MaintenanceAuthority, slug: string,
  start: { generation: Generation; attempt: number }, intent: ConversationFactsIntent): Promise<Record<string, unknown>> {
  const limit = await conversationIntentByteLimit(engine);
  const bytes = jsonBytes(intent);
  if (bytes > limit) {
    throw opError('request_too_large', 'The page\'s frozen fact batch exceeds the request size limit; its prior facts were kept.',
      `Page ${slug} produced a ${bytes}-byte batch, over the ${limit}-byte limit for one request, so nothing was submitted and the batch was not split. Narrow the run with --segment-limit, or raise persistence.limits.principal_intent_bytes (the user's call).`);
  }
  return submitDatabaseMaintenanceIntent(engine, authority, slug, intent, requestIdFor(start.generation.key, start.attempt));
}

function invalid(row: WriteRequest, cause: string): OperationError {
  return opError('invalid_params', 'The conversation facts request is malformed.',
    `Request ${row.request_id} for ${row.slug} in source ${row.source_id} ${cause}, so nothing changed. Run gbrain extract-conversation-facts --source-id ${row.source_id} --slug ${row.slug} again; a new page generation submits a fresh batch.`,
    { fix: receiptFix(row.request_id) });
}

function validateIntent(row: WriteRequest): ConversationFactsIntent {
  const p = row.intent as ConversationFactsIntent | null;
  if (!p || p.kind !== CONVERSATION_FACTS_INTENT || p.protocol !== CONVERSATION_FACTS_PROTOCOL) throw invalid(row, 'carries a protocol this gbrain version does not publish (likely queued by another release)');
  if (!Array.isArray(p.rows) || typeof p.version_token !== 'string' || typeof p.generation !== 'string' || Number(p.page_id) !== Number(row.page_id)) {
    throw invalid(row, 'does not name its page, version and rows');
  }
  if (p.visibility !== 'private' && p.visibility !== 'world') throw invalid(row, 'names an unknown fact visibility');
  const outcomes = p.rows.filter(fact => OUTCOME_SOURCES.has(fact.source));
  if (outcomes.length !== (p.complete ? 1 : 0)) throw invalid(row, p.complete ? 'does not carry exactly one page outcome' : 'carries a page outcome in a partial batch');
  for (const fact of p.rows) {
    if (typeof fact.fact !== 'string' || !fact.fact.trim() || typeof fact.source !== 'string' || !fact.source.startsWith(CONVERSATION_FACTS_SOURCE_PREFIX)
      || !ALL_FACT_KINDS.includes((fact.kind ?? 'fact') as never) || (fact.source_session != null && !String(fact.source_session).startsWith(CONVERSATION_FACTS_SOURCE_PREFIX))
      || Number.isNaN(Date.parse(fact.valid_from)) || (fact.valid_until != null && Number.isNaN(Date.parse(fact.valid_until)))) {
      throw invalid(row, 'carries a row outside the conversation extractor\'s provenance');
    }
    if (OUTCOME_SOURCES.has(fact.source) && fact.source_session !== `${fact.source}:${row.slug}:${p.version_token}`) throw invalid(row, 'carries an outcome for another page version');
  }
  return p;
}

/** Canonical slugs for entity slugs that became aliases of a live page since extraction. */
async function mergedEntities(tx: BrainEngine, sourceId: string, slugs: string[]): Promise<Map<string, string>> {
  if (!slugs.length) return new Map();
  const rows = await tx.executeRaw<{ alias_slug: string; canonical_slug: string }>(`SELECT a.alias_slug, a.canonical_slug FROM slug_aliases a
    WHERE a.source_id=$1 AND a.alias_slug=ANY($2::text[])
      AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=a.source_id AND p.slug=a.alias_slug AND p.deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM pages c WHERE c.source_id=a.source_id AND c.slug=a.canonical_slug AND c.deleted_at IS NULL)`, [sourceId, [...new Set(slugs)]]);
  return new Map(rows.map(row => [row.alias_slug, row.canonical_slug]));
}

/**
 * The page's replacement under its lock: deletes the prior extractor rows
 * and inserts `rows` numbered above every remaining fact row of the page.
 * Shared by the managed apply and the unmanaged writer.
 */
export async function replaceConversationFacts(tx: BrainEngine, sourceId: string, slug: string,
  rows: Array<Omit<ConversationFactRow, 'row_num' | 'source_markdown_slug'>>): Promise<{ deleted: number; inserted: number }> {
  const deleted = await clearConversationFacts(tx, sourceId, slug);
  if (!rows.length) return { deleted, inserted: 0 };
  const [top] = await tx.executeRaw<{ n: number | string | null }>(
    'SELECT max(row_num) AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [sourceId, slug]);
  const start = top?.n == null ? 0 : Number(top.n) + 1;
  const { inserted } = await tx.insertFacts(rows.map((fact, i) => ({ ...fact, row_num: start + i, source_markdown_slug: slug })), { source_id: sourceId }); // gbrain-allow-direct-insert: a conversation page's derived fact batch replaced under its page lock (inside the receipted publication on a managed brain)
  if (inserted !== rows.length) {
    throw opError('storage_error', 'A conversation fact insert was lost; the page\'s prior facts were kept.',
      `Only ${inserted} of ${rows.length} fact rows of ${slug} in source ${sourceId} were inserted, so the replacement rolled back. Run the extraction for the page again; report this if it repeats.`);
  }
  return { deleted, inserted };
}

/** Context marker `gbrain repair conversation-labels` appends to the rows it retires. */
export const LABEL_RETIRED_MARKER = 'retired: conversation-labels';

/**
 * Clears a page's prior extractor batch before a replacement, keeping the
 * history other records depend on: a row an open loop (`open_loops.fact_id`,
 * no FK) or another fact's `superseded_by` references is expired, never
 * deleted, and rows `gbrain repair conversation-labels` retired stay expired.
 * Every other extractor row of the page is deleted. Returns the rows removed
 * from the active batch.
 */
export async function clearConversationFacts(db: BrainEngine, sourceId: string, slug: string): Promise<number> {
  const page = `f.source_id=$1 AND f.source_markdown_slug=$2 AND f.source LIKE '${CONVERSATION_FACTS_SOURCE_PREFIX}%'`;
  const referenced = 'EXISTS (SELECT 1 FROM open_loops o WHERE o.fact_id=f.id) OR EXISTS (SELECT 1 FROM facts g WHERE g.superseded_by=f.id)';
  const [expired] = await db.executeRaw<{ count: string }>(`WITH up AS (UPDATE facts f SET expired_at=now()
    WHERE ${page} AND f.expired_at IS NULL AND (${referenced}) RETURNING 1) SELECT COUNT(*)::text AS count FROM up`, [sourceId, slug]);
  const [deleted] = await db.executeRaw<{ count: string }>(`WITH del AS (DELETE FROM facts f
    WHERE ${page} AND NOT (${referenced}) AND COALESCE(f.context,'') NOT LIKE '%${LABEL_RETIRED_MARKER}%' RETURNING 1)
    SELECT COUNT(*)::text AS count FROM del`, [sourceId, slug]);
  return Number(expired?.count ?? 0) + Number(deleted?.count ?? 0);
}

/** Preparer for `managed_maintenance_conversation_facts`: a database-only publication on the page key. */
export async function prepareConversationFactsPublication(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const p = validateIntent(row);
  const { currentConversationVersionToken } = await import('../../commands/extract-conversation-facts.ts');
  const pageChanged = (message: string) => opError('page_identity_changed', message,
    `Page ${row.slug} in source ${row.source_id} changed before its conversation facts were published, so request ${row.request_id} wrote nothing and the prior facts stay. The next extraction run reads the current page.`,
    { fix: readFix(`Shows which page holds ${row.slug} now and its revision.`, { argv: ['gbrain', 'get', '--source', row.source_id, '--', row.slug] }) });
  const check = async (db: BrainEngine, lock: boolean) => {
    await authorizeWrite(db, row.authority, 'submit_job', row.slug);
    const page = await db.getPage(row.slug, { sourceId: row.source_id });
    if (!page || page.id !== Number(row.page_id)) throw pageChanged('The conversation page was deleted or replaced before its facts were published.');
    if (page.knowledge_revision !== p.expected_revision || await currentConversationVersionToken(db, page) !== p.version_token) {
      throw opError('revision_conflict', 'The conversation page changed during fact extraction; its prior facts were kept.',
        `Page ${row.slug} in source ${row.source_id} changed after its facts were extracted (request ${row.request_id}), so its prior facts were kept. The next extraction run extracts from the current page.`,
        { fix: receiptFix(row.request_id) });
    }
    if (p.rows.some(fact => fact.embedding)) {
      await assertManagedFactsEmbedding(db, config, p.embedding, lock);
      if (p.rows.some(fact => fact.embedding && (fact.embedding.length !== p.embedding!.dimensions || !fact.embedding.every(Number.isFinite)))) {
        throw opError('embedding_configuration', 'Frozen conversation fact vectors do not match their embedding signature.',
          `A vector in request ${row.request_id} is not a finite ${p.embedding!.dimensions}-dimension vector of ${p.embedding!.model}, so none of the page's facts were published. The next extraction run embeds under the current model.`,
          { fix: receiptFix(row.request_id) });
      }
    }
  };
  await check(engine, false);
  return { observedRevision: p.expected_revision, noop: true,
    validate: tx => check(tx, true),
    apply: async tx => {
      const merges = await mergedEntities(tx, row.source_id, p.rows.map(fact => fact.entity_slug).filter((s): s is string => !!s));
      const rows = p.rows.map(fact => ({
        ...fact, visibility: p.visibility, entity_slug: fact.entity_slug ? merges.get(fact.entity_slug) ?? fact.entity_slug : null,
        valid_from: new Date(fact.valid_from), valid_until: fact.valid_until ? new Date(fact.valid_until) : null,
        embedding: fact.embedding ? new Float32Array(fact.embedding) : null,
        embedding_model: fact.embedding ? p.embedding?.model ?? null : null,
      }));
      const { deleted, inserted } = await replaceConversationFacts(tx, row.source_id, row.slug, rows);
      const outcome = p.rows.find(fact => OUTCOME_SOURCES.has(fact.source));
      return { status: 'completed', deleted, inserted, facts_inserted: rows.filter(fact => !OUTCOME_SOURCES.has(fact.source)).length,
        complete: p.complete, page_outcome: outcome ? (outcome.source === TERMINAL_AUDIT_SOURCE ? 'complete' : 'non_extractable') : null,
        newest_end: p.newest_end, extractor_version: p.extractor_version, generation: p.generation, entities_merged: merges.size };
    } };
}

/** A managed extraction run's publication context; null on an unmanaged brain or a dry run. */
export interface ManagedConversationPublisher {
  engine: BrainEngine;
  authority: MaintenanceAuthority;
  config: GBrainConfig;
  /** The facts embedding signature frozen batches carry (null: no vectors). */
  embedding: FactEmbeddingSignature | null;
}

/** The run counters a managed page publication books into. */
export interface ManagedRunCounters {
  pages_processed: number; pages_marked_non_extractable: number; pages_skipped_too_large: number;
  orphan_facts_cleaned: number; facts_inserted: number; pages_pending?: number; pages_blocked?: number;
}

interface ManagedRunState {
  managed: ManagedConversationPublisher | null;
  segmentLimit: number;
  factVisibility: 'private' | 'world';
  result: ManagedRunCounters;
}

interface PageSnapshot { page: Page; versionToken: string }

/**
 * Once per run, before any model work: on a managed brain (not a dry run,
 * which writes and registers nothing) preflight the maintenance authority,
 * resolve the facts embedding signature and check that the planned
 * admissions fit the writer's request capacity.
 */
export async function managedConversationPublisher(engine: BrainEngine, sourceId: string,
  opts: { dryRun?: boolean; slugs?: string[]; slug?: string; limit?: number }): Promise<ManagedConversationPublisher | null> {
  if (opts.dryRun || !await managedPersistenceEnabled(engine)) return null;
  const authority = (await maintenancePreflight(engine, sourceId))!;
  const config = loadConfig() ?? { engine: engine.kind };
  await assertConversationAdmissionHeadroom(engine, authority, opts.slugs?.length ?? (opts.slug ? 1 : opts.limit ?? 1));
  return { engine, authority, config, embedding: await resolveManagedFactsEmbedding(engine, config) };
}

/**
 * Before any model work for one page: resolve its generation and settle it
 * without the model when this writer already admitted a request for it
 * (replayed, resubmitted, pending or blocked), or when its largest possible
 * batch cannot fit one request. Returns the generation to extract into
 * otherwise.
 */
export async function startManagedPage(state: ManagedRunState, snapshot: PageSnapshot, sinceIso: string | undefined, segments: number,
): Promise<{ done: { newEndIso: string | null } } | { start: Extract<GenerationStart, { kind: 'extract' }> }> {
  const { engine, authority, config, embedding } = state.managed!;
  const { page } = snapshot;
  const start = await startConversationGeneration(engine, authority, config, {
    slug: page.slug, page, versionToken: snapshot.versionToken, since: sinceIso ?? null, segmentLimit: state.segmentLimit,
  });
  const log = (line: string) => process.stderr.write(`[extract-conversation-facts] ${line}\n`);
  if (start.kind === 'extract') {
    const planned = state.segmentLimit > 0 ? Math.min(segments, state.segmentLimit) : segments;
    const estimate = estimateConversationIntentBytes(planned, embedding);
    const limit = await conversationIntentByteLimit(engine);
    if (estimate > limit) {
      state.result.pages_skipped_too_large++;
      log(`SKIP ${page.slug}: up to ${planned} segment(s) could freeze a ${estimate}-byte batch, over the ${limit}-byte request limit; its prior facts were kept and no model call ran. Narrow it with --slug ${page.slug} --segment-limit <n>`);
      return { done: { newEndIso: null } };
    }
    await assertConversationAdmissionHeadroom(engine, authority);
    return { start };
  }
  if (start.kind === 'resubmit') {
    log(`${page.slug}: resubmitting the stored batch of this page generation (attempt ${start.attempt + 1}); no model call`);
    await assertConversationAdmissionHeadroom(engine, authority);
    return { done: settleManagedReceipt(state, await submitConversationIntent(engine, authority, page.slug, start, start.intent)) };
  }
  if (start.kind === 'settled') {
    log(`${page.slug}: this page generation was already published; replaying its receipt, no model call`);
    return { done: settleManagedReceipt(state, start.receipt) };
  }
  if (start.kind === 'pending') {
    state.result.pages_pending = (state.result.pages_pending ?? 0) + 1;
    log(`${page.slug}: request ${start.requestId} for this page is accepted and still pending; rerun to confirm (no model call)`);
    return { done: { newEndIso: null } };
  }
  state.result.pages_blocked = (state.result.pages_blocked ?? 0) + 1;
  log(`SKIP ${page.slug}: ${start.message}`);
  return { done: { newEndIso: null } };
}

/** Books a committed receipt into the run's counters. */
function settleManagedReceipt(state: ManagedRunState, receipt: Record<string, unknown>): { newEndIso: string | null } {
  state.result.orphan_facts_cleaned += Number(receipt.deleted ?? 0);
  state.result.facts_inserted += Number(receipt.facts_inserted ?? 0);
  if (receipt.page_outcome === 'non_extractable') {
    state.result.pages_marked_non_extractable++;
    return { newEndIso: null };
  }
  state.result.pages_processed++;
  return { newEndIso: typeof receipt.newest_end === 'string' ? receipt.newest_end : null };
}

/**
 * Publishes one page's frozen batch as a receipted request. Returns the fact
 * rows inserted, or null when the request is accepted but still pending after
 * the job's wait (the page stays unfinished; the rerun replays it).
 */
export async function publishManagedBatch(state: ManagedRunState, snapshot: PageSnapshot,
  start: Extract<GenerationStart, { kind: 'extract' }>, rows: ConversationFactRow[], newestEnd: string | null): Promise<number | null> {
  const { engine, authority, config } = state.managed!;
  const complete = rows.some(row => OUTCOME_SOURCES.has(row.source));
  const intent = await buildConversationIntent(engine, config, start, rows, { complete, newestEnd, visibility: state.factVisibility });
  try {
    const receipt = await submitConversationIntent(engine, authority, snapshot.page.slug, start, intent);
    state.result.orphan_facts_cleaned += Number(receipt.deleted ?? 0);
    return Number(receipt.facts_inserted ?? 0);
  } catch (error) {
    if (!(error instanceof OperationError) || error.code !== 'write_pending') throw error;
    state.result.pages_pending = (state.result.pages_pending ?? 0) + 1;
    process.stderr.write(`[extract-conversation-facts] ${snapshot.page.slug}: its facts were accepted and are still pending; rerun to confirm (the rerun replays them, no model call)\n`);
    return null;
  }
}

/** Managed admission backpressure and exhausted request ids stop the whole run, not one page. */
export function stopsRun(err: unknown): boolean {
  return err instanceof OperationError && (err.code === 'maintenance_backpressure' || err.code === 'queue_capacity');
}
