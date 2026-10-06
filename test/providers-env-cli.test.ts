/**
 * `gbrain providers env <id>` reads the DB plane of a configured, free brain
 * (#5302). Protects: an operator sees the endpoint a `gbrain config set
 * provider_base_urls.<id>` row actually selects, and is told when the DB plane
 * was not read. Fails when the command prints the recipe default while a DB
 * row is in force. The pure resolver is covered in providers.test.ts; this is
 * the only test of the engine open and its disclosure.
 *
 * Real CLI subprocesses against one temp PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gb } from './helpers/agent-journey.ts';

describe('providers env reads the DB plane (#5302)', () => {
  let home = '';
  let empty = '';
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-providers-env-'));
    empty = mkdtempSync(join(tmpdir(), 'gbrain-providers-env-empty-'));
    expect((await gb(home, ['init', '--pglite', '--no-embedding', '--json'], { timeoutMs: 120_000 })).exitCode).toBe(0);
  }, 150_000);
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  });

  test('a DB-plane provider_base_urls row is the displayed URL, labelled db plane', async () => {
    const set = await gb(home, ['config', 'set', 'provider_base_urls.mistral', 'https://api.eu.mistral.ai/v1']);
    expect(set.exitCode, set.stderr.slice(-1500)).toBe(0);
    const r = await gb(home, ['providers', 'env', 'mistral']);
    expect(r.exitCode, r.stderr.slice(-1500)).toBe(0);
    expect(r.stdout).toContain('Base URL: https://api.eu.mistral.ai/v1  (provider_base_urls.mistral (db plane))');
    expect(r.stdout).toContain('DB plane read: provider_base_urls overrides are included.');
  }, 120_000);

  test('with no brain configured it prints the recipe default and says the DB plane was not read', async () => {
    const r = await gb(empty, ['providers', 'env', 'mistral']);
    expect(r.exitCode, r.stderr.slice(-1500)).toBe(0);
    expect(r.stdout).toContain('Base URL: https://api.mistral.ai/v1  (recipe default)');
    expect(r.stdout).toContain('DB plane not read (no brain configured)');
  }, 120_000);
});
