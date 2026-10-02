/**
 * The resident consumer's stderr line is the only trace an operator gets when
 * a phase fails or overruns. #5233: the line carried only an error code, so a
 * pooler's "max clients reached" was invisible. It now carries a redacted,
 * one-line, length-capped message, a fix command and a docs anchor.
 *
 * Regression that fails it: dropping the message (or the redaction) from the
 * line. Existing coverage asserts consumer state, not this line.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const stderr: string[] = [];
let spy: ReturnType<typeof spyOn> | undefined;
afterEach(() => { spy?.mockRestore(); spy = undefined; stderr.length = 0; });

function captureStderr() {
  spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
}

function failingEngine(error: Error): BrainEngine {
  return new Proxy({ kind: 'pglite' } as Record<string, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      if (prop === 'then') return undefined;
      return async () => { throw error; };
    },
  }) as unknown as BrainEngine;
}

describe('persistence consumer stderr line', () => {
  test('#5233: carries the SQLSTATE and a redacted, capped, one-line message', async () => {
    const error = Object.assign(new Error(
      '(EMAXCONNSESSION) max clients reached in session mode\n - pool_size: 15 for postgresql://writer:secret-pw@pooler.example.com:5432/postgres '
        + 'x'.repeat(400)), { code: '53300' });
    captureStderr();
    const consumer = new PersistenceConsumer(failingEngine(error), { engine: 'pglite' }, async () => { throw error; }, { hostId: crypto.randomUUID() });
    try { await consumer.tick(); } finally { await consumer.stop(); }
    const line = stderr.find(entry => entry.startsWith('[persistence] phase='));
    expect(line).toBeDefined();
    expect(line).toContain('reason=53300');
    expect(line).toContain('message="(EMAXCONNSESSION) max clients reached in session mode - pool_size: 15 for ');
    expect(line).not.toContain('secret-pw');
    expect(line).toContain('fix: gbrain sources writer status --json');
    expect(line).toContain('docs: docs/ENGINES.md#persistence-consumer-log');
    const message = /message="([^"]*)"/.exec(line!)![1];
    expect(message.length).toBeLessThanOrEqual(200);
    expect(line!.trimEnd().includes('\n')).toBe(false);
  });
});
