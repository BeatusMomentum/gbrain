/** Real Postgres backstop for JSONB authority and atomic legacy review. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { runMigrations } from '../../src/core/migrate.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { prepareRemoteJob, authorizeJobExecution, assertNoUnreviewedJobs } from '../../src/core/minions/submission-authority.ts';
import { authorizeLegacyJobs } from '../../src/core/minions/authorize-legacy.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { withEnv } from '../helpers/with-env.ts';
import { randomUUID } from 'node:crypto';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { authorizeStoredRequest } from '../../src/core/persistence/authority.ts';
import { getWriteRequest } from '../../src/core/persistence/journal.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';

const suite = hasDatabase() ? describe : describe.skip;
suite('Postgres queued authority parity', () => {
  let sandbox: string, root: string, queue: MinionQueue;
  const ctx = (): OperationContext => ({
    engine: getEngine(), config: {} as OperationContext['config'], remote: true, sourceId: 'default', dryRun: false,
    logger: { info() {}, warn() {}, error() {} },
    auth: { token: 'test-only', clientId: 'authority-test-client', principal: { kind: 'oauth_client', id: 'authority-test-client' }, scopes: ['admin'], sourceId: 'default' },
  });
  beforeAll(async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'gbrain-pg-job-authority-'));
    root = join(sandbox, 'repo'); mkdirSync(root); execFileSync('git', ['init', '-q', root]);
    await withEnv({ GBRAIN_HOME: sandbox }, async () => { await setupDB(); await runMigrations(getEngine()); });
    queue = new MinionQueue(getEngine());
  }, 120_000);
  afterAll(async () => {
    // Later files on the same database start real workers, which refuse to run while any unreviewed job remains.
    await getEngine().executeRaw('DELETE FROM minion_jobs');
    await disposePersistenceConsumer(getEngine());
    await teardownDB();
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await getEngine().executeRaw('DELETE FROM minion_jobs');
    await getEngine().executeRaw("DELETE FROM oauth_clients WHERE client_id = 'authority-test-client'");
    await getEngine().executeRaw("UPDATE sources SET local_path = $1, config = '{}'::jsonb, archived = false WHERE id = 'default'", [root]);
    await getEngine().executeRaw("INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, scope, source_id) VALUES ('authority-test-client', 'fixture-hash', 'example-client', 'admin', 'default')");
  });
  test('controlled queue protocol cutover matches PGLite', async () => {
    const { rehearseMinionAuthorityUpgrade } = await import('../helpers/minion-authority-upgrade.ts');
    await rehearseMinionAuthorityUpgrade(getEngine());
  });
  test('authority is a JSON object on PostgreSQL and survives replay without promotion', async () => {
    const accepted = await prepareRemoteJob(ctx(), 'lint', {});
    const job = await queue.add('lint', accepted.data, {}, { submissionAuthority: accepted.authority });
    const [raw] = await getEngine().executeRaw<{ kind: string }>('SELECT jsonb_typeof(submission_authority) AS kind FROM minion_jobs WHERE id = $1', [job.id]);
    expect(raw.kind).toBe('object');
    await authorizeJobExecution(getEngine(), (await queue.getJob(job.id))!);
    await getEngine().executeRaw("UPDATE minion_jobs SET status = 'completed' WHERE id = $1", [job.id]);
    expect((await queue.replayJob(job.id))?.submission_authority).toEqual(accepted.authority);
    await getEngine().executeRaw("UPDATE oauth_clients SET deleted_at = now() WHERE client_id = 'authority-test-client'");
    await expect(queue.replayJob(job.id)).rejects.toThrow('revoked');
  });
  test('an OAuth job-namespace write retains its job id in JSONB authority and replays only for that job (#5920)', async () => {
    const engine = getEngine();
    const clientId = `job-writer-${randomUUID()}`;
    await engine.executeRaw(`INSERT INTO oauth_clients
      (client_id, client_name, client_secret_hash, scope, source_id, bound_source_id, federated_read, bound_tools, delegated_namespace)
      VALUES ($1, 'example-job-writer', 'fixture-hash', 'read agent', 'default', 'default', ARRAY['default']::text[], ARRAY['put_page'], 'job')`, [clientId]);
    const jobCtx: OperationContext = { ...ctx(), viaSubagent: true, subagentId: 382,
      auth: { token: 'test-only', clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['read', 'agent'], sourceId: 'default' } };
    const request_id = randomUUID();
    await withEnv({ GBRAIN_HOME: sandbox }, async () => {
      const result = await submitPageMutation(jobCtx, { operation: 'put_page', params: { slug: 'wiki/agents/382/result', content: 'Owned job output', request_id } });
      expect(result.state).toBe('committed');
    });
    const [stored] = await engine.executeRaw<{ kind: string; id: number }>(
      `SELECT jsonb_typeof(authority->'subagentId') AS kind, (authority->>'subagentId')::int AS id
         FROM persistence_requests WHERE principal_id = $1 AND request_id = $2::uuid`, [clientId, request_id]);
    expect(stored).toEqual({ kind: 'number', id: 382 });
    const row = (await getWriteRequest(engine, jobCtx.auth!.principal!, request_id))!;
    await authorizeStoredRequest(engine, row);
    for (const subagentId of [383, Number.NaN, undefined]) {
      await expect(authorizeStoredRequest(engine, { ...row, authority: { ...row.authority, subagentId } }))
        .rejects.toMatchObject({ code: 'permission_denied' });
    }
    await engine.executeRaw("UPDATE oauth_clients SET bound_tools = ARRAY['get_page'] WHERE client_id = $1", [clientId]);
    await expect(authorizeStoredRequest(engine, row)).rejects.toMatchObject({ code: 'permission_denied' });
    await engine.executeRaw("UPDATE oauth_clients SET bound_tools = ARRAY['put_page'], delegated_namespace = 'prefixes', delegated_slug_prefixes = ARRAY['notes/*'] WHERE client_id = $1", [clientId]);
    await expect(authorizeStoredRequest(engine, row)).rejects.toMatchObject({ code: 'permission_denied' });
    await engine.executeRaw("UPDATE oauth_clients SET delegated_namespace = 'job', delegated_slug_prefixes = NULL, deleted_at = now() WHERE client_id = $1", [clientId]);
    await expect(authorizeStoredRequest(engine, row)).rejects.toMatchObject({ code: 'permission_denied' });
  });
  test('legacy CAS rollback, NULL cutover gate, and raw-object stamp match PGLite', async () => {
    const job = await queue.add('maintenance', { example: true });
    await getEngine().executeRaw('UPDATE minion_jobs SET submission_authority = NULL WHERE id = $1', [job.id]);
    await expect(assertNoUnreviewedJobs(getEngine())).rejects.toThrow('legacy jobs');
    const preview = await authorizeLegacyJobs(getEngine(), [job.id]);
    await expect(authorizeLegacyJobs(getEngine(), [job.id], 'a'.repeat(64), true)).rejects.toThrow('snapshot changed');
    expect((await queue.getJob(job.id))?.submission_authority).toBeNull();
    await authorizeLegacyJobs(getEngine(), [job.id], preview.snapshot_digest, true);
    expect((await queue.getJob(job.id))?.submission_authority).toEqual({ version: 1, kind: 'application' });
    await assertNoUnreviewedJobs(getEngine());
  });
  test('future authority and JSON null cannot enter the SQL-NULL legacy approval path', async () => {
    const job = await queue.add('maintenance', {});
    await getEngine().executeRaw('UPDATE minion_jobs SET submission_authority = NULL WHERE id = $1', [job.id]);
    const preview = await authorizeLegacyJobs(getEngine(), [job.id]);
    for (const value of [{ version: 2, kind: 'application' }, null]) {
      if (value === null) {
        await getEngine().executeRaw("UPDATE minion_jobs SET submission_authority = 'null'::jsonb WHERE id = $1", [job.id]);
      } else {
        await getEngine().executeRaw('UPDATE minion_jobs SET submission_authority = $1::jsonb WHERE id = $2', [value, job.id]);
      }
      const [before] = await getEngine().executeRaw<{ authority: string }>('SELECT submission_authority::text AS authority FROM minion_jobs WHERE id = $1', [job.id]);
      await expect(authorizeLegacyJobs(getEngine(), [job.id])).rejects.toThrow('SQL NULL');
      await expect(authorizeLegacyJobs(getEngine(), [job.id], preview.snapshot_digest, true)).rejects.toThrow('SQL NULL');
      await expect(assertNoUnreviewedJobs(getEngine())).rejects.toThrow('unsupported authority');
      const [after] = await getEngine().executeRaw<{ authority: string }>('SELECT submission_authority::text AS authority FROM minion_jobs WHERE id = $1', [job.id]);
      expect(after.authority).toBe(before.authority);
    }
  });
});
