/**
 * `config set search.statement_timeout_ms` accepts whole milliseconds from 1
 * to 60000 only; anything else is a usage error (exit 2) and nothing is
 * written. The engine reads the key through postgres-engine/search-settings.ts,
 * which uses the 8000 ms default (with a warning naming the key) for a stored
 * value outside that range.
 */
import {
  SEARCH_STATEMENT_TIMEOUT_DEFAULT_MS, SEARCH_STATEMENT_TIMEOUT_KEY, SEARCH_STATEMENT_TIMEOUT_MAX_MS, parseSearchStatementTimeoutMs,
} from '../../core/postgres-engine/search-settings.ts';
import { exitCliError, usageError } from '../../cli/cli-error.ts';

export function refuseInvalidSearchStatementTimeout(key: string, value: string): void {
  if (key !== SEARCH_STATEMENT_TIMEOUT_KEY || parseSearchStatementTimeoutMs(value) !== null) return;
  const range = `a whole number of milliseconds from 1 to ${SEARCH_STATEMENT_TIMEOUT_MAX_MS}`;
  exitCliError(usageError(
    `${key} must be ${range}. Nothing was written.`,
    `Set ${range}, for example gbrain config set ${key} ${SEARCH_STATEMENT_TIMEOUT_DEFAULT_MS} (the default).`,
    {
      why: `The value bounds every Postgres lexical search statement; 0 would remove the bound and more than ${SEARCH_STATEMENT_TIMEOUT_MAX_MS} ms lets one search hold a connection too long.`,
      fix: {
        argv: ['gbrain', 'config', 'set', key, '<MS>'],
        inputs: [{ name: 'MS', how: `A whole number of milliseconds from 1 to ${SEARCH_STATEMENT_TIMEOUT_MAX_MS} (default ${SEARCH_STATEMENT_TIMEOUT_DEFAULT_MS}).` }],
        consent: [],
        actor: 'agent',
        why: 'Stores a timeout lexical search can use.',
        verify: { argv: ['gbrain', 'config', 'get', key] },
        requires_exclusive: false,
      },
    },
  ), 'config');
}
