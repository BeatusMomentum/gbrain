/**
 * Temporal typed edges on Postgres: the shared relationship-state scenario
 * (test/helpers/link-temporal-scenario.ts) against a real database, covering
 * datemultirange text, JSONB recordset binding and the graph generation
 * sequence through postgres.js.
 */
import { test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { defineLinkRelationshipTests } from '../helpers/link-temporal-scenario.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  test.skip('link relationships Postgres scenario skipped (DATABASE_URL unset)', () => {});
} else {
  defineLinkRelationshipTests('postgres', async () => {
    const eng = new PostgresEngine();
    assertSafeE2eDatabaseUrl(databaseUrl);
    await eng.connect({ database_url: databaseUrl });
    await eng.initSchema();
    return eng;
  }, eng => eng.disconnect(), 'lrtpg');
}
