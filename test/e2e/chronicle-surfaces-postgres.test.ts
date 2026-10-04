/**
 * #5876 (T11) on real Postgres: the chronicle ledger rollups behind doctor `auto_chronicle` and the
 * advisor (FILTER aggregates, numeric -> float8 spend, the reservation/ledger join for writer
 * shares, interval windows) return the same numbers as on PGLite
 * (test/auto-chronicle-surfaces-5876.test.ts). Uses the TEMPORARY ledger stub until Lane 1's
 * `chronicle_page_state` migration merges.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { readChronicleLedgerStats } from '../../src/core/chronicle/ledger-stats.ts';
import { autoChronicleEntry } from '../../src/commands/doctor/checks/auto-chronicle.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import type { Check } from '../../src/commands/doctor.ts';
import { createChronicleLedgerStub, insertChronicleLedgerRow } from '../helpers/chronicle-ledger-stub.ts';

const d = hasDatabase() ? describe : describe.skip;

beforeAll(async () => {
  if (!hasDatabase()) return;
  await setupDB();
  await createChronicleLedgerStub(getEngine());
});
afterAll(async () => {
  if (!hasDatabase()) return;
  await getEngine().executeRaw('DROP TABLE IF EXISTS chronicle_page_state');
  await getEngine().executeRaw('DROP TABLE IF EXISTS chronicle_judge_reservations');
  await teardownDB();
});
beforeEach(async () => {
  if (!hasDatabase()) return;
  await getEngine().executeRaw('DELETE FROM chronicle_page_state');
  await getEngine().executeRaw('DELETE FROM chronicle_judge_reservations');
  for (const k of ['auto_chronicle', 'chronicle.auto_daily_limit']) await getEngine().unsetConfig(k);
});

d('chronicle ledger rollups on Postgres', () => {
  test('24 h calls include retries, writer share, 7-day outcomes and spend kept apart', async () => {
    const engine = getEngine();
    await insertChronicleLedgerRow(engine, { slug: 'meetings/a', state: 'extracted', principal: ['oauth_client', 'client-a'], cost: 0.01, retries: 1 });
    await insertChronicleLedgerRow(engine, { slug: 'meetings/b', state: 'extracted', principal: ['oauth_client', 'client-a'], cost: 0.02 });
    await insertChronicleLedgerRow(engine, { slug: 'meetings/c', state: 'extracted', principal: ['local_cli', 'w1'], unpriced: true });
    await insertChronicleLedgerRow(engine, { slug: 'meetings/old', state: 'extracted', cost: 5, hoursAgo: 24 * 9 });
    await insertChronicleLedgerRow(engine, { slug: 'meetings/s1', state: 'skipped', reason: 'superseded' });
    await insertChronicleLedgerRow(engine, { slug: 'meetings/f1', state: 'failed', reason: 'no_pricing' });
    await insertChronicleLedgerRow(engine, { slug: 'meetings/p', state: 'pending' });
    await insertChronicleLedgerRow(engine, { slug: 'meetings/bf', state: 'extracted', trigger: 'backfill', cost: 1 });
    const stats = await readChronicleLedgerStats(engine);
    expect(stats).toEqual({
      available: true, pending: 1, autoCalls24h: 5,
      principals24h: [{ principal: 'oauth_client:client-a', calls: 3 }, { principal: 'local_cli:w1', calls: 1 }, { principal: 'unattributed', calls: 1 }],
      last7d: { extracted: 3, failed: 1, skipped: 1, reasons: { no_pricing: 1, superseded: 1 }, failedReasons: { no_pricing: 1 } },
      spend7d: { knownUsd: 0.03, unpricedCalls: 1, incompleteRecords: 1 },
    });
  });

  test('doctor reports the failed reason with its fix', async () => {
    const engine = getEngine();
    await insertChronicleLedgerRow(engine, { slug: 'meetings/f1', state: 'failed', reason: 'judge_truncated' });
    const checks = (await autoChronicleEntry.run({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext)) as Check[];
    expect(checks.find((c) => c.name === 'auto_chronicle')).toMatchObject({ status: 'warn',
      details: { code: 'judge_truncated', fix: { argv: ['gbrain', 'config', 'set', 'chronicle.judge_max_tokens', '8000'] } } });
  });
});
