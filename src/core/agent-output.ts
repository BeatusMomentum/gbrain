/**
 * Agent operator contract v1 (docs/designs/AGENT_OPERATOR_WAVE.md, A0/A1/A6).
 *
 * One `Action` (`fix`) for every failure, refusal, degradation and
 * recommendation; one error envelope (`AgentEnvelope`) for CLI `--json`, MCP
 * `isError` results and HTTP bodies; one notice wire format. `next` and the
 * shell `command` are computed here at render time and never stored.
 *
 * Everything an agent reads is built from static registry templates plus
 * interpolated ids that pass through `inertText()`: newlines and marker
 * tokens are neutralised so a page title can never forge an instruction.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../version.ts';
import { OperationError, __registerOperationErrorRenderer } from './ops/contract.ts';
import { StructuredAgentError } from './errors.ts';
import { canonicalCodeFor, codeEntry, codeClass, codeRetryable, exitCodeForCode } from './error-catalogue.ts';
import { VERB_NAMES } from './verbs.ts';
import { classifyPgAccessError, formatDbAccessMarker } from './pg-access-classify.ts';
import { redactConnectionInfo } from './audit/redact-connection-info.ts';
import { redactUrlsInText } from './url-redact.ts';
import { recordAgentContractEvent } from './agent-contract-log.ts';

export const CONTRACT_VERSION = 1 as const;

export type Effect = 'paid' | 'destructive' | 'credentials' | 'egress' | 'persistent_install';
export type Actor = 'agent' | 'user' | 'host_admin' | 'provider';
export type Next = 'run' | 'ask_user' | 'tell_user_to_run' | 'wait' | 'report';
export type Transport = 'cli' | 'stdio' | 'http';
export type Surface = 'verbs' | 'starter' | 'full';
export type ErrorClass = 'caller' | 'consent' | 'retryable' | 'unavailable' | 'server' | 'host_only';

export interface McpCall { tool: string; arguments: Record<string, unknown> }

/** A value the agent must obtain before running (e.g. a model's price). argv holds `<name>` only for these. */
export interface ActionInput { name: string; how: string }

/** Stored/constructed form. Never carries `next` or `command`: both are computed at render time. */
export interface Action {
  argv?: string[];
  mcp?: McpCall;
  consent: Effect[];
  actor: Actor;
  why: string;
  user_message?: string;
  verify?: { argv?: string[]; mcp?: McpCall };
  docs?: string;
  requires_exclusive: boolean;
  inputs?: ActionInput[];
  plan_hash?: string;
  preview_argv?: string[];
  then?: Action;
}

/** Wire form: what an agent reads. */
export interface RenderedAction extends Omit<Action, 'then' | 'docs'> {
  command?: string;
  next: Next;
  docs?: string;
  then?: RenderedAction;
}

export type NoticeKind = 'safety' | 'degraded' | 'coaching' | 'ask' | 'info';
export interface DecisionOption { id: string; label: string; argv?: string[] }
export interface Decision { id: string; question: string; options: DecisionOption[]; default: string; default_reason: string }

export interface Notice {
  code: string;
  kind: NoticeKind;
  why: string;
  fix?: Action;
  user_message?: string;
  decisions?: Decision[];
}
export interface RenderedNotice extends Omit<Notice, 'fix'> { fix?: RenderedAction; contract_version: 1 }

/** The one error envelope (CLI --json document, MCP isError content[0], HTTP bodies). */
export interface AgentEnvelope {
  error: string;
  code: string;
  reason?: string;
  message: string;
  suggestion: string;
  why?: string;
  fix?: RenderedAction;
  docs?: string;
  docs_cmd: string[];
  class: ErrorClass;
  retryable: boolean;
  notices?: RenderedNotice[];
  contract_version: 1;
  detail?: string; protocol_version?: 1; write_request?: unknown; write_error?: string;
}

export interface RenderContext {
  transport: Transport;
  surface?: Surface;
  isCallable(opName: string): boolean;
  preapproved(effects: Effect[], estUsd?: number | null): boolean;
  principal?: string;
}

export interface AgentErrorContext {
  transport: Transport;
  op?: string;
  command?: string;
  mutating?: boolean;
  idempotent?: boolean;
  outcome?: 'not_started' | 'failed' | 'unknown' | 'committed' | 'pending';
  render: RenderContext;
  /** Additive: the configured DB url + resolved brain id for the GBRAIN_DB_ACCESS classifier row (a mount never reads as host). */
  db?: { url: string | null; brainId?: string };
}

export interface CliErrorRender { stdout?: string; stderr?: string; exitCode: number }

/** Attached to OperationContext (MCP) and the CLI dispatch context. */
export interface NoticeSink { emitNotice(n: Notice): void }

// ── render context defaults ────────────────────────────────────────────────

/** The trusted local CLI: no MCP tool is callable from a shell, nothing is preapproved unless A4 says so. */
export function cliRenderContext(overrides: Partial<RenderContext> = {}): RenderContext {
  return { transport: 'cli', isCallable: () => false, preapproved: () => false, ...overrides };
}

// ── text safety ────────────────────────────────────────────────────────────

const MARKER_RE = /\[(\/?)(AGENT|SHOW USER|gbrain notice)/gi;
const MAX_INLINE = 2_000;

/**
 * Neutralise interpolated text for any agent-visible channel: newlines become
 * spaces and marker tokens lose their opening bracket, so `[/SHOW USER]` in a
 * page title renders as `(/SHOW USER]` and cannot close or open a block.
 */
export function inertText(value: string, max: number = MAX_INLINE): string {
  const flat = value.replace(/\r\n|\r|\n|\u2028|\u2029/g, ' ').replace(MARKER_RE, '($1$2');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const SAFE_SHELL = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX shell quoting; the only way a human `command` string is built. */
export function shellQuote(argv: readonly string[]): string {
  return argv.map(arg => {
    if (arg === '') return "''";
    if (SAFE_SHELL.test(arg)) return arg;
    return `'${inertText(arg).replace(/'/g, `'\\''`)}'`;
  }).join(' ');
}

/**
 * Split a literal shell command that a legacy site stored as a string (F0's
 * refusal `fix`, a `suggestion` that is exactly one command) into argv. Only
 * `gbrain …` commands made of plain or single-quoted words qualify; anything
 * with pipes, substitutions or placeholders returns undefined (prose stays prose).
 */
export function argvFromCommand(command: string): string[] | undefined {
  const s = command.trim().replace(/^`|`$/g, '');
  if (!s.startsWith('gbrain ') && s !== 'gbrain') return undefined;
  const out: string[] = [];
  const re = /\s*(?:'([^']*)'|([^\s'"`$|;&<>()\\]+))/y;
  let i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) return undefined;
    out.push(m[1] ?? m[2]);
    i = re.lastIndex;
    while (i < s.length && s[i] === ' ') i++;
  }
  return out.length ? out : undefined;
}

/** `no_pull: true` on MCP, `--no-pull` on the CLI. */
export function paramRef(ctx: { transport: Transport }, param: string): string {
  return ctx.transport === 'cli' ? `--${param.replace(/_/g, '-')}` : `${param}: true`;
}

// ── docs URLs ──────────────────────────────────────────────────────────────

const REPO_BLOB = 'https://github.com/garrytan/gbrain/blob';
let docsRefOverride: string | null = null;

/** Test seam: pin the ref docsUrl() uses (null restores detection). */
export function __setDocsRefForTests(ref: string | null): void { docsRefOverride = ref; }

function docsRef(): string {
  if (docsRefOverride !== null) return docsRefOverride;
  const root = join(import.meta.dir, '..', '..');
  return existsSync(join(root, '.git')) ? 'master' : `v${VERSION}`;
}

/**
 * Absolute docs URL for a repo-relative anchor (`docs/guides/x.md#y`).
 * Published package → the `v<VERSION>` tag; source checkout → `master`;
 * `LLMS_REPO_BASE` (fork override, same knob as build:llms) wins.
 */
export function docsUrl(anchor: string): string {
  if (/^https?:\/\//.test(anchor)) return anchor;
  const path = anchor.replace(/^\.?\//, '');
  const forkBase = process.env.LLMS_REPO_BASE?.replace(/\/+$/, '');
  return forkBase ? `${forkBase}/${path}` : `${REPO_BLOB}/${docsRef()}/${path}`;
}

// ── next + rendering ───────────────────────────────────────────────────────

/** The published decision table (first matching row wins). */
export function deriveNext(a: Action, ctx: RenderContext): Next {
  const callableMcp = a.mcp !== undefined && ctx.isCallable(a.mcp.tool);
  if (!a.argv?.length && !callableMcp) return 'report';
  if (a.actor === 'provider') return 'wait';
  if (a.actor === 'user' || a.actor === 'host_admin') return 'tell_user_to_run';
  if (ctx.transport !== 'cli' && !callableMcp) return 'tell_user_to_run';
  if (a.consent.length > 0 && (a.consent.includes('destructive') || !ctx.preapproved(a.consent))) return 'ask_user';
  return 'run';
}

function renderVerify(v: Action['verify'], ctx: RenderContext): RenderedAction['verify'] {
  if (!v) return undefined;
  const mcp = v.mcp && ctx.isCallable(v.mcp.tool) ? v.mcp : undefined;
  if (!v.argv && !mcp) return undefined;
  return { ...(v.argv ? { argv: v.argv } : {}), ...(mcp ? { mcp } : {}) };
}

/** Render an Action for the caller's surface. Key order is part of the v1 goldens. */
export function renderAction(a: Action, ctx: RenderContext): RenderedAction {
  const mcp = a.mcp && ctx.isCallable(a.mcp.tool) ? a.mcp : undefined;
  const cliOnlyOnMcp = ctx.transport !== 'cli' && !mcp && a.actor === 'agent' && !!a.argv?.length;
  const actor: Actor = cliOnlyOnMcp ? (ctx.transport === 'http' ? 'host_admin' : 'user') : a.actor;
  const effective: Action = { ...a, mcp, actor };
  const verify = renderVerify(a.verify, ctx);
  const out: RenderedAction = {
    ...(a.argv ? { argv: a.argv, command: shellQuote(a.argv) } : {}),
    ...(mcp ? { mcp } : {}),
    consent: a.consent,
    actor,
    next: deriveNext(effective, ctx),
    why: inertText(a.why),
    ...(a.user_message !== undefined ? { user_message: inertText(a.user_message) } : {}),
    ...(verify ? { verify } : {}),
    ...(a.docs ? { docs: docsUrl(a.docs) } : {}),
    requires_exclusive: a.requires_exclusive,
    ...(a.inputs?.length ? { inputs: a.inputs } : {}),
    ...(a.plan_hash ? { plan_hash: a.plan_hash } : {}),
    ...(a.preview_argv ? { preview_argv: a.preview_argv } : {}),
    ...(a.then ? { then: renderAction(a.then, ctx) } : {}),
  };
  return out;
}

export function renderNotice(n: Notice, ctx: RenderContext): RenderedNotice {
  return {
    code: n.code,
    kind: n.kind,
    why: inertText(n.why),
    ...(n.fix ? { fix: renderAction(n.fix, ctx) } : {}),
    ...(n.user_message !== undefined ? { user_message: inertText(n.user_message) } : {}),
    ...(n.decisions?.length ? { decisions: n.decisions } : {}),
    contract_version: CONTRACT_VERSION,
  };
}

export const NOTICE_PREFIX = '[gbrain notice ';
const NOTICE_KIND_ORDER: readonly NoticeKind[] = ['safety', 'degraded', 'ask', 'coaching', 'info'];

/** Stable order for notice blocks: safety, degraded, ask, coaching, info. */
export function orderNotices<T extends { kind: NoticeKind }>(notices: readonly T[]): T[] {
  return [...notices].sort((a, b) => NOTICE_KIND_ORDER.indexOf(a.kind) - NOTICE_KIND_ORDER.indexOf(b.kind));
}

function renderedStep(fix: RenderedAction): string | undefined {
  if (fix.mcp) return `${fix.mcp.tool} ${JSON.stringify(fix.mcp.arguments)}`;
  return fix.command;
}

/** The MCP extra text block for one notice. First line is the fixed prefix clients key on. */
export function noticeBlock(n: RenderedNotice): string {
  const lines = [`${NOTICE_PREFIX}${n.code} kind=${n.kind}]`, `why: ${n.why}`];
  if (n.fix) {
    const step = renderedStep(n.fix);
    if (step) lines.push(`fix: ${step}`);
    lines.push(`next: ${n.fix.next}`);
  }
  if (n.user_message) lines.push(`user_message: ${n.user_message}`);
  for (const d of n.decisions ?? []) {
    lines.push(`decision ${d.id}: ${inertText(d.question)} (default: ${d.default})`);
  }
  return lines.join('\n');
}

// ── HTTP view ──────────────────────────────────────────────────────────────

const HTTP_DROP_KEYS = new Set(['pid', 'lock_owner', 'path', 'data_dir', 'database_path', 'asset']);
const ABS_PATH_RE = /(?:^|(?<=[\s'"`(=]))(?:\/(?:home|Users|root|tmp|var|private|opt|srv|mnt|etc)\/[^\s'"`)]*|[A-Za-z]:\\[^\s'"`)]*|~\/[^\s'"`)]*)/g;
const PID_RE = /\b(PID|pid)\s*[:=]?\s*\d+/g;
const KEY_NAME_RE = /\b[A-Z][A-Z0-9]*_(?:API_KEY|TOKEN|SECRET)\b/g;

function redactString(s: string): string {
  return s.replace(ABS_PATH_RE, '<path>').replace(PID_RE, '$1 <redacted>').replace(KEY_NAME_RE, '<provider key>');
}

/** One transport-keyed redaction pass: http strips local paths, PIDs, key names and host posture keys. */
export function redactForTransport<T>(value: T, transport: Transport): T {
  if (transport !== 'http') return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (HTTP_DROP_KEYS.has(k)) continue;
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

// ── envelope ───────────────────────────────────────────────────────────────

/** Fields a normaliser row extracts before the shared envelope assembly. */
export interface EnvelopeParts {
  error: string;
  code: string;
  message: string;
  suggestion?: string;
  reason?: string;
  why?: string;
  fix?: Action;
  docs?: string;
  notices?: Notice[];
  detail?: string;
  protocol_version?: 1;
  write_request?: unknown;
  write_error?: string;
  retryable?: boolean;
}

function appendFixToSuggestion(suggestion: string, fix: RenderedAction | undefined): string {
  if (!fix) return suggestion;
  const step = renderedStep(fix);
  if (!step || suggestion.includes(step)) return suggestion;
  const prose = suggestion.trim();
  return prose ? `${prose.replace(/[.\s]*$/, '.')} Next: ${step}` : `Next: ${step}`;
}

/** Assemble the envelope from normalised parts. Legacy keys first, in their historical order. */
export function buildEnvelope(p: EnvelopeParts, ctx: RenderContext): AgentEnvelope {
  const entry = codeEntry(p.code);
  const fix = p.fix ? renderAction(p.fix, ctx) : undefined;
  const suggestion = appendFixToSuggestion(p.suggestion ?? entry?.suggestion ?? '', fix);
  const docs = p.docs ?? entry?.docs ?? `docs/guides/error-codes.md#${p.code}`;
  const notices = p.notices?.length ? orderNotices(p.notices).map(n => renderNotice(n, ctx)) : undefined;
  return {
    error: p.error,
    code: p.code,
    message: p.message,
    suggestion,
    docs: docsUrl(docs),
    ...(p.detail !== undefined ? { detail: p.detail } : {}),
    ...(p.protocol_version !== undefined ? { protocol_version: p.protocol_version } : {}),
    ...(p.write_request !== undefined ? { write_request: p.write_request } : {}),
    ...(p.write_error !== undefined ? { write_error: p.write_error } : {}),
    ...(p.reason !== undefined ? { reason: p.reason } : {}),
    ...(p.why !== undefined ? { why: p.why } : {}),
    ...(fix ? { fix } : {}),
    docs_cmd: ['gbrain', 'errors', p.code],
    class: codeClass(p.code),
    retryable: p.retryable ?? codeRetryable(p.code),
    ...(notices ? { notices } : {}),
    contract_version: CONTRACT_VERSION,
  };
}

const VERB_SET: ReadonlySet<string> = new Set(VERB_NAMES);
const isVerbOp = (ctx: AgentErrorContext) => ctx.op !== undefined && VERB_SET.has(ctx.op);

/** The registry's diagnostic default: doctor on the brain host (MCP run_doctor where callable). */
function diagnosticFix(ctx: AgentErrorContext, why: string): Action {
  const remoteHost = ctx.transport === 'http';
  return {
    argv: ['gbrain', 'doctor', '--json'],
    ...(ctx.render.isCallable('run_doctor') ? { mcp: { tool: 'run_doctor', arguments: {} } } : {}),
    consent: [],
    actor: remoteHost ? 'host_admin' : 'agent',
    why,
    requires_exclusive: false,
  };
}

/**
 * A1 safe-recovery invariant: a mutating op with an unknown or pending
 * outcome is never told to retry. The fix inspects state: the caller's own
 * receipt on its channel, a job's status, or nothing (no receipt → no receipt
 * command; the op's read-side diagnostic stays the fix).
 */
function recoveryFix(p: EnvelopeParts, ctx: AgentErrorContext): Action | undefined {
  const outcomeOpen = ctx.outcome === 'unknown' || ctx.outcome === 'pending';
  if (!ctx.mutating || !outcomeOpen) return undefined;
  const receipt = p.write_request as { request_id?: unknown } | undefined;
  const requestId = typeof receipt?.request_id === 'string' && /^[0-9a-f-]{36}$/i.test(receipt.request_id) ? receipt.request_id : undefined;
  if (!requestId) return undefined;
  const why = 'The write may still commit; its receipt says whether it did. Do not resubmit until the receipt is terminal.';
  if (ctx.transport === 'cli') {
    return { argv: ['gbrain', 'write-request', '--', requestId], consent: [], actor: 'agent', why, requires_exclusive: false };
  }
  return {
    argv: ['gbrain', 'write-request', '--', requestId],
    mcp: { tool: 'get_write_request', arguments: { request_id: requestId } },
    consent: [], actor: 'agent', why, requires_exclusive: false,
  };
}

const REFRESH_REFUSALS: ReadonlySet<string> = new Set([
  'refresh_not_managed', 'refresh_not_owner', 'refresh_no_upstream', 'fetch_failed', 'refresh_diverged', 'refresh_dirty',
  'sync_in_progress', 'refresh_in_progress', 'refresh_drain_timeout', 'refresh_source_changed', 'refresh_recovery_required',
  'worktree_refreshing',
]);

type Row = { match: (e: unknown) => boolean; map: (e: any, ctx: AgentErrorContext) => EnvelopeParts };

/** RemoteMcpError transport reasons (no server envelope) → registry codes. */
const REMOTE_REASON_CODE: Record<string, string> = {
  config: 'config_error', discovery: 'unavailable', auth: 'invalid_token', auth_after_refresh: 'invalid_token',
  'network:timeout': 'timeout', 'network:aborted': 'interrupted', parse: 'internal_error',
};

const named = (name: string) => (e: unknown) => e instanceof Error && e.name === name;

/** The normaliser table: first matching row wins; the last row is the unknown-throw fallback. */
const ROWS: Row[] = [
  {
    match: e => e instanceof OperationError,
    map: (e: OperationError, ctx) => {
      const j = e.toJSON() as Record<string, unknown>;
      let fix = e.fix;
      if (!fix && REFRESH_REFUSALS.has(e.code) && e.suggestion) {
        const argv = argvFromCommand(e.suggestion);
        if (argv) fix = { argv, consent: [], actor: 'agent', why: e.message, requires_exclusive: false };
      }
      return {
        error: e.code, code: canonicalCodeFor(e.canonicalCode), message: e.message, suggestion: e.suggestion,
        reason: e.reason, why: e.why, fix, docs: e.docs, notices: e.notices, detail: e.detail,
        protocol_version: e.protocolVersion === 1 ? 1 : undefined,
        write_request: j.write_request, write_error: e.writeError,
      };
    },
  },
  {
    match: e => e instanceof StructuredAgentError,
    map: (e: StructuredAgentError) => ({
      error: e.envelope.code, code: canonicalCodeFor(e.envelope.code), message: e.envelope.message,
      suggestion: e.envelope.hint, docs: e.envelope.docs_url,
    }),
  },
  {
    match: e => e instanceof Error && (e as { tag?: unknown }).tag === 'BUDGET_EXHAUSTED',
    map: (e: Error & { reason: string; cap: number; pricing?: { model: string; units: string[]; lookup: string; register_command: string } }, ctx) => {
      if (e.reason !== 'no_pricing' || !e.pricing) {
        return { error: 'cost_cap_exceeded', code: 'cost_cap_exceeded', message: e.message, reason: e.reason };
      }
      const argv = argvFromPricing(e.pricing.register_command);
      return {
        error: 'no_pricing', code: 'no_pricing', message: e.message, reason: 'no_pricing',
        suggestion: e.pricing.lookup,
        fix: argv ? {
          argv, consent: [], actor: ctx.transport === 'cli' ? 'agent' : 'host_admin',
          why: 'A cost cap needs a price for every model it covers; registering the rate lets the cap be enforced.',
          requires_exclusive: false,
          inputs: e.pricing.units.map(u => ({ name: u, how: e.pricing!.lookup })),
        } : undefined,
      };
    },
  },
  {
    match: named('RemoteMcpError'),
    map: (e: Error & { reason: string; detail?: Record<string, unknown> }) => {
      const d = e.detail ?? {};
      const wire = typeof d.code === 'string' ? d.code : REMOTE_REASON_CODE[e.reason === 'network' ? `network:${String(d.kind)}` : e.reason] ?? 'unavailable';
      const remoteCode = typeof d.canonical_code === 'string' ? d.canonical_code : canonicalCodeFor(wire);
      return {
        error: wire, code: remoteCode, message: typeof d.message === 'string' ? d.message : e.message,
        suggestion: typeof d.suggestion === 'string' ? d.suggestion : undefined,
        reason: typeof d.reason === 'string' ? d.reason : undefined,
        why: typeof d.why === 'string' ? d.why : undefined,
        docs: typeof d.docs === 'string' ? d.docs : undefined,
        detail: typeof d.server_detail === 'string' ? d.server_detail : undefined,
        protocol_version: d.protocol_version === 1 ? 1 : undefined,
        write_request: d.write_request, write_error: typeof d.write_error === 'string' ? d.write_error : undefined,
        notices: Array.isArray(d.notices) ? d.notices as Notice[] : undefined,
        fix: d.fix && typeof d.fix === 'object' ? d.fix as Action : undefined,
      };
    },
  },
  {
    match: named('CredentialError'),
    map: (e: Error & { code: string; problem: string; cause_text: string; fix: string; doc_url: string }) => ({
      error: e.code, code: e.code, message: e.problem, why: e.cause_text, suggestion: e.fix, docs: e.doc_url,
    }),
  },
  // ── generic rows: the DB classifier runs before these ──
  {
    match: e => named('AIConfigError')(e) || named('AITransientError')(e),
    map: (e: Error & { fix?: string }) => ({
      error: 'unavailable', code: 'unavailable', message: e.message,
      reason: e.name === 'AIConfigError' ? 'ai_config' : 'ai_transient',
      suggestion: e.fix, retryable: e.name === 'AITransientError',
    }),
  },
  {
    match: named('GBrainError'),
    map: (e: Error & { problem: string; cause_description: string; fix: string; docs_url?: string }) => ({
      error: 'config_error', code: 'config_error', message: e.problem,
      why: e.cause_description || undefined, suggestion: e.fix, docs: e.docs_url,
    }),
  },
  {
    match: e => !(e instanceof Error) && !!e && typeof e === 'object'
      && typeof (e as Record<string, unknown>).code === 'string' && typeof (e as Record<string, unknown>).message === 'string'
      && typeof (e as Record<string, unknown>).class === 'string',
    map: (e: { class: string; code: string; message: string; hint?: string }) => ({
      error: e.code, code: canonicalCodeFor(e.code), message: e.message, suggestion: e.hint,
    }),
  },
];

/** Index of the first generic row (AIConfigError); rows before it are typed and beat the DB classifier. */
const FIRST_GENERIC_ROW = ROWS.findIndex(r => r.match(Object.assign(new Error('x'), { name: 'AIConfigError' })));

function argvFromPricing(command: string): string[] | undefined {
  const s = command.replace(/<([a-z0-9-]+)>/gi, 'PLACEHOLDER_$1');
  const argv = argvFromCommand(s);
  return argv?.map(a => a.replace(/^PLACEHOLDER_(.+)$/, '<$1>'));
}

function dbParts(e: unknown, ctx: AgentErrorContext): EnvelopeParts | undefined {
  const d = classifyPgAccessError(e, { url: ctx.db?.url ?? null, brainId: ctx.db?.brainId });
  if (d.reason === 'unknown') return undefined;
  const verb = isVerbOp(ctx);
  if (d.reason === 'schema_missing') {
    return {
      error: 'unavailable', code: 'unavailable', reason: 'schema_missing', message: d.message,
      suggestion: 'Run gbrain apply-migrations on the brain host, then retry.',
      fix: {
        argv: ['gbrain', 'apply-migrations', '--yes'], consent: [], actor: ctx.transport === 'cli' ? 'agent' : 'host_admin',
        why: 'The code expects a table or column this brain does not have yet.', requires_exclusive: true,
        verify: { argv: ['gbrain', 'doctor', '--json'] },
      },
      ...(verb ? { detail: 'schema_missing', protocol_version: 1 as const } : {}),
    };
  }
  return {
    error: verb ? 'unavailable' : 'database_error', code: verb ? 'unavailable' : 'database_error', reason: d.reason,
    message: d.message, suggestion: `${formatDbAccessMarker(d)}. ${d.remediation} Run: gbrain db-repair`,
    fix: {
      argv: ['gbrain', 'db-repair'], consent: [], actor: ctx.transport === 'cli' ? 'agent' : 'host_admin',
      why: 'db-repair diagnoses the database connection without changing anything.', requires_exclusive: false,
    },
    ...(verb ? { detail: d.reason, protocol_version: 1 as const } : {}),
  };
}

function unknownParts(e: unknown, ctx: AgentErrorContext): EnvelopeParts {
  const raw = e instanceof Error ? e.message : String(e);
  let message = raw;
  try { message = redactUrlsInText(redactConnectionInfo(raw)); } catch { /* keep raw */ }
  const where = ctx.op ?? ctx.command ?? 'this operation';
  const verb = isVerbOp(ctx);
  const resubmit = ctx.mutating ? ' The write may have partly run: inspect state before resubmitting.' : '';
  return {
    error: verb ? 'internal' : 'internal_error', code: verb ? 'internal' : 'internal_error',
    message: redactForTransport(message, ctx.transport),
    suggestion: `Server-side failure in ${where}, not a caller mistake.${resubmit} Run \`gbrain doctor --json\` on the brain host; if it repeats, report it to the user.`,
    fix: diagnosticFix(ctx, 'Doctor checks the brain host for the failing dependency.'),
    ...(verb ? { protocol_version: 1 as const } : {}),
  };
}

function genericEnvelope(e: unknown, ctx: AgentErrorContext): AgentEnvelope {
  let message = 'unclassified failure';
  try { message = e instanceof Error ? e.message : String(e); } catch { /* hostile value: keep the placeholder */ }
  const where = ctx.op ?? ctx.command ?? 'this operation';
  return {
    error: 'internal_error', code: 'internal_error', message: redactUrlsInText(redactConnectionInfo(redactForTransport(message, ctx.transport))),
    suggestion: `Server-side failure in ${where}, not a caller mistake. Run \`gbrain doctor --json\` on the brain host; if it repeats, report it to the user.`,
    docs_cmd: ['gbrain', 'errors', 'internal_error'], class: 'server', retryable: false, contract_version: CONTRACT_VERSION,
  };
}

/** Total: never throws; on an internal fault returns the prior generic envelope and logs the class (E11). */
export function toAgentError(e: unknown, ctx: AgentErrorContext): AgentEnvelope {
  try {
    // Typed rows first (OperationError … CredentialError); then the DB-access
    // classifier, which must win over the generic GBrainError/AI/phase rows
    // (a connect failure is often a GBrainError); then the unknown fallback.
    const row = ROWS.find(r => r.match(e));
    const typed = row && ROWS.indexOf(row) < FIRST_GENERIC_ROW;
    let parts = typed ? row.map(e, ctx) : dbParts(e, ctx) ?? (row ? row.map(e, ctx) : unknownParts(e, ctx));
    if (!parts.fix) {
      const recovery = recoveryFix(parts, ctx);
      if (recovery) parts = { ...parts, fix: recovery };
    }
    if (!parts.fix && (codeClass(parts.code) === 'server' || codeClass(parts.code) === 'unavailable')) {
      parts = { ...parts, fix: diagnosticFix(ctx, 'Doctor reports what is missing or failing on the brain host.') };
    }
    if (ctx.mutating === true && ctx.idempotent !== true) parts = { ...parts, retryable: false };
    const env = buildEnvelope(parts, ctx.render);
    if (env.code === 'internal_error' || env.code === 'internal' || !env.suggestion) {
      recordAgentContractEvent({ transport: ctx.transport, op: ctx.op, command: ctx.command, code: env.code, has_suggestion: !!env.suggestion, outcome: ctx.outcome });
    }
    return ctx.transport === 'http' ? redactForTransport(env, 'http') : env;
  } catch (fault) {
    recordAgentContractEvent({
      transport: ctx.transport, op: ctx.op, command: ctx.command, code: 'internal_error',
      fault: fault instanceof Error ? fault.name : typeof fault,
    });
    return genericEnvelope(e, ctx);
  }
}

/** Pure: callers write the strings. TTY order: `Error [code]: msg` / `Fix:` / `Why:` / `Docs:`. */
export function renderCliError(e: unknown, opts: { json: boolean; command: string; tty: boolean }): CliErrorRender {
  const env = toAgentError(e, { transport: 'cli', command: opts.command, render: cliRenderContext() });
  const exitCode = exitCodeForCode(env.code);
  if (opts.json) return { stdout: `${JSON.stringify(env, null, 2)}\n`, exitCode };
  const lines = [`Error [${env.code}]: ${env.message}`];
  lines.push(`Fix: ${env.fix?.command ?? env.suggestion}`);
  if (env.why) lines.push(`Why: ${env.why}`);
  if (env.docs) lines.push(`Docs: ${env.docs}`);
  return { stderr: `${lines.join('\n')}\n`, exitCode };
}

// ── wire builders shared by dispatch, the CLI and the goldens ──────────────

export interface ToolResultShape {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/**
 * MCP success result: `content[0]` is exactly the pre-v1 body (bare arrays
 * included); each notice is one extra prefixed text block, mirrored rendered
 * under `_meta.gbrain_notices`.
 */
export function toolResultWithNotices(result: unknown, notices: readonly Notice[], ctx: RenderContext): ToolResultShape {
  const out: ToolResultShape = { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  if (notices.length === 0) return out;
  const rendered = orderNotices(notices).map(n => redactForTransport(renderNotice(n, ctx), ctx.transport));
  for (const n of rendered) out.content.push({ type: 'text', text: noticeBlock(n) });
  out._meta = { gbrain_notices: rendered };
  return out;
}

/** MCP error result: exactly one content block holding the envelope. */
export function toolErrorResult(envelope: AgentEnvelope): ToolResultShape {
  return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }], isError: true };
}

/**
 * Legacy nested error shapes (`{ error: { class, code, message, hint } }`
 * from code-def/code-refs, phase containment) keep their nesting and gain the
 * v1 sibling keys.
 */
export function withAgentSiblings<T extends Record<string, unknown>>(
  legacy: T,
  parts: { code: string; fix?: Action },
  ctx: RenderContext,
): T & { code: string; fix?: RenderedAction; docs_cmd: string[]; contract_version: 1 } {
  return {
    ...legacy,
    code: parts.code,
    ...(parts.fix ? { fix: renderAction(parts.fix, ctx) } : {}),
    docs_cmd: ['gbrain', 'errors', parts.code],
    contract_version: CONTRACT_VERSION,
  };
}

/**
 * `{ error: StructuredError }` (code-def/code-refs/brainstorm `--json`) with
 * the v1 siblings: canonical `code`, an optional diagnostic `fix`, docs_cmd.
 */
export function legacyNestedErrorDocument(envelope: { code: string }, fixArgv?: string[]): Record<string, unknown> {
  return withAgentSiblings({ error: envelope }, {
    code: canonicalCodeFor(envelope.code),
    ...(fixArgv ? { fix: { argv: fixArgv, consent: [], actor: 'agent' as const, why: 'Shows the arguments this command needs.', requires_exclusive: false } } : {}),
  }, cliRenderContext());
}

/** The `--json` exit-time fallback document: a non-zero exit that wrote no final document. */
export function fallbackJsonDocument(exitCode: number, lastCode?: string): Record<string, unknown> {
  return {
    error: 'command_failed',
    code: lastCode ?? 'command_failed',
    message: `The command exited with status ${exitCode} without writing its JSON result.`,
    suggestion: 'Re-run without --json to read the error on stderr, or run `gbrain doctor --json`.',
    exit_code: exitCode,
    contract_version: CONTRACT_VERSION,
  };
}

__registerOperationErrorRenderer({
  fix: a => renderAction(a, cliRenderContext()),
  notice: n => renderNotice(n, cliRenderContext()),
});
