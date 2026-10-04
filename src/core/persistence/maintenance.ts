import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, releaseLock } from '../pglite-lock.ts';
import { assertManagedFilesystemWrite } from './filesystem-guard.ts';
import { opError } from '../ops/contract.ts';
import type { Action } from '../agent-output.ts';
import type { SqlEngine } from './model.ts';

// Every facts-family bulk writer now publishes through the coordinator on a
// managed brain (#5280); status and activation keep reporting the (empty) list.
export const UNSUPPORTED_MANAGED_BULK_WRITERS: readonly string[] = [];

export const ENGINE_MIGRATION_DOCS = 'docs/ENGINES.md#engine-migration-refused';
const DOCTOR_VERIFY = { argv: ['gbrain', 'doctor', '--no-migrate', '--json'] };
type EngineKind = 'pglite' | 'postgres';
/** Which side of `gbrain migrate --to` a refusal names: the brain being moved, or the datastore it would land in. */
export interface EngineMigrationSide { side: 'source' | 'target'; from: EngineKind; to: EngineKind }

/**
 * The refusal's next step, by side. A PGLite brain moving up gets the user's
 * choice: wait for verified graduation, or stay on PGLite and share it over
 * MCP. A Postgres brain moving down keeps its datastore. A target that
 * already holds persistence state needs an empty database.
 */
function engineMigrationFix(m: EngineMigrationSide, why: string): Action {
  if (m.side === 'target') {
    return { argv: ['gbrain', 'migrate', '--to', m.to, ...(m.to === 'postgres' ? ['--url', '<empty_database_url>'] : ['--path', '<empty_brain_path>'])],
      inputs: [m.to === 'postgres'
        ? { name: 'empty_database_url', how: 'Ask the user for the connection string of an empty Postgres database (a new database or project).' }
        : { name: 'empty_brain_path', how: 'Ask the user for a path where no PGLite brain exists yet.' }],
      consent: [], actor: 'user', requires_exclusive: true, docs: ENGINE_MIGRATION_DOCS, verify: DOCTOR_VERIFY,
      why: `${why} The migration target already holds another brain's write history, so gbrain will not copy into it; the source brain is untouched.`,
      user_message: 'The database you chose to migrate into already holds another gbrain brain. Do you have an empty database to use instead? Nothing has changed in your current brain.' };
  }
  if (m.from === 'postgres') {
    return { consent: [], actor: 'agent', requires_exclusive: false, docs: ENGINE_MIGRATION_DOCS, verify: DOCTOR_VERIFY,
      why: `${why} Moving a Postgres brain with this history to PGLite would drop it, so the brain stays on Postgres; nothing changed.`,
      user_message: 'Your brain stays on Postgres: moving it to PGLite would lose its write history and withdrawn facts. Nothing changed.' };
  }
  return { argv: ['gbrain', 'mcp', 'expose'], consent: ['persistent_install', 'egress'], actor: 'agent', requires_exclusive: false,
    docs: ENGINE_MIGRATION_DOCS, verify: DOCTOR_VERIFY,
    why: `${why} A verified PGLite-to-Postgres graduation that carries this history is not available yet. Until it is, the brain stays on PGLite; `
      + '`gbrain mcp expose` shares it with agents on other machines without moving it.',
    user_message: 'Your brain cannot move to Postgres yet without losing its write history and withdrawn facts. '
      + 'Should I keep it on PGLite and share it with your other machines over MCP (gbrain mcp expose), or leave it as it is until graduation to Postgres is available? Nothing has changed.' };
}

/** Refuse unsupported multi-stage writers before providers, files or git change. */
export async function assertUnmanagedCanonicalWriter(engine: SqlEngine, operation: string, opts: { migration?: EngineMigrationSide } = {}): Promise<void> {
  const rows = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  if (!rows?.[0]?.enabled) return;
  const message = `${operation} cannot mutate a managed brain through the legacy writer.`;
  const why = 'This brain is managed: every write goes through its writer coordinator, which the legacy writer bypasses.';
  if (opts.migration) {
    throw opError('writer_coordinator_required', message,
      'Keep this datastore; the engine copier cannot carry a managed brain. Ask the user how to proceed.',
      { why, reason: 'managed_brain', docs: ENGINE_MIGRATION_DOCS, fix: engineMigrationFix(opts.migration, why) });
  }
  throw opError('writer_coordinator_required', message,
    `Run the same gbrain command again: it routes a managed brain through the coordinator, and the brain became managed while ${operation} ran.`,
    { why, reason: 'managed_brain', fix: { consent: [], actor: 'agent', requires_exclusive: false, verify: DOCTOR_VERIFY,
      why: `${why} Each gbrain command that changes sources or imports content takes the coordinated path on a managed brain, so the same command run again uses it; nothing was written.`,
      user_message: `gbrain stopped ${operation} because your brain switched to managed writes while it ran. Nothing was written; running the same command again uses the managed path.` } });
}

/** The legacy engine copier cannot transfer permanent IDs, withdrawals or ownership. */
export async function assertLegacyEngineMigration(engine: SqlEngine, migration: EngineMigrationSide = { side: 'source', from: 'pglite', to: 'postgres' }): Promise<void> {
  const tables = ['persistence_requests', 'fact_withdrawals', 'persistence_worktrees'] as const;
  // Older migration sources can predate these tables. Do not interpret any
  // other database failure as an empty history.
  const present = await engine.executeRaw<{ name: string }>(
    'SELECT name FROM unnest($1::text[]) AS t(name) WHERE to_regclass(name) IS NOT NULL', [tables]);
  for (const table of tables) {
    if (!present.some(row => row.name === table)) continue;
    const [row] = await engine.executeRaw<{ present: boolean }>(`SELECT EXISTS(SELECT 1 FROM ${table}) AS present`);
    if (!row?.present) continue;
    const why = `The ${migration.side === 'source' ? 'brain' : 'target datastore'} has rows in ${table}, and the engine copier cannot carry request IDs, withdrawals or canonical ownership.`;
    throw opError('writer_coordinator_required',
      'Engine migration cannot discard durable write history, withdrawal protection, or canonical ownership.',
      migration.side === 'target' ? 'Choose an empty target database; the source brain is unchanged.'
        : 'Keep this datastore; nothing changed. Ask the user how to proceed.',
      { why, reason: 'persistence_history', docs: ENGINE_MIGRATION_DOCS, fix: engineMigrationFix(migration, why) });
  }
}

/** Legacy reinit may rename only after acquiring the stable sibling kernel lock. */
export async function backupUnmanagedPglite(dataDir: string, backupDir: string): Promise<void> {
  assertManagedFilesystemWrite(dataDir);
  if (!existsSync(dataDir) || existsSync(backupDir)) throw new Error('PGLite backup paths changed; inspect before retrying.');
  const lock = await acquireLock(dataDir, { timeoutMs: 0 });
  try {
    assertManagedFilesystemWrite(dataDir);
    if (existsSync(backupDir)) throw new Error('PGLite backup already exists; inspect before retrying.');
    renameSync(dataDir, backupDir);
    // Metadata moved with the old datastore. Remove only this ticket's marker;
    // release still targets the original stable sibling native lock.
    lock.lockDir = join(backupDir, '.gbrain-lock');
  } finally { await releaseLock(lock); }
}
