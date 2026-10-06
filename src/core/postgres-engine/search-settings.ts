/**
 * Session settings for the Postgres search statements (#6039).
 *
 * JIT off. The search statements (keyword, keyword chunks, CJK, title,
 * vector candidates and the vector `hasMore` witness) are short interactive
 * reads, but their correlated visibility subplans inflate the planner's cost
 * estimate past `jit_above_cost` (100k by default) and, on the vector and
 * common-term statements, past the inlining and optimization thresholds
 * (500k). Postgres then compiles the statement with LLVM on every call, and
 * compilation, not execution, dominates its latency: on a 20k-page brain the
 * remote keyword statement spent 58 of 61 ms compiling and the remote vector
 * candidate statement 990 of 1,394 ms. JIT never pays back on a statement
 * that executes in milliseconds.
 *
 * `SET LOCAL` ends with a top-level transaction. Inside a caller's
 * transaction the search runs in a savepoint, and a released savepoint keeps
 * the setting, so the caller's `jit` and `statement_timeout` are restored
 * afterwards; a failed search rolls the savepoint back, which reverts them too.
 *
 * Statement timeout. The lexical arms (keyword, keyword chunks, CJK, title)
 * bound each statement with `search.statement_timeout_ms` (DB plane, whole
 * milliseconds 1..60000, default 8000; no env override). The value is read
 * before the search transaction opens, so it never takes a second pool slot,
 * memoized per engine for 60 s, and bound through `set_config` as a parameter.
 * The vector arm keeps its own deadline.
 *
 * Postgres only: PGLite has no JIT provider and no statement timeout here.
 */
import type postgres from '#postgres';

export const SEARCH_STATEMENT_TIMEOUT_KEY = 'search.statement_timeout_ms';
export const SEARCH_STATEMENT_TIMEOUT_DEFAULT_MS = 8000;
export const SEARCH_STATEMENT_TIMEOUT_MAX_MS = 60_000;
const MEMO_MS = 60_000;

/** A whole number of milliseconds from 1 to 60000, else null. */
export function parseSearchStatementTimeoutMs(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const ms = Number(t);
  return ms >= 1 && ms <= SEARCH_STATEMENT_TIMEOUT_MAX_MS ? ms : null;
}

/** One engine's resolver: `resolve(read)` returns the Postgres interval text (`8000ms`). */
export class SearchStatementTimeout {
  private memo: { value: string; at: number } | null = null;
  private warned = false;

  async resolve(read: (key: string) => Promise<string | null>): Promise<string> {
    const now = Date.now();
    if (this.memo && now - this.memo.at < MEMO_MS) return this.memo.value;
    let ms = SEARCH_STATEMENT_TIMEOUT_DEFAULT_MS;
    try {
      const raw = await read(SEARCH_STATEMENT_TIMEOUT_KEY);
      const parsed = raw === null ? null : parseSearchStatementTimeoutMs(raw);
      if (parsed !== null) ms = parsed;
      else if (raw !== null && !this.warned) {
        this.warned = true;
        console.warn(`[gbrain] ${SEARCH_STATEMENT_TIMEOUT_KEY} is not a whole number of milliseconds from 1 to ${SEARCH_STATEMENT_TIMEOUT_MAX_MS}, so lexical search uses the default ${SEARCH_STATEMENT_TIMEOUT_DEFAULT_MS} ms. ` +
          `Fix: gbrain config set ${SEARCH_STATEMENT_TIMEOUT_KEY} <ms> (or gbrain config unset ${SEARCH_STATEMENT_TIMEOUT_KEY}).`);
      }
    } catch {
      // A config read failure never takes search down: use the default now and read again next call.
      return `${ms}ms`;
    }
    this.memo = { value: `${ms}ms`, at: now };
    return this.memo.value;
  }
}

// engine-sql-ok: jit and statement_timeout are Postgres server settings
export async function withSearchSettings<T>(tx: ReturnType<typeof postgres>, nested: boolean, run: () => Promise<T>): Promise<T> {
  const previous = nested ? await tx`SELECT current_setting('jit') AS jit, current_setting('statement_timeout') AS statement_timeout` : [];
  await tx`SET LOCAL jit = off`;
  const result = await run();
  if (nested) await tx`SELECT set_config('jit', ${previous[0]!.jit}, true), set_config('statement_timeout', ${previous[0]!.statement_timeout}, true)`;
  return result;
}
