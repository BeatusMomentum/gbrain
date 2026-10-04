/**
 * Temporal typed edges — relationship state refresh and the liveness filter on
 * a real PGLite brain (schema + migration + engine-sql domain). The Postgres
 * twin is test/e2e/link-relationships-postgres.test.ts.
 */
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { defineLinkRelationshipTests } from './helpers/link-temporal-scenario.ts';

defineLinkRelationshipTests('pglite', async () => {
  const eng = new PGLiteEngine();
  await eng.connect({});
  await eng.initSchema();
  return eng;
}, eng => eng.disconnect());
