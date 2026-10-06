/**
 * search.statement_timeout_ms (#5024): the Postgres lexical search arms
 * (keyword, keyword chunks, CJK, title) bounded every statement with a fixed
 * 8 s statement_timeout. On a large brain the keyword arm cannot finish in
 * it, so every search fails open to vector-only. The bound is now one
 * DB-plane key: whole milliseconds 1..60000, default 8000, no env override.
 *
 * - the resolver reads the key once per 60 s per engine, before the search
 *   transaction opens (no second pool checkout), and binds it as a parameter;
 * - a stored invalid value warns once, naming the key (never the value), and
 *   keeps the default;
 * - `config set` refuses an out-of-range value (exit 2, agent contract);
 * - a statement canceled by the bound (SQLSTATE 57014) degrades the arm as
 *   `timeout` and the warning names the key.
 *
 * Real Postgres coverage (bound applied, caller value restored, 57014) lives
 * in test/e2e/search-query-contract-postgres.test.ts.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { SearchStatementTimeout } from '../src/core/postgres-engine/search-settings.ts';
import { runConfig } from '../src/commands/config.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { _resetWarnOnceForTests } from '../src/core/utils.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { HybridSearchMeta, SearchResult } from '../src/core/types.ts';

const KEY = 'search.statement_timeout_ms';

function reader(value: string | null, opts: { throws?: boolean } = {}) {
  const reads: string[] = [];
  const read = async (key: string) => {
    reads.push(key);
    if (opts.throws) throw new Error('pooler drop');
    return key === KEY ? value : null;
  };
  return { read, reads };
}

async function captureWarn<T>(fn: () => Promise<T>): Promise<{ result: T; warned: string[] }> {
  const warned: string[] = [];
  const spy = spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warned.push(a.join(' ')); });
  try { return { result: await fn(), warned }; } finally { spy.mockRestore(); }
}

describe('SearchStatementTimeout.resolve', () => {
  test('defaults to 8000 ms when the key is unset', async () => {
    expect(await new SearchStatementTimeout().resolve(reader(null).read)).toBe('8000ms');
  });

  test('honours a stored value in range, including both bounds', async () => {
    for (const [stored, bound] of [['45000', '45000ms'], ['1', '1ms'], ['60000', '60000ms'], [' 2500 ', '2500ms']]) {
      expect(await new SearchStatementTimeout().resolve(reader(stored).read)).toBe(bound);
    }
  });

  test('a stored invalid value keeps the default and warns once naming the key, never the value', async () => {
    for (const stored of ['0', '60001', '2147483647', '30 seconds; DROP TABLE pages', '1.5', '-5', '']) {
      const timeout = new SearchStatementTimeout();
      const { result, warned } = await captureWarn(async () => [await timeout.resolve(reader(stored).read), await timeout.resolve(reader(stored).read)]);
      expect(result).toEqual(['8000ms', '8000ms']);
      expect(warned.length).toBe(1);
      expect(warned[0]).toContain(KEY);
      expect(warned[0]).toContain('gbrain config set search.statement_timeout_ms <ms>');
      expect(warned[0]).not.toContain('DROP TABLE');
      expect(warned[0]).not.toContain('2147483647');
    }
  });

  test('memoizes for 60 s so the hot path does not read config per query', async () => {
    const r = reader('20000');
    const timeout = new SearchStatementTimeout();
    for (let i = 0; i < 3; i++) expect(await timeout.resolve(r.read)).toBe('20000ms');
    expect(r.reads).toEqual([KEY]);
  });

  test('a config read failure never takes search down and is not memoized', async () => {
    const timeout = new SearchStatementTimeout();
    expect(await timeout.resolve(reader(null, { throws: true }).read)).toBe('8000ms');
    expect(await timeout.resolve(reader('30000').read)).toBe('30000ms');
  });
});

describe('Postgres lexical arms apply the configured bound', () => {
  test('searchKeywordChunks reads the key before its transaction and binds it as a parameter', async () => {
    const engine = Object.create(PostgresEngine.prototype) as PostgresEngine;
    const priv = engine as unknown as Record<string, unknown>;
    let insideTransaction = false;
    priv.searchTimeout = new SearchStatementTimeout();
    priv.getConfig = async (key: string) => {
      expect(insideTransaction).toBe(false);
      return key === KEY ? '45000' : null;
    };
    const issued: { text: string; values: unknown[] }[] = [];
    const tx = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => { issued.push({ text: strings.join('$'), values }); return []; },
      { unsafe: async () => [] },
    );
    priv.withScopedReadTransaction = async (_ids: unknown, _id: unknown, fn: (t: typeof tx) => Promise<unknown>) => {
      insideTransaction = true;
      try { return await fn(tx); } finally { insideTransaction = false; }
    };
    await engine.searchKeywordChunks('hello');
    expect(issued).toEqual([{ text: "SELECT set_config('statement_timeout', $, true)", values: ['45000ms'] }]);
  });
});

async function runConfigCapture(args: string[]): Promise<{ errs: string; exit: number | null; setCalls: Array<[string, string]> }> {
  const setCalls: Array<[string, string]> = [];
  const engine = {
    getConfig: async () => null,
    setConfig: async (key: string, value: string) => { setCalls.push([key, value]); },
  } as unknown as BrainEngine;
  const errs: string[] = [];
  let exit: number | null = null;
  const spies = [
    spyOn(console, 'log').mockImplementation(() => {}),
    spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); }),
    spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { errs.push(String(chunk)); return true; }) as never),
    spyOn(process, 'exit').mockImplementation(((code?: number) => { exit = code ?? 0; throw new Error(`EXIT:${code}`); }) as never),
  ];
  try {
    await runConfig(engine, args);
  } catch (e) {
    if (!(e as Error).message.startsWith('EXIT:')) throw e;
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return { errs: errs.join('\n'), exit, setCalls };
}

describe('config set search.statement_timeout_ms', () => {
  for (const value of ['0', '60001', 'abc', '1.5']) {
    test(`refuses ${JSON.stringify(value)} (exit 2, contract rendered, nothing written)`, async () => {
      const { errs, exit, setCalls } = await runConfigCapture(['set', KEY, value]);
      expect(exit).toBe(2);
      expect(setCalls).toEqual([]);
      expect(errs).toContain(`Error [invalid_params]: ${KEY} must be a whole number of milliseconds from 1 to 60000. Nothing was written.`);
      expect(errs).toContain(`Fix: gbrain config set ${KEY} '<MS>'`);
      expect(errs).toContain('Why: The value bounds every Postgres lexical search statement');
    });
  }

  test('accepts a value in range', async () => {
    const { exit, setCalls } = await runConfigCapture(['set', KEY, '30000']);
    expect(exit).toBeNull();
    expect(setCalls).toEqual([[KEY, '30000']]);
  });
});

describe('a canceled lexical statement degrades as timeout and names the key', () => {
  function fakeEngine(keywordError: Error): BrainEngine {
    return {
      kind: 'postgres',
      getConfig: async () => null,
      executeRaw: async () => [],
      resolveAliases: async () => new Map(),
      getPage: async () => null,
      getContentFlagsByPageIds: async () => new Map(),
      getUnverifiedExtractionPageIds: async () => new Map(),
      relationalFanout: async () => [],
      searchVector: async () => [],
      searchKeyword: () => Promise.reject(keywordError),
      searchTitles: async () => [] as SearchResult[],
    } as unknown as BrainEngine;
  }

  async function run(err: Error) {
    _resetWarnOnceForTests();
    let meta: HybridSearchMeta | undefined;
    const { warned } = await captureWarn(() => hybridSearch(fakeEngine(err), 'orchard telemetry notes', { limit: 5, onMeta: m => { meta = m; } }));
    return { degraded: meta?.degraded ?? [], warned: warned.join('\n') };
  }

  test('SQLSTATE 57014 → keyword_arm_failed: timeout, warning names search.statement_timeout_ms', async () => {
    const err = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const { degraded, warned } = await run(err);
    expect(degraded).toContainEqual({ stage: 'keyword_arm_failed', reason: 'timeout' });
    expect(warned).toContain(`gbrain config set ${KEY} <ms>`);
  });

  test('any other failure stays provider_error without the key hint', async () => {
    const { degraded, warned } = await run(new Error('relation "content_chunks" does not exist'));
    expect(degraded).toContainEqual({ stage: 'keyword_arm_failed', reason: 'provider_error' });
    expect(warned).not.toContain(KEY);
  });
});
