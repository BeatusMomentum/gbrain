/**
 * #1972 — gbrain-owned hard bound on pool teardown.
 *
 * The bug: `pool.end()` against PgBouncer transaction-mode never drains, so
 * disconnect blocked until the CLI's 10s force-exit fired and truncated stdout.
 * postgres.js's own `{ timeout }` is internal (a stub ignores it; it's not a
 * guarantee we own), so `endPoolBounded` wraps every end in a Promise.race we
 * control. These tests assert the bound is real (resolves even when `.end()`
 * never settles) and that we still pass `{ timeout }` so a healthy drain is fast.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { endPoolBounded, POOL_END_TIMEOUT_SECONDS } from '../src/core/db.ts';

describe('endPoolBounded', () => {
  test('resolves fast when .end() settles quickly, forwarding { timeout }', async () => {
    let calledWith: unknown;
    const pool = { end: async (opts?: { timeout?: number }) => { calledWith = opts; } };
    const t0 = Date.now();
    await endPoolBounded(pool);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(calledWith).toEqual({ timeout: POOL_END_TIMEOUT_SECONDS });
  });

  test('resolves within the gbrain bound even when .end() NEVER settles', async () => {
    // This is the PgBouncer hang: .end() returns a promise that never resolves.
    // The bare `await pool.end()` would hang until the CLI's 10s force-exit.
    const pool = { end: () => new Promise<void>(() => { /* never resolves */ }) };
    const t0 = Date.now();
    await endPoolBounded(pool);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(POOL_END_TIMEOUT_SECONDS * 1000);
    expect(elapsed).toBeLessThan(5000); // well under the CLI's 10s force-exit deadline
  });

  test('never throws when .end() rejects (teardown must not propagate)', async () => {
    const pool = { end: async () => { throw new Error('pool boom'); } };
    await expect(endPoolBounded(pool)).resolves.toBeUndefined();
  });

  // #5332 platform coverage. The Windows `bun test` scheduling that skips an
  // unref'd timer cannot run on CI, so this pins the mechanism: the guard
  // timer is never unref'd.
  test('the guard timer is never unref\'d', async () => {
    const original = globalThis.setTimeout;
    let unrefCalls = 0;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const t = original(fn, ms);
      const origUnref = (t as { unref?: () => void }).unref;
      if (origUnref) (t as { unref: () => void }).unref = () => { unrefCalls += 1; return origUnref.call(t); };
      return t;
    }) as typeof setTimeout;
    try {
      await endPoolBounded({ end: () => new Promise<void>(() => { /* never resolves */ }) });
    } finally {
      globalThis.setTimeout = original;
    }
    expect(unrefCalls).toBe(0);
  });

  test('a process with nothing else on its loop still returns from a never-settling end', () => {
    const db = join(import.meta.dir, '../src/core/db.ts');
    const child = spawnSync(process.execPath, ['--no-env-file', '--eval', `
      const { endPoolBounded } = await import(${JSON.stringify(db)});
      await endPoolBounded({ end: () => new Promise(() => {}) });
      console.log('bounded');
    `], { encoding: 'utf-8', timeout: 15_000 });
    expect({ status: child.status, stdout: child.stdout.trim() }).toEqual({ status: 0, stdout: 'bounded' });
  }, 20_000);
});
