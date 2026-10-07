/**
 * Wave 9 follow-ups, item 1: managed conversation facts publish as receipted
 * `managed_maintenance_conversation_facts` requests with a generation identity.
 *
 * Protects: a crash after admission replays the stored batch with zero model
 * calls; a deterministic failure blocks the page generation (one model call
 * across three runs); --force and a partial-then-full run start a new
 * generation; the frozen batch round-trips every column through JSONB; an
 * embedding model change without a dimension change is refused, and the
 * retry extracts again; a recreated page refuses the stale batch; a lost
 * insert fails the publication; the intent-bytes, outstanding-request and
 * lifetime-id bounds stop before any model call. Runs on PGLite, and on
 * Postgres through test/e2e/conversation-facts-managed-postgres.test.ts.
 * Seams: the Core's injected extractor (no gateway), the persistence fault
 * hook (to stall publication) and the maintenance wait test seam.
 */
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ExtractedFact } from '../src/core/facts/extract.ts';
import { runExtractConversationFactsCore, currentConversationVersionToken } from '../src/commands/extract-conversation-facts.ts';
import { CONVERSATION_FACTS_INTENT, buildConversationIntent, replaceConversationFacts, startConversationGeneration,
  submitConversationIntent } from '../src/core/facts/conversation-publication.ts';
import { CONVERSATION_EXTRACTOR_VERSION, outcomeExtractorVersion } from '../src/core/facts/audit-sources.ts';
import { maintenancePreflight } from '../src/core/persistence/prepared-maintenance.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { __setMaintenanceWriteWaitForTests } from '../src/core/persistence/maintenance-wait.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { exitCodeForCode } from '../src/core/error-catalogue.ts';
import { conversationOutcomesStaleCheck } from '../src/commands/doctor/checks/conversation-outcomes.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SLUG = 'meetings/2026-09-28-plan-sync';
const transcript = (extra = '') => [
  '---', 'title: Plan sync', 'type: meeting', 'date: 2026-09-28', '---',
  '**Alice Example:** Can you send me the quarterly plan before the review?',
  '**Owner Example:** Yes, I will send it on Thursday with the finance appendix.',
  '**Alice Example:** Good. I review plans on Mondays, so that works.',
  `**Owner Example:** I will flag any launch date changes in the summary.${extra}`, '',
].join('\n');

afterEach(() => { installFaultHook(undefined); });

async function putPage(brain: ManagedBrain, content: string, slug = SLUG): Promise<void> {
  const current = await brain.engine.readPageSnapshot(slug, { sourceId: 'default' });
  await submitPageMutation(brain.ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content,
    ...(current ? { expected_revision: current.revision } : {}) } });
  // The consumer keeps the config it started with; the extraction's own requests start a fresh one under the CLI config.
  await disposePersistenceConsumer(brain.engine);
}

/** One extraction run on the page with a counting extractor; `fact` shapes the returned fact. */
async function extract(engine: BrainEngine, calls: { n: number }, opts: { force?: boolean; segmentLimit?: number; fact?: Partial<ExtractedFact> } = {}) {
  return runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [SLUG], sleepMs: 0, overrideDisabled: true,
    force: opts.force, segmentLimit: opts.segmentLimit,
    extractor: async () => {
      calls.n++;
      return [{ fact: 'Owner Example sends the quarterly plan on Thursday', kind: 'commitment', confidence: 0.9, entity_slug: null,
        source: 'test', notability: 'high', ...opts.fact } as ExtractedFact];
    } });
}

async function extractorRows(engine: BrainEngine) {
  return engine.executeRaw<Record<string, any>>(`SELECT id, fact, kind, source, source_session, context, row_num, visibility, notability, confidence,
      claim_metric, claim_value, claim_unit, claim_period, event_type, attributed_to, valid_from, embedding_model, embedding IS NOT NULL AS embedded
    FROM facts WHERE source_id='default' AND source_markdown_slug=$1 AND source LIKE 'cli:extract-conversation-facts%' ORDER BY row_num`, [SLUG]);
}

async function requests(engine: BrainEngine) {
  return engine.executeRaw<{ state: string; error_code: string | null }>(
    "SELECT state, error_code FROM persistence_requests WHERE intent->>'kind'=$1 ORDER BY sequence", [CONVERSATION_FACTS_INTENT]);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: a transcript's facts and outcome commit in one receipted request; the frozen batch round-trips through JSONB`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain, transcript());
      await engine.setConfig('embedding_disabled', 'false');
      const dims = Number(await engine.getConfig('embedding_dimensions') ?? 1536);
      const vector = Float32Array.from({ length: dims }, (_, i) => ((i % 7) - 3) / 10);
      const calls = { n: 0 };
      const result = await extract(engine, calls, { fact: { claim_metric: 'plan_pages', claim_value: 12.5, claim_unit: 'pages', claim_period: 'quarterly',
        event_type: 'meeting', attributed_to: 'user', embedding: vector, embedding_model: await engine.getConfig('embedding_model') ?? null,
        valid_from: new Date('2026-09-28T10:00:00Z') } });
      expect(result).toMatchObject({ pages_processed: 1, facts_inserted: 1, pages_failed: 0 });
      expect(calls.n).toBe(1);
      const rows = await extractorRows(engine);
      expect(rows.map(r => r.fact)).toEqual(['Owner Example sends the quarterly plan on Thursday', 'EXTRACTION_COMPLETE']);
      expect(rows[0]).toMatchObject({ kind: 'commitment', source: 'cli:extract-conversation-facts', notability: 'high', claim_metric: 'plan_pages',
        claim_unit: 'pages', claim_period: 'quarterly', event_type: 'meeting', attributed_to: 'user', embedded: true, row_num: 0 });
      expect(Number(rows[0]!.claim_value)).toBe(12.5);
      expect(Number(rows[0]!.confidence)).toBeCloseTo(0.9, 5);
      expect(new Date(rows[0]!.valid_from).toISOString()).toBe('2026-09-28T10:00:00.000Z');
      expect(outcomeExtractorVersion(rows[1]!.context)).toBe(CONVERSATION_EXTRACTOR_VERSION);
      expect(await requests(engine)).toEqual([{ state: 'committed', error_code: null }]);
      const [{ n }] = await engine.executeRaw<{ n: number }>(`SELECT count(DISTINCT write_request_id)::int AS n FROM facts
        WHERE source_id='default' AND source_markdown_slug=$1`, [SLUG]);
      expect(n).toBe(1);
      expect((await conversationOutcomesStaleCheck(engine, ['default'])).status).toBe('ok');
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: a crash after admission replays the stored batch with zero model calls`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain, transcript());
      let release!: () => void;
      const stalled = new Promise<void>(resolve => { release = resolve; });
      installFaultHook(async point => { if (point === 'consumer:prepared') await stalled; });
      const restore = __setMaintenanceWriteWaitForTests(300);
      const calls = { n: 0 };
      try {
        const first = await extract(engine, calls);
        expect(first).toMatchObject({ pages_pending: 1, facts_inserted: 0 });
        expect(calls.n).toBe(1);
        __setMaintenanceWriteWaitForTests(20_000);
        setTimeout(release, 300);
        const second = await extract(engine, calls);
        expect(second).toMatchObject({ pages_processed: 1, facts_inserted: 1 });
        expect(calls.n).toBe(1);
      } finally { release(); restore(); }
      expect((await extractorRows(engine)).map(r => r.fact)).toEqual(['Owner Example sends the quarterly plan on Thursday', 'EXTRACTION_COMPLETE']);
      expect((await requests(engine)).map(r => r.state)).toEqual(['committed']);
      const third = await extract(engine, calls);
      expect(third).toMatchObject({ pages_skipped_completed: 1 });
      expect(calls.n).toBe(1);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: a deterministic apply failure makes exactly one model call across three runs`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain, transcript());
      const calls = { n: 0 };
      const bad = { kind: 'not-a-kind' } as unknown as Partial<ExtractedFact>;
      const first = await extract(engine, calls, { fact: bad });
      expect(first.pages_failed).toBe(1);
      const second = await extract(engine, calls, { fact: bad });
      const third = await extract(engine, calls, { fact: bad });
      expect(calls.n).toBe(1);
      expect(second).toMatchObject({ pages_blocked: 1, pages_failed: 0 });
      expect(third).toMatchObject({ pages_blocked: 1 });
      expect(await requests(engine)).toEqual([{ state: 'failed', error_code: 'invalid_params' }]);
      expect(await extractorRows(engine)).toEqual([]);
      // The page changes: a new generation extracts again.
      await putPage(brain, transcript(' Thanks.'));
      const fourth = await extract(engine, calls);
      expect(fourth).toMatchObject({ pages_processed: 1, facts_inserted: 1 });
      expect(calls.n).toBe(2);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: --force and a partial-then-full run each start a new generation`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      // 32 turns: two segments (DEFAULT_SEGMENT_MAX_MESSAGES is 30).
      const turns = Array.from({ length: 32 }, (_, i) => `**${i % 2 ? 'Owner' : 'Alice'} Example:** Turn ${i + 1} about the quarterly plan.`);
      await putPage(brain, ['---', 'title: Plan sync', 'type: meeting', 'date: 2026-09-28', '---', ...turns, ''].join('\n'));
      const calls = { n: 0 };
      const partial = await extract(engine, calls, { segmentLimit: 1 });
      expect(partial).toMatchObject({ pages_processed: 1, segments_processed: 1, facts_inserted: 1 });
      expect(calls.n).toBe(1);
      // A committed partial batch is not a completed page: no outcome row.
      expect((await extractorRows(engine)).map(r => r.fact)).toEqual(['Owner Example sends the quarterly plan on Thursday']);
      const full = await extract(engine, calls);
      expect(full).toMatchObject({ pages_processed: 1, segments_processed: 2 });
      expect(calls.n).toBe(3);
      expect((await extractorRows(engine)).map(r => r.fact).at(-1)).toBe('EXTRACTION_COMPLETE');
      expect((await extract(engine, calls)).pages_skipped_completed).toBe(1);
      expect(calls.n).toBe(3);
      const forced = await extract(engine, calls, { force: true });
      expect(forced).toMatchObject({ pages_processed: 1, segments_processed: 2 });
      expect(calls.n).toBe(5);
      expect((await requests(engine)).map(r => r.state)).toEqual(['committed', 'committed', 'committed']);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: an embedding model change without a dimension change is refused, and the retry extracts again`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain, transcript());
      await engine.setConfig('embedding_disabled', 'false');
      const authority = (await maintenancePreflight(engine, 'default'))!;
      const page = (await engine.getPage(SLUG, { sourceId: 'default' }))!;
      const versionToken = await currentConversationVersionToken(engine, page);
      const start = await startConversationGeneration(engine, authority, brain.ctx.config, { slug: SLUG, page, versionToken, since: null, segmentLimit: 0 });
      if (start.kind !== 'extract') throw new Error(`unexpected generation state ${start.kind}`);
      const dims = Number(await engine.getConfig('embedding_dimensions') ?? 1536);
      const intent = await buildConversationIntent(engine, { engine: engine.kind }, start, [{ fact: 'A vector claim', kind: 'fact',
        source: 'cli:extract-conversation-facts', row_num: 0, source_markdown_slug: SLUG, embedding: new Float32Array(dims).fill(0.1) }],
      { complete: false, newestEnd: null, visibility: 'private' });
      expect(intent.embedding).toMatchObject({ dimensions: dims });
      const model = await engine.getConfig('embedding_model');
      await engine.setConfig('embedding_model', 'openai:text-embedding-other-example');
      try {
        const error = await submitConversationIntent(engine, authority, SLUG, start, intent).then(() => null, (e: Error & { code?: string }) => e);
        expect(error?.code).toBe('embedding_configuration');
      } finally { await engine.setConfig('embedding_model', model!); }
      const retry = await startConversationGeneration(engine, authority, brain.ctx.config, { slug: SLUG, page, versionToken, since: null, segmentLimit: 0 });
      expect(retry).toMatchObject({ kind: 'extract', attempt: 1 });
      expect(await extractorRows(engine)).toEqual([]);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: a page recreated at the same slug refuses the stale batch`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain, transcript());
      const authority = (await maintenancePreflight(engine, 'default'))!;
      const page = (await engine.getPage(SLUG, { sourceId: 'default' }))!;
      const versionToken = await currentConversationVersionToken(engine, page);
      const start = await startConversationGeneration(engine, authority, brain.ctx.config, { slug: SLUG, page, versionToken, since: null, segmentLimit: 0 });
      if (start.kind !== 'extract') throw new Error(`unexpected generation state ${start.kind}`);
      const intent = await buildConversationIntent(engine, { engine: engine.kind }, start, [{ fact: 'A stale claim', kind: 'fact',
        source: 'cli:extract-conversation-facts', row_num: 0, source_markdown_slug: SLUG }], { complete: false, newestEnd: null, visibility: 'private' });
      const live = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
      await submitPageMutation(brain.ctx, { operation: 'delete_page', params: { slug: SLUG, expected_revision: live.revision, request_id: randomUUID() } });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("DELETE FROM pages WHERE source_id='default' AND slug=$1", [SLUG]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await disposePersistenceConsumer(engine);
      await putPage(brain, transcript());
      const error = await submitConversationIntent(engine, authority, SLUG, start, intent).then(() => null, (e: Error & { code?: string }) => e);
      expect(['revision_conflict', 'page_identity_changed']).toContain(error?.code ?? 'none');
      expect(await extractorRows(engine)).toEqual([]);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: the intent-bytes, outstanding-request and lifetime-id bounds stop before any model call`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain, transcript());
      await putPage(brain, transcript().replace('Plan sync', 'Plan sync two'), 'meetings/2026-09-29-plan-sync');
      const calls = { n: 0 };
      // Intent bytes: one segment's largest batch cannot fit.
      await engine.setConfig('persistence.limits.principal_intent_bytes', '20000');
      const tooLarge = await extract(engine, calls);
      expect(tooLarge).toMatchObject({ pages_skipped_too_large: 1, facts_inserted: 0 });
      expect(calls.n).toBe(0);
      await engine.executeRaw("DELETE FROM config WHERE key='persistence.limits.principal_intent_bytes'");
      // Lifetime ids: no headroom refuses before the run.
      const authority = (await maintenancePreflight(engine, 'default'))!;
      const [used] = await engine.executeRaw<{ n: number }>("SELECT COALESCE(max(lifetime_ids),0)::int AS n FROM persistence_counters WHERE key LIKE 'principal:%'");
      await engine.setConfig('persistence.limits.principal_lifetime_ids', String(used!.n));
      const lifetime = await extract(engine, calls).then(() => null, (e: Error & { code?: string }) => e);
      expect(lifetime?.code).toBe('queue_capacity');
      expect(calls.n).toBe(0);
      await engine.executeRaw("DELETE FROM config WHERE key='persistence.limits.principal_lifetime_ids'");
      // Outstanding: with one request pending, a limit of 2 (80% = 1) stops admitting the next page.
      await engine.setConfig('persistence.limits.principal_outstanding', '2');
      let release!: () => void;
      const stalled = new Promise<void>(resolve => { release = resolve; });
      installFaultHook(async point => { if (point === 'consumer:prepared') await stalled; });
      const restore = __setMaintenanceWriteWaitForTests(300);
      try {
        const pending = await extract(engine, calls);
        expect(pending.pages_pending).toBe(1);
        expect(calls.n).toBe(1);
        const stopped = await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: ['meetings/2026-09-29-plan-sync'], sleepMs: 0,
          overrideDisabled: true, extractor: async () => { calls.n++; return []; } }).then(() => null, (e: Error & { code?: string }) => e);
        expect(stopped?.code).toBe('maintenance_backpressure');
        expect(exitCodeForCode('maintenance_backpressure')).toBe(12);
        expect(calls.n).toBe(1);
      } finally { release(); restore(); }
      expect(authority.writer.principal.kind).toBe('local_cli');
    }, { databaseUrl });
  }, 120_000);
}

test('a lost insert fails the replacement instead of committing a partial batch', async () => {
  const tx = {
    executeRaw: async (sql: string) => sql.includes('DELETE') ? [{ count: '2' }] : [{ n: null }],
    insertFacts: async () => ({ inserted: 1, ids: [1], warnings: [], deleted: 0 }),
  } as unknown as BrainEngine;
  const error = await replaceConversationFacts(tx, 'default', SLUG, [
    { fact: 'one', source: 'cli:extract-conversation-facts' }, { fact: 'two', source: 'cli:extract-conversation-facts' },
  ]).then(() => null, (e: Error & { code?: string }) => e);
  expect(error?.code).toBe('storage_error');
});
