/**
 * Agent contract v1 (Lane B): small builders op handlers use to attach a
 * filled, surface-correct next step to an `OperationError`.
 *
 * Type-only import of agent-output: ops sit in the PGLite snapshot-schema
 * import closure, so this module builds plain `Action` objects and never pulls
 * the renderer's runtime graph in. `command`/`next` are computed at render
 * time (agent-output.ts), never here.
 */
import type { Action, Effect, McpCall, Transport } from '../agent-output.ts';
import type { RegistryCode } from '../error-registry.ts';
import { opError, type OperationContext, type OperationError, type ParamDef } from './contract.ts';

type TransportCtx = Pick<OperationContext, 'remote' | 'transport'>;

/** The caller's surface: the trusted local CLI, or an MCP transport. */
export function opTransport(ctx: TransportCtx): Transport {
  if (ctx.remote === false) return 'cli';
  return ctx.transport === 'http' ? 'http' : 'stdio';
}

/**
 * How the caller passes one parameter on its own surface: `--no-pull` /
 * `--limit 20` on the CLI, `no_pull: true` / `limit: 20` over MCP.
 */
export function paramUse(ctx: TransportCtx, param: string, value: unknown = true): string {
  if (opTransport(ctx) === 'cli') {
    const flag = `--${param.replace(/_/g, '-')}`;
    return value === true ? flag : `${flag} ${typeof value === 'string' ? value : JSON.stringify(value)}`;
  }
  return `${param}: ${JSON.stringify(value)}`;
}

/** A read-only diagnostic step the agent can run itself (`mcp` is dropped at render unless callable). */
export function readFix(why: string, step: { argv?: string[]; mcp?: McpCall }): Action {
  return {
    ...(step.argv ? { argv: step.argv } : {}),
    ...(step.mcp ? { mcp: step.mcp } : {}),
    consent: [], actor: 'agent', why, requires_exclusive: false,
  };
}

/**
 * B6: a step only the trusted CLI on the brain host can run. Over MCP the
 * agent cannot run it: the user (stdio: same machine) or the host admin
 * (http) does, and `user_message` is the relay text.
 */
export function hostFix(
  ctx: TransportCtx,
  argv: string[],
  why: string,
  opts: { consent?: Effect[]; requires_exclusive?: boolean; user_message?: string } = {},
): Action {
  const transport = opTransport(ctx);
  const actor = transport === 'cli' ? 'agent' : transport === 'http' ? 'host_admin' : 'user';
  const relay = transport === 'http'
    ? 'This needs the gbrain CLI on the machine that hosts this brain. Please ask whoever runs that server to run the command shown.'
    : 'This needs the gbrain CLI in a terminal on this machine. Please run the command shown.';
  return {
    argv, consent: opts.consent ?? [], actor, why,
    ...(transport === 'cli' && opts.user_message === undefined ? {} : { user_message: opts.user_message ?? relay }),
    requires_exclusive: opts.requires_exclusive ?? false,
  };
}

/** A refusal whose next step is a host-only command (B6): suggestion + filled fix in one call. */
export function hostOnlyError(
  ctx: TransportCtx,
  code: RegistryCode,
  message: string,
  argv: string[],
  why: string,
  opts: { consent?: Effect[]; requires_exclusive?: boolean; suggestion?: string; legacy_error?: string; reason?: string } = {},
): OperationError {
  const who = opTransport(ctx) === 'http' ? 'the brain host operator' : 'the user, in a terminal on the brain host';
  const suggestion = opts.suggestion ?? (opTransport(ctx) === 'cli'
    ? 'Run the command in fix.'
    : `Only the trusted local CLI can do this; ${who} runs the command in fix.`);
  return opError(code, message, suggestion, {
    fix: hostFix(ctx, argv, why, opts),
    ...(opts.legacy_error ? { legacy_error: opts.legacy_error } : {}),
    ...(opts.reason ? { reason: opts.reason } : {}),
  });
}

function exampleValue(def: ParamDef | undefined, choices: readonly string[] | undefined): unknown {
  if (choices?.length) return choices[0];
  if (def?.default !== undefined) return def.default;
  switch (def?.type) {
    case 'number': return 10;
    case 'boolean': return true;
    case 'array': return [];
    case 'object': return {};
    default: return 'value';
  }
}

/**
 * B2/B3: `invalid_params` naming the parameter on the caller's surface, its
 * valid choices (or type and description) and one example call. The caller's
 * raw value is never echoed (messages can be persisted to request logs).
 */
export function invalidParam(
  ctx: TransportCtx,
  tool: string,
  param: string,
  message: string,
  opts: { choices?: readonly string[]; example?: unknown; def?: ParamDef; legacy_error?: string } = {},
): OperationError {
  const example = opts.example ?? exampleValue(opts.def, opts.choices ?? opts.def?.enum);
  const choices = opts.choices ?? opts.def?.enum;
  const cli = opTransport(ctx) === 'cli';
  const name = cli ? `--${param.replace(/_/g, '-')}` : `\`${param}\``;
  const what = choices?.length
    ? `one of: ${choices.join(', ')}`
    : `a ${opts.def?.type ?? 'value'}${opts.def?.description ? ` (${opts.def.description.replace(/\.$/, '')})` : ''}`;
  const call = cli ? paramUse(ctx, param, example) : `${tool} {"${param}": ${JSON.stringify(example)}}`;
  return opError('invalid_params', message, `Pass ${name} as ${what}. Example: ${call}.`,
    opts.legacy_error ? { legacy_error: opts.legacy_error } : {});
}
