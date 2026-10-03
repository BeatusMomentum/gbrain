/**
 * The one callability predicate (agent operator contract v1, A2): tools/list
 * on stdio and HTTP and dispatch all ask the same question, and fixes/notices
 * name an MCP tool only when it answers true for the caller
 * (`RenderContext.isCallable`). Pure: the caller resolves its own scopes,
 * publish gates and bound-tool allow-set first.
 */
import type { Operation } from './contract.ts';
import type { Surface, Transport } from '../agent-output.ts';
import { operationScopesAllowed } from '../scope.ts';
import { filterOpsForSurface } from '../../mcp/surface.ts';

export interface CallableContext {
  transport: Transport;
  surface: Surface;
  /** Verified scopes for this connection (HTTP token / stdio registration grant). Ignored on cli. */
  scopes: readonly string[];
  /** Resolved publish gates keyed by `Operation.publishGateKey`; a missing key is off (fail-closed). */
  publishGates: Record<string, boolean>;
  /** Extra fail-closed allow-set (read-only stdio, bound-client tool list). */
  allowedOps?: ReadonlySet<string>;
}

/** The one predicate behind tools/list AND dispatch. */
export function isCallable(op: Operation, ctx: CallableContext): boolean {
  if (ctx.allowedOps && !ctx.allowedOps.has(op.name)) return false;
  if (filterOpsForSurface([op], ctx.surface).length === 0) return false;
  if (ctx.transport === 'cli') return true;
  if (op.localOnly && ctx.transport !== 'stdio') return false;
  if (op.publishGateKey && ctx.publishGates[op.publishGateKey] !== true) return false;
  if (ctx.transport === 'http') return operationScopesAllowed(ctx.scopes, op);
  return !op.requiredScopes?.length || operationScopesAllowed(ctx.scopes, op);
}
