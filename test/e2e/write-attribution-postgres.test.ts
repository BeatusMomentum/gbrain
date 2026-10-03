import { test } from 'bun:test';
import { hasDatabase } from './helpers.ts';

// Foundations 1 write attribution on Postgres: the transaction-local actor
// settings and BEFORE ROW triggers, run direct and through transaction-mode
// PgBouncer (scripts/e2e-backend-matrix.txt).
if (hasDatabase()) {
  await import('../write-attribution.test.ts');
} else {
  test.skip('write attribution on Postgres requires DATABASE_URL', () => {});
}
