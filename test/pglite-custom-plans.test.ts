/**
 * PGLite plans every parameterized execution for its own values. After five
 * executions Postgres may switch a prepared statement to a generic plan, and
 * without planner statistics the generic plan of the search adjacency read is
 * a pages x links nested loop: on a 2,000-page brain the sixth MCP search of a
 * process took about 7 s instead of about 45 ms.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

describe('PGLite session planning', () => {
  test('repeated parameterized queries never switch to a generic plan', async () => {
    const [row] = await engine.executeRaw<{ mode: string }>("SELECT current_setting('plan_cache_mode') AS mode");
    expect(row!.mode).toBe('force_custom_plan');
  });
});
