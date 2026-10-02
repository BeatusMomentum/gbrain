/**
 * Legacy bearer-token grants (`gbrain auth rescope-token`), the token twin of
 * `auth rescope-client`. Three axes live in `access_tokens.permissions`:
 *
 *   - `source_id`          (`--sources a,b|none`): array, element 0 = write source
 *   - `takes_holders`      (`--takes-holders a,b|none`)
 *   - `allowed_operations` (`--operations a,b|none`, `--refresh-operations`)
 *
 * `none` stores the explicit empty list (deny-all). An omitted flag preserves
 * the stored value. `--reset-default <axes>` restores the `auth create`
 * default for the named axes (no source grant → the historical `default`
 * floor; takes holders `['world']`; no operation snapshot). Every other key in
 * `permissions` is preserved. `--refresh-operations` only previews unless
 * `--add <op,...>` or `--all-new` names the operations to widen by. With no
 * grant flag the command only prints the stored grants.
 */
import type { BrainEngine } from '../engine.ts';
import { coerceLegacyPermissions, normalizeTokenScopes, parseLegacyOperationGrant, parseLegacyTokenScope, parseTakesHoldersAllowList } from '../legacy-token-scope.ts';
import { NO_SOURCES, isValidSourceId } from '../source-id.ts';
import { operationScopesAllowed } from '../scope.ts';
import { executeRawJsonb } from '../sql-query.ts';
import { TOKEN_ID_RE } from '../token-mint.ts';
import { GrantError } from './model.ts';

export type LegacyGrantAxis = 'sources' | 'takes-holders' | 'operations';
const AXES: readonly LegacyGrantAxis[] = ['sources', 'takes-holders', 'operations'];

export interface RescopeTokenArgs {
  target: { name: string } | { id: string };
  sources?: string[];
  takesHolders?: string[];
  operations?: string[];
  reset: LegacyGrantAxis[];
  refreshOperations: boolean;
  add?: string[];
  allNew: boolean;
  dryRun: boolean;
  json: boolean;
}

export interface LegacyTokenGrantView {
  sources: string[] | 'default';
  takesHolders: string[];
  operations: string[] | 'unrestricted';
}

export interface RescopeTokenResult {
  id: string;
  name: string;
  dryRun: boolean;
  changed: boolean;
  before: LegacyTokenGrantView;
  after: LegacyTokenGrantView;
  refresh?: { available: string[]; added: string[]; unregistered: string[] };
}

const csvOrNone = (value: string): string[] =>
  value === 'none' ? [] : [...new Set(value.split(',').map(s => s.trim()).filter(Boolean))];

export function parseRescopeTokenArgs(args: string[]): RescopeTokenArgs {
  let target: RescopeTokenArgs['target'] | undefined;
  const out: Omit<RescopeTokenArgs, 'target'> = { reset: [], refreshOperations: false, allNew: false, dryRun: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--dry-run') { out.dryRun = true; continue; }
    if (flag === '--json') { out.json = true; continue; }
    if (flag === '--refresh-operations') { out.refreshOperations = true; continue; }
    if (flag === '--all-new') { out.allNew = true; continue; }
    if (!flag.startsWith('--')) {
      if (target) throw new GrantError('invalid_grant', `Unexpected argument: ${flag}`);
      target = { name: flag };
      continue;
    }
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new GrantError('invalid_grant', `${flag} requires a value`);
    switch (flag) {
      case '--id':
        if (target) throw new GrantError('invalid_grant', 'Pass either a token name or --id, not both');
        if (!TOKEN_ID_RE.test(value)) throw new GrantError('invalid_grant', '--id must be a token id from `gbrain auth list`');
        target = { id: value };
        break;
      case '--sources': out.sources = csvOrNone(value); break;
      case '--takes-holders': out.takesHolders = csvOrNone(value); break;
      case '--operations': out.operations = csvOrNone(value); break;
      case '--add': out.add = csvOrNone(value); break;
      case '--reset-default':
        for (const axis of csvOrNone(value)) {
          if (!(AXES as readonly string[]).includes(axis)) throw new GrantError('invalid_grant', `--reset-default takes ${AXES.join(', ')}`);
          out.reset.push(axis as LegacyGrantAxis);
        }
        break;
      default: throw new GrantError('invalid_grant', `Unknown flag: ${flag}`);
    }
  }
  if (!target) throw new GrantError('invalid_grant', 'Name the token to rescope (or pass --id <uuid>)');
  const set = { sources: out.sources, 'takes-holders': out.takesHolders, operations: out.operations };
  for (const axis of out.reset) {
    if (set[axis] !== undefined) throw new GrantError('invalid_grant', `--reset-default ${axis} conflicts with --${axis}`);
  }
  if ((out.add || out.allNew) && !out.refreshOperations) throw new GrantError('invalid_grant', '--add and --all-new require --refresh-operations');
  if (out.add && out.allNew) throw new GrantError('invalid_grant', 'Pass either --add or --all-new, not both');
  if (out.refreshOperations && (out.operations !== undefined || out.reset.includes('operations'))) {
    throw new GrantError('invalid_grant', '--refresh-operations cannot be combined with --operations or --reset-default operations');
  }
  return { target, ...out };
}

function view(permissions: Record<string, unknown>): LegacyTokenGrantView {
  const scope = parseLegacyTokenScope(permissions.source_id);
  const operations = parseLegacyOperationGrant(permissions.allowed_operations);
  return {
    sources: permissions.source_id == null ? 'default'
      : scope.sourceId === NO_SOURCES ? [] : scope.allowedSources ?? [scope.sourceId],
    takesHolders: parseTakesHoldersAllowList(permissions.takes_holders) ?? ['world'],
    operations: operations ?? 'unrestricted',
  };
}

/** Remote operations a token with these scopes could call: the refresh candidate set. */
async function grantableOperations(scopes: string[]): Promise<{ all: Set<string>; grantable: string[] }> {
  const { operations } = await import('../operations.ts');
  const remote = operations.filter(op => !op.localOnly);
  return {
    all: new Set(remote.map(op => op.name)),
    grantable: remote.filter(op => operationScopesAllowed(scopes, op)).map(op => op.name).sort(),
  };
}

async function assertActiveSources(engine: BrainEngine, ids: string[]): Promise<void> {
  for (const id of ids) {
    if (!isValidSourceId(id)) throw new GrantError('invalid_grant', `Invalid source id: ${id}`);
  }
  if (ids.length === 0) return;
  const rows = await engine.executeRaw<{ id: string }>(
    'SELECT id FROM sources WHERE id = ANY($1::text[]) AND archived IS NOT TRUE', [ids]);
  const active = new Set(rows.map(r => r.id));
  const missing = ids.filter(id => !active.has(id));
  if (missing.length) throw new GrantError('invalid_grant', `Unknown or archived source: ${missing.join(', ')} (see gbrain sources list)`);
}

export async function rescopeLegacyToken(engine: BrainEngine, args: RescopeTokenArgs): Promise<RescopeTokenResult> {
  return engine.transaction(async tx => {
    const rows = 'id' in args.target
      ? await tx.executeRaw<Record<string, unknown>>('SELECT id, name, scopes, permissions FROM access_tokens WHERE id = $1::uuid AND revoked_at IS NULL FOR UPDATE', [args.target.id])
      : await tx.executeRaw<Record<string, unknown>>('SELECT id, name, scopes, permissions FROM access_tokens WHERE name = $1 AND revoked_at IS NULL FOR UPDATE', [args.target.name]);
    const label = 'id' in args.target ? `id ${args.target.id}` : `"${args.target.name}"`;
    if (rows.length === 0) throw new GrantError('invalid_grant', `No active token ${label} (see gbrain auth list)`);
    if (rows.length > 1) throw new GrantError('invalid_grant', `${rows.length} active tokens are named ${label}; pass --id <uuid> from gbrain auth list`);
    const row = rows[0];
    const current = coerceLegacyPermissions(row.permissions) ?? {};
    const next: Record<string, unknown> = { ...current };

    if (args.sources !== undefined) {
      await assertActiveSources(tx, args.sources);
      next.source_id = args.sources;
    }
    if (args.takesHolders !== undefined) next.takes_holders = args.takesHolders;
    let refresh: RescopeTokenResult['refresh'];
    const { all, grantable } = await grantableOperations(normalizeTokenScopes(row.scopes) ?? ['read', 'write', 'admin']);
    if (args.operations !== undefined) {
      const unknown = args.operations.filter(op => !all.has(op));
      if (unknown.length) throw new GrantError('invalid_grant', `Unknown remote operation: ${unknown.join(', ')}`);
      next.allowed_operations = args.operations;
    }
    for (const axis of args.reset) {
      if (axis === 'sources') delete next.source_id;
      if (axis === 'takes-holders') next.takes_holders = ['world'];
      if (axis === 'operations') delete next.allowed_operations;
    }
    if (args.refreshOperations) {
      const granted = parseLegacyOperationGrant(current.allowed_operations);
      if (granted === undefined) {
        throw new GrantError('invalid_grant', `Token ${label} has no operation snapshot, so it already reaches every operation its scopes allow; nothing to refresh`);
      }
      const available = grantable.filter(op => !granted.includes(op));
      const added = args.allNew ? available : args.add ?? [];
      const notAvailable = added.filter(op => !available.includes(op));
      if (notAvailable.length) throw new GrantError('invalid_grant', `Not a new operation for this token: ${notAvailable.join(', ')} (run --refresh-operations alone to preview)`);
      if (added.length) next.allowed_operations = [...granted, ...added];
      refresh = { available, added, unregistered: granted.filter(op => !all.has(op)) };
    }

    const changed = JSON.stringify(next) !== JSON.stringify(current);
    if (changed && !args.dryRun) {
      await executeRawJsonb(tx, 'UPDATE access_tokens SET permissions = $2::jsonb WHERE id = $1::uuid', [String(row.id)], [next]);
    }
    return { id: String(row.id), name: String(row.name), dryRun: args.dryRun, changed, before: view(current), after: view(next), ...(refresh ? { refresh } : {}) };
  });
}

export function renderLegacyGrantAxis(value: string[] | 'default' | 'unrestricted'): string {
  if (value === 'default') return 'default (no source grant)';
  if (value === 'unrestricted') return 'unrestricted (every operation the scopes allow)';
  return value.length === 0 ? 'none (deny-all)' : value.join(', ');
}
