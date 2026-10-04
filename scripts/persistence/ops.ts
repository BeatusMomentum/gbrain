/**
 * The op-descriptor protocol between the crash-robot driver (`validate.ts`)
 * and its workers (`worker.ts`). A descriptor is plain JSON: it names one
 * logical operation, the actor that submits it, the source it targets, a
 * fixed request id and op-specific arguments. Values only known after an
 * earlier op ran (a fact id, a take row, a page revision) are `{ $ref }`
 * pointers into earlier observations, so a recorded schedule replays exactly.
 *
 * Every op runs through its real admission wrapper: the registered operation
 * handler with a real OperationContext, a local CLI principal or an
 * authenticated remote principal whose grant lives in `oauth_clients`.
 * Nothing here calls a preparer or `tx.*` directly.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import type { AuthInfo, OperationContext } from '../../src/core/ops/contract.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { revokeLegacyTokenById } from '../../src/core/token-mint.ts';

export const OP_KINDS = ['put_page', 'edit_page', 'remember', 'forget', 'takes_add', 'takes_supersede',
  'add_timeline_entry', 'delete_page', 'restore_page', 'revoke_access'] as const;
export type OpKind = typeof OP_KINDS[number];
/** Read surfaces the oracle checks; they never mutate. */
export const READ_KINDS = ['get_page', 'recall', 'takes_list'] as const;

/**
 * A value produced by an earlier op: `{ $ref: 'op-3', field: 'fact_id' }`.
 * The string `'$current'` as `expected_revision` reads the page's revision
 * (tombstones included) right before submission, as an agent reads first.
 */
export interface OpRef { $ref: string; field: 'fact_id' | 'row_num' | 'revision' }
export type OpArg = string | number | boolean | null | OpRef | OpArg[] | { [key: string]: OpArg };

export interface OpDescriptor {
  v: 1;
  /** Logical id, unique within a schedule ("op-17"). */
  id: string;
  kind: OpKind;
  /** 'local' (trusted CLI) or a remote agent name declared in the world ("agent-0"). */
  actor: string;
  source: string;
  /** Fixed per descriptor so a replayed schedule resubmits the same request. */
  requestId: string;
  args: Record<string, OpArg>;
  /** Ops whose observations this one reads through `$ref`; shrinking keeps them. */
  deps?: string[];
  /** Replay of an earlier descriptor's request id (same or different actor/intent). */
  replayOf?: string;
}

export type OpStatus = 'committed' | 'pending' | 'refused';
export interface OpObservation {
  id: string;
  kind: OpKind;
  actor: string;
  source: string;
  requestId: string;
  status: OpStatus;
  /** Typed error code for a refusal or a non-committed receipt. */
  code?: string;
  /** The durable receipt the caller saw, when one was returned. */
  receipt?: { request_id: string; state: string; revision?: string | null; principal_kind?: string; principal_id?: string; source_id?: string };
  /** Values later ops can `$ref`. */
  values: { fact_id?: string; row_num?: number; revision?: string };
  /** The page bytes the caller could read right after a committed op on a page (for stale republication). */
  pageContent?: string;
  /** The raw handler result or error fields, JSON-safe. */
  raw?: unknown;
}

/**
 * One authenticated remote agent: an OAuth client or legacy access token whose
 * bearer token the real verifier (`GBrainOAuthProvider.verifyAccessToken`)
 * turns into the AuthInfo every remote op runs under. Tokens are synthetic,
 * minted into the fixture's own scratch database.
 */
export interface RemoteActor { name: string; kind: 'oauth_client' | 'legacy_token'; sourceId: string; token: string }
export interface World {
  engine: BrainEngine;
  config: GBrainConfig;
  remotes: RemoteActor[];
  /** AuthInfo per remote actor, from the real token verifier. */
  auth: Map<string, AuthInfo>;
  observations: Map<string, OpObservation>;
  /** Descriptors by id, and the exact parameters each was submitted with (a same-intent replay resends them). */
  descriptors?: Map<string, OpDescriptor>;
  submitted?: Map<string, Record<string, unknown>>;
  /** Called with the exact parameters right before submission (a crash worker persists them). */
  onSubmit?: (d: OpDescriptor, params: Record<string, unknown>) => void;
}

export function descriptor(id: string, kind: OpKind, actor: string, source: string, args: Record<string, OpArg>,
  extra: Partial<Pick<OpDescriptor, 'deps' | 'replayOf' | 'requestId'>> = {}): OpDescriptor {
  return { v: 1, id, kind, actor, source, requestId: extra.requestId ?? randomUUID(), args,
    ...(extra.deps?.length ? { deps: extra.deps } : {}), ...(extra.replayOf ? { replayOf: extra.replayOf } : {}) };
}

/** Rejects anything that is not a well-formed descriptor; the worker trusts nothing it reads from the driver. */
export function parseDescriptor(value: unknown): OpDescriptor {
  const d = value as OpDescriptor;
  if (!d || typeof d !== 'object' || d.v !== 1) throw new Error('op descriptor: unsupported version');
  if (typeof d.id !== 'string' || !d.id) throw new Error('op descriptor: id required');
  if (!(OP_KINDS as readonly string[]).includes(d.kind)) throw new Error(`op descriptor ${d.id}: unknown kind ${String(d.kind)}`);
  for (const key of ['actor', 'source', 'requestId'] as const) if (typeof d[key] !== 'string' || !d[key]) throw new Error(`op descriptor ${d.id}: ${key} required`);
  if (!d.args || typeof d.args !== 'object' || Array.isArray(d.args)) throw new Error(`op descriptor ${d.id}: args must be an object`);
  if (d.deps !== undefined && (!Array.isArray(d.deps) || d.deps.some(dep => typeof dep !== 'string'))) throw new Error(`op descriptor ${d.id}: deps must be ids`);
  return d;
}

/** Verify every remote actor's bearer token through the production verifier. */
export async function authenticateRemotes(world: World): Promise<void> {
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(world.engine) });
  for (const remote of world.remotes) world.auth.set(remote.name, await provider.verifyAccessToken(remote.token) as unknown as AuthInfo);
}

/** Re-verify one actor's bearer token, as a remote transport does on every request. */
async function reauthenticate(world: World, actor: string): Promise<void> {
  const remote = world.remotes.find(r => r.name === actor);
  if (!remote) return;
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(world.engine) });
  world.auth.set(actor, await provider.verifyAccessToken(remote.token) as unknown as AuthInfo);
}

/** Revoke a remote actor's credential through the owner's real revocation path. */
async function revokeAccess(world: World, actor: string): Promise<void> {
  const remote = world.remotes.find(r => r.name === actor);
  if (!remote) throw new Error(`op descriptor: revoke_access names unknown actor ${actor}`);
  const auth = world.auth.get(actor);
  const sql = sqlQueryForEngine(world.engine);
  if (remote.kind === 'oauth_client') {
    await new GBrainOAuthProvider({ sql, transaction: fn => world.engine.transaction(tx => fn(sqlQueryForEngine(tx))) }).revokeClient(auth!.clientId);
  } else await revokeLegacyTokenById(sql, auth!.principal!.id);
}

export function contextFor(world: World, actor: string, sourceId: string): OperationContext {
  const base = { engine: world.engine, config: world.config, dryRun: false, sourceId,
    logger: { info() {}, warn() {}, error() {} } };
  if (actor === 'local') return { ...base, remote: false };
  const auth = world.auth.get(actor);
  if (!auth) throw new Error(`op descriptor: actor ${actor} is not an authenticated remote`);
  return { ...base, remote: true, transport: 'http', auth };
}

function resolveArg(world: World, value: OpArg): unknown {
  if (Array.isArray(value)) return value.map(v => resolveArg(world, v));
  if (value && typeof value === 'object') {
    if ('$ref' in value && typeof value.$ref === 'string') {
      const ref = value as unknown as OpRef;
      const seen = world.observations.get(ref.$ref);
      const resolved = seen?.values[ref.field];
      // An unresolvable reference is still submitted (as a value the real op refuses),
      // so a shrunk sequence that drops the producer stays executable.
      return resolved ?? (ref.field === 'row_num' ? 999_999 : ref.field === 'fact_id' ? '999999999' : 'unresolved-revision');
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveArg(world, v as OpArg)]));
  }
  return value;
}

/** Map a descriptor to the operation's own parameter shape. */
export async function paramsFor(world: World, d: OpDescriptor): Promise<{ op: string; params: Record<string, unknown> }> {
  const original = d.replayOf ? world.descriptors?.get(d.replayOf) : undefined;
  const resent = original && original.actor === d.actor && original.kind === d.kind && JSON.stringify(original.args) === JSON.stringify(d.args)
    ? world.submitted?.get(original.id) : undefined;
  if (resent) return { op: d.kind, params: resent };
  // A resubmission after a crash sends exactly what the interrupted caller sent.
  const interrupted = world.submitted?.get(d.id);
  if (interrupted) return { op: d.kind, params: interrupted };
  const a = resolveArg(world, d.args as OpArg) as Record<string, unknown>;
  if (a.content === '$stale_content') a.content = world.observations.get(String(a.stale_of))?.pageContent ?? 'missing stale content';
  if (a.expected_revision === '$current') {
    const snapshot = await world.engine.readPageSnapshot(String(a.slug), { sourceId: d.source, includeDeleted: true });
    a.expected_revision = snapshot?.revision ?? 'missing-page';
  }
  const revision = a.expected_revision === undefined ? {} : { expected_revision: a.expected_revision };
  const base = { request_id: d.requestId, ...(d.actor === 'local' ? { source_id: d.source } : {}) };
  switch (d.kind) {
    case 'put_page': return { op: 'put_page', params: { ...base, ...revision, slug: a.slug, content: a.content } };
    case 'edit_page': return { op: 'edit_page', params: { ...base, ...revision, slug: a.slug, edits: a.edits } };
    case 'remember': return { op: 'remember', params: { ...base, fact: a.fact, provenance: a.provenance ?? 'crash-robot fixture',
      ...(a.entity ? { entity: a.entity } : {}), infer_entity: false, ...(a.visibility ? { visibility: a.visibility } : {}) } };
    case 'forget': return { op: 'forget', params: { request_id: d.requestId, id: a.fact_id, ...(a.reason ? { reason: a.reason } : {}) } };
    case 'takes_add': return { op: 'takes_add', params: { ...base, slug: a.slug, claim: a.claim, kind: a.kind ?? 'take', holder: a.holder ?? 'world', weight: a.weight ?? 0.5 } };
    case 'takes_supersede': return { op: 'takes_supersede', params: { ...base, slug: a.slug, row_num: a.row_num, claim: a.claim } };
    case 'add_timeline_entry': return { op: 'add_timeline_entry', params: { ...base, slug: a.slug, date: a.date, summary: a.summary } };
    case 'delete_page': return { op: 'delete_page', params: { ...base, ...revision, slug: a.slug } };
    case 'restore_page': return { op: 'restore_page', params: { ...base, ...revision, slug: a.slug } };
    case 'revoke_access': return { op: 'revoke_access', params: { actor: a.actor } };
  }
}

function jsonSafe(value: unknown): unknown {
  try { return JSON.parse(JSON.stringify(value ?? null)); } catch { return String(value); }
}

function receiptOf(value: Record<string, unknown> | undefined): OpObservation['receipt'] {
  const r = (value?.write_request ?? value?.writeRequest ?? value) as Record<string, unknown> | undefined;
  if (!r || typeof r.request_id !== 'string') return undefined;
  const outcome = r.outcome as Record<string, unknown> | undefined;
  return { request_id: r.request_id, state: String(r.state),
    revision: (r.revision ?? outcome?.revision ?? null) as string | null,
    principal_kind: r.principal_kind as string | undefined, principal_id: r.principal_id as string | undefined,
    source_id: r.source_id as string | undefined };
}

/** Run one descriptor through its real handler and record what the caller observed. */
export async function executeOp(world: World, d: OpDescriptor): Promise<OpObservation> {
  const base = { id: d.id, kind: d.kind, actor: d.actor, source: d.source, requestId: d.requestId };
  if (d.kind === 'revoke_access') {
    await revokeAccess(world, String(d.args.actor));
    const observation: OpObservation = { ...base, status: 'committed', values: {} };
    world.observations.set(d.id, observation);
    return observation;
  }
  const { op, params } = await paramsFor(world, d);
  (world.submitted ??= new Map()).set(d.id, params);
  world.onSubmit?.(d, params);
  const handler = operationsByName[op]?.handler;
  if (!handler) throw new Error(`op descriptor ${d.id}: operation ${op} is not registered`);
  let observation: OpObservation;
  try {
    await reauthenticate(world, d.actor);
    const ctx = contextFor(world, d.actor, d.source);
    const result = await handler(ctx, params) as Record<string, unknown>;
    const receipt = receiptOf(result);
    const state = receipt?.state ?? 'committed';
    observation = { ...base, status: state === 'committed' ? 'committed' : 'pending', receipt, values: {}, raw: jsonSafe(result) };
    if (result?.fact_id !== undefined) observation.values.fact_id = String(result.fact_id);
    else if (result?.id !== undefined && d.kind === 'remember') observation.values.fact_id = String(result.id);
    const row = (result?.row_num ?? result?.new_row ?? result?.row) as number | undefined;
    if (typeof row === 'number') observation.values.row_num = row;
    if (receipt?.revision) observation.values.revision = receipt.revision;
  } catch (error) {
    const e = error as { code?: string; name?: string; writeRequest?: Record<string, unknown>; message?: string };
    // The HTTP transport answers a token the verifier rejects with 401 invalid_token.
    if (!e.code && e.name === 'InvalidTokenError') e.code = 'invalid_token';
    const receipt = receiptOf(e.writeRequest);
    observation = { ...base, status: e.code === 'write_pending' ? 'pending' : 'refused', code: e.code ?? 'uncoded_error',
      receipt, values: {}, raw: { code: e.code, message: e.message?.slice(0, 400) } };
  }
  const slug = typeof params.slug === 'string' ? params.slug : typeof params.entity === 'string' ? params.entity : null;
  if (observation.status === 'committed' && slug) {
    try {
      const page = await operationsByName.get_page.handler(contextFor(world, 'local', d.source),
        { slug, include_content: true, source_id: d.source }) as Record<string, unknown>;
      if (typeof page?.content === 'string') observation.pageContent = page.content;
    } catch { /* deleted or not a page */ }
  }
  world.observations.set(d.id, observation);
  return observation;
}

/** Read the current revision of a page the way an agent does (get_page with content). */
export async function currentRevision(world: World, actor: string, sourceId: string, slug: string): Promise<string | null> {
  try {
    const page = await operationsByName.get_page.handler(contextFor(world, actor, sourceId),
      { slug, include_content: true, ...(actor === 'local' ? { source_id: sourceId } : {}) }) as Record<string, unknown>;
    return typeof page?.revision === 'string' ? page.revision : null;
  } catch { return null; }
}
