/**
 * Consent primitive (agent operator contract v1, A4). CLI command handlers
 * call `requireConsent()` before paid, destructive, credential, egress or
 * persistent-install work. It resolves with the Authorization that covers the
 * request or throws `confirmation_required` (exit 3) carrying the consent
 * payload. Core library paths never prompt: they take an Authorization.
 *
 * Consent honesty: an agent can always pass `--yes`. This gate forces a stop
 * and supplies relay text; it cannot prove a human agreed.
 */
import { CONTRACT_VERSION, renderAction, shellQuote, type Action, type Actor, type Effect, type RenderContext, type RenderedAction } from './agent-output.ts';
import { opError } from './ops/contract.ts';

export type CapSource = 'derived' | 'default' | 'user';

export interface Authorization {
  consented_effects: Effect[];
  /** null only when no paid effect. */
  cap_usd: number | null;
  cap_source: CapSource | null;
  via: 'yes' | 'max_usd' | 'tokenmax' | 'preapproval' | 'apply_flag' | 'non_interactive_flag' | 'tty_prompt';
  /** destructive: binds the persisted approved selection. */
  approval_token?: string;
}

export interface ConsentRequest {
  command: string;
  effects: Effect[];
  actor: Actor;
  what: string; why: string; risk: string;
  user_message: string;
  /** The exact command that runs once approved. */
  argv: string[];
  preview_argv?: string[];
  est_usd?: number | null;
  plan_hash?: string;
  /** destructive: persisted with the approval (A4 destructive rail). */
  selection?: unknown;
  /** Raw argv, for --yes/--max-usd/--expect/--apply/--trust/--non-interactive. */
  args: readonly string[];
}

/** CLI command handlers only. Resolves with the authorization or throws OperationError('confirmation_required'). */
export async function requireConsent(req: ConsentRequest): Promise<Authorization> {
  if (req.effects.length === 0) return { consented_effects: [], cap_usd: null, cap_source: null, via: 'yes' };
  if (req.args.includes('--yes')) {
    return { consented_effects: [...req.effects], cap_usd: null, cap_source: null, via: 'yes' };
  }
  throw opError('confirmation_required', `${req.what} needs the user's approval before it runs; nothing was changed.`,
    req.user_message, { why: req.why });
}

/** The exit-3 `--json` document (and the data behind the human `[AGENT]` block). */
export interface ConfirmationPayload {
  status: 'confirmation_required';
  error: 'confirmation_required';
  code: 'confirmation_required';
  message: string;
  suggestion: string;
  effects: Effect[];
  actor: Actor;
  why: string;
  risk: string;
  est_usd: number | null;
  user_message: string;
  fix: RenderedAction;
  preview: { argv: string[]; command: string } | null;
  plan_hash?: string;
  preapprove_argv?: string[];
  docs_cmd: string[];
  contract_version: 1;
}

/**
 * Destructive approvals bind the plan: the approved command already carries
 * `--yes --expect <plan_hash>`. Paid payloads offer a per-run preapproval;
 * destructive ones never do.
 */
export function confirmationPayload(req: ConsentRequest, ctx: RenderContext): ConfirmationPayload {
  const destructive = req.effects.includes('destructive');
  const argv = [...req.argv];
  if (!argv.includes('--yes')) argv.push('--yes');
  if (destructive && req.plan_hash && !argv.includes('--expect')) argv.push('--expect', req.plan_hash);
  const fix: Action = {
    argv, consent: [...req.effects], actor: req.actor, why: req.why, user_message: req.user_message,
    requires_exclusive: false,
    ...(req.preview_argv ? { preview_argv: req.preview_argv } : {}),
    ...(req.plan_hash ? { plan_hash: req.plan_hash } : {}),
  };
  const rendered = renderAction(fix, ctx);
  const paid = req.effects.includes('paid');
  return {
    status: 'confirmation_required',
    error: 'confirmation_required',
    code: 'confirmation_required',
    message: `${req.what} needs the user's approval before it runs; nothing was changed.`,
    suggestion: `Ask the user: ${req.user_message} If they agree, run: ${rendered.command}`,
    effects: [...req.effects],
    actor: req.actor,
    why: req.why,
    risk: req.risk,
    est_usd: req.est_usd ?? null,
    user_message: req.user_message,
    fix: rendered,
    preview: req.preview_argv ? { argv: req.preview_argv, command: shellQuote(req.preview_argv) } : null,
    ...(req.plan_hash ? { plan_hash: req.plan_hash } : {}),
    ...(paid && !destructive ? { preapprove_argv: ['gbrain', 'config', 'set', 'consent.preapprove.paid.max_usd_per_run', '<usd>'] } : {}),
    docs_cmd: ['gbrain', 'errors', 'confirmation_required'],
    contract_version: CONTRACT_VERSION,
  };
}
