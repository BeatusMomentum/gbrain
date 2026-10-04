/**
 * Shared machinery for the engine graduation E2E suites (PGLite -> Postgres).
 *
 * Everything drives the real CLI (`bun src/cli.ts migrate ...`) in child
 * processes with an isolated HOME/GBRAIN_HOME, so the CLI's own connect path,
 * kernel lock and exit codes are what the tests observe. Crash and pause
 * points come from test/helpers/graduation-hooks-preload.ts, loaded with
 * `bun --preload`, which stops the child at a named custody boundary.
 *
 * Contract reads (plan hash, code, fix argv, state) go through the accessors
 * below so a field-name change in the CLI's JSON is fixed in one place.
 */
import { test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';

export const REPO = resolve(import.meta.dir, '..', '..');
export const CLI = join(REPO, 'src', 'cli.ts');
export const PRELOAD = join(REPO, 'test', 'helpers', 'graduation-hooks-preload.ts');

/**
 * Graduation lands in parallel lanes (G2a orchestrator, G3 CLI). Until the
 * orchestrator module exists, suites that need it register as `test.todo`
 * (visible in every report, never silently skipped). Infrastructure checks
 * that need only Postgres run either way.
 */
export const GRADUATION_LANDED = existsSync(join(REPO, 'src', 'core', 'persistence', 'engine-graduation.ts'));
export const graduationTest: typeof test = GRADUATION_LANDED ? test : (test.todo as unknown as typeof test);
/** `graduationTest` with an extra visible skip condition (e.g. Docker unavailable). */
export function graduationTestIf(skip: boolean): typeof test {
  return GRADUATION_LANDED ? test.skipIf(skip) as typeof test : graduationTest;
}
export const DATABASE_URL = process.env.DATABASE_URL;

const PROVIDER_KEYS = /^(OPENAI|ANTHROPIC|VOYAGE|GEMINI|GOOGLE|TYPESAFE|JEV_TYPESAFE|OPENROUTER|GROQ|MISTRAL|COHERE|DEEPSEEK|XAI)_/;

export interface GbrainResult { code: number; signal: string | null; stdout: string; stderr: string; json: Record<string, any> | null; ms: number }
export interface GbrainOpts {
  home: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Load the boundary-hook preload; `pause` names boundaries to stop at. */
  hooks?: { events: string; pause?: string[] };
  stdin?: string;
  /** Run another binary (an older release) instead of `bun src/cli.ts`. */
  binary?: string;
}

function childEnv(opts: GbrainOpts): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !PROVIDER_KEYS.test(k)) env[k] = v;
  delete env.DATABASE_URL; delete env.GBRAIN_DATABASE_URL; delete env.GBRAIN_DIRECT_DATABASE_URL; delete env.GBRAIN_REMOTE_CLIENT_SECRET;
  Object.assign(env, { HOME: opts.home, GBRAIN_HOME: opts.home, GBRAIN_SKIP_STARTUP_HOOKS: '1', NO_COLOR: '1' });
  if (opts.hooks) {
    env.GBRAIN_TEST_GRADUATION_EVENTS = opts.hooks.events;
    env.GBRAIN_TEST_GRADUATION_PAUSE = (opts.hooks.pause ?? []).join(',');
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}

function command(argv: string[], opts: GbrainOpts): string[] {
  if (opts.binary) return [opts.binary, ...argv];
  return [process.execPath, '--no-env-file', ...(opts.hooks ? ['--preload', PRELOAD] : []), CLI, ...argv];
}

/** The last top-level JSON document on stdout (the `--json` contract prints exactly one). */
export function jsonDoc(stdout: string): Record<string, any> | null {
  const text = stdout.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const start = text.lastIndexOf('\n{');
  try { return JSON.parse(start >= 0 ? text.slice(start + 1) : text); } catch { return null; }
}

export interface GbrainChild {
  pid: number;
  exited: Promise<GbrainResult>;
  kill(signal?: NodeJS.Signals): void;
}

export function startGbrain(argv: string[], opts: GbrainOpts): GbrainChild {
  const started = Date.now();
  const child = Bun.spawn(command(argv, opts), { cwd: REPO, env: childEnv(opts), stdin: opts.stdin === undefined ? 'ignore' : new TextEncoder().encode(opts.stdin),
    stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 600_000);
  const exited = (async () => {
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    clearTimeout(timer);
    return { code: child.exitCode ?? -1, signal: child.signalCode ?? null, stdout, stderr, json: jsonDoc(stdout), ms: Date.now() - started };
  })();
  return { pid: child.pid, exited, kill: (signal = 'SIGKILL') => { if (child.exitCode === null) child.kill(signal); } };
}

export async function gbrain(argv: string[], opts: GbrainOpts): Promise<GbrainResult> {
  return startGbrain(argv, opts).exited;
}

// ── Boundary events ───────────────────────────────────────────────────────────

export interface BoundaryEvent { event: 'boundary' | 'paused' | 'released'; boundary: string; detail: Record<string, unknown>; pid: number; at: number; ordinal?: number }

export function readEvents(path: string): BoundaryEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/** Wait for a `paused` event (or any event matching `match`) while the child lives. */
export async function waitForEvent(path: string, match: (e: BoundaryEvent) => boolean, child: GbrainChild, timeoutMs = 300_000): Promise<BoundaryEvent> {
  const deadline = Date.now() + timeoutMs;
  let done = false;
  let result: GbrainResult | null = null;
  child.exited.then(r => { done = true; result = r; });
  for (;;) {
    const hit = readEvents(path).find(match);
    if (hit) return hit;
    if (done) throw new Error(`child exited (${result!.code}/${result!.signal}) before the expected boundary\nstdout:${result!.stdout.slice(-2000)}\nstderr:${result!.stderr.slice(-4000)}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for a boundary in ${path}`);
    await Bun.sleep(25);
  }
}

export function release(path: string, ordinal: number): void {
  writeFileSync(`${path}.release.${ordinal}`, '');
}

// ── Contract accessors (one place to fix if the CLI's JSON names move) ───────

export const planHashOf = (doc: Record<string, any> | null): string | undefined =>
  doc?.plan_hash ?? doc?.planHash ?? doc?.plan?.plan_hash ?? doc?.plan?.planHash ?? doc?.data?.plan_hash;
export const codeOf = (doc: Record<string, any> | null): string | undefined => doc?.code ?? doc?.error?.code ?? doc?.error;
export const fixOf = (doc: Record<string, any> | null): Record<string, any> | undefined => doc?.fix ?? doc?.error?.fix;
export const stateOf = (doc: Record<string, any> | null): string | undefined =>
  doc?.state ?? doc?.graduation?.state ?? doc?.manifest?.state ?? doc?.status?.state;

// ── Postgres targets ──────────────────────────────────────────────────────────

export interface TargetDb { url: string; database: string; admin: string; close(): Promise<void> }

function withDatabase(url: string, database: string, user?: { name: string; password: string }): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user) { u.username = user.name; u.password = user.password; }
  return u.toString();
}

/** A brand-new empty database (no gbrain schema) on the E2E server. */
export async function emptyTarget(adminUrl = DATABASE_URL!): Promise<TargetDb> {
  assertSafeE2eDatabaseUrl(adminUrl);
  const database = `gbrain_test_graduation_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE ${database}`); } finally { await admin.end(); }
  return { url: withDatabase(adminUrl, database), database, admin: adminUrl, close: () => dropDatabase(adminUrl, database) };
}

export async function dropDatabase(adminUrl: string, database: string): Promise<void> {
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  try { await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await admin.end(); }
}

/**
 * A hosted-style target: a NOSUPERUSER LOGIN role that owns an empty database
 * whose `vector` extension the administrator created (as managed providers
 * do). The role cannot `SET session_replication_role`, so the copy must use
 * the `DISABLE TRIGGER USER` fallback.
 */
export async function hostedRoleTarget(adminUrl = DATABASE_URL!): Promise<TargetDb & { role: string; rotatePassword(): Promise<string> }> {
  assertSafeE2eDatabaseUrl(adminUrl);
  const suffix = randomUUID().replace(/-/g, '').slice(0, 16);
  const role = `gbrain_hosted_${suffix}`;
  const database = `gbrain_test_graduation_hosted_${suffix}`;
  let password = `hosted-${randomUUID()}`;
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
    await admin.unsafe(`CREATE DATABASE ${database} OWNER ${role}`);
  } finally { await admin.end(); }
  const owned = postgres(withDatabase(adminUrl, database), { max: 1, prepare: false, onnotice: () => {} });
  try {
    await owned.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
    await owned.unsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await owned.unsafe(`GRANT ALL ON SCHEMA public TO ${role}`);
  } finally { await owned.end(); }
  return {
    role, database, admin: adminUrl,
    get url() { return withDatabase(adminUrl, database, { name: role, password }); },
    async rotatePassword() {
      password = `rotated-${randomUUID()}`;
      const a = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
      try { await a.unsafe(`ALTER ROLE ${role} PASSWORD '${password}'`); } finally { await a.end(); }
      return withDatabase(adminUrl, database, { name: role, password });
    },
    async close() {
      await dropDatabase(adminUrl, database);
      const a = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
      try { await a.unsafe(`DROP ROLE IF EXISTS ${role}`); } finally { await a.end(); }
    },
  } as TargetDb & { role: string; rotatePassword(): Promise<string> };
}

/** The same database reached through the transaction-mode pooler (GBRAIN_PGBOUNCER_URL), or null when no pooler is configured. */
export function pooledUrl(target: TargetDb): string | null {
  const pooler = process.env.GBRAIN_PGBOUNCER_URL;
  return pooler ? withDatabase(pooler, target.database) : null;
}

// ── Zero-mutation digests ─────────────────────────────────────────────────────

export interface StateDigest { files: Record<string, string>; target: Record<string, string> }

function digestFiles(root: string, out: Record<string, string>): void {
  if (!existsSync(root)) return;
  const info = lstatSync(root);
  if (info.isSymbolicLink()) { out[root] = `link`; return; }
  if (info.isFile()) { out[root] = `${info.mode.toString(8)}:${createHash('sha256').update(readFileSync(root)).digest('hex')}`; return; }
  if (!info.isDirectory()) return;
  out[root] = `dir:${info.mode.toString(8)}`;
  for (const name of readdirSync(root).sort()) digestFiles(join(root, name), out);
}

/**
 * Every file under the fixture directory (home, config, manifest, intent
 * marker, tombstone, data dir and its siblings) plus, when a target URL is
 * given, every target relation's rows, sequences and trigger enablement.
 */
export async function stateDigest(fixtureDir: string, targetUrl?: string): Promise<StateDigest> {
  const files: Record<string, string> = {};
  digestFiles(fixtureDir, files);
  const target: Record<string, string> = {};
  if (targetUrl) {
    const sql = postgres(targetUrl, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const relations = await sql.unsafe<{ name: string; kind: string }[]>(`SELECT c.relname AS name, c.relkind::text AS kind FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','S','v') ORDER BY c.relname COLLATE "C"`);
      target['@relations'] = relations.map((r: { name: string; kind: string }) => `${r.kind}:${r.name}`).join(',');
      for (const r of relations) {
        if (r.kind === 'v') continue;
        const [row] = r.kind === 'S'
          ? await sql.unsafe(`SELECT last_value::text || ':' || is_called::text AS d FROM "${r.name}"`)
          : await sql.unsafe(`SELECT count(*)::text || ':' || md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text COLLATE "C"), '')) AS d FROM "${r.name}" t`);
        target[r.name] = String(row.d);
      }
      const triggers = await sql.unsafe<{ d: string }[]>(`SELECT c.relname || '.' || t.tgname || '=' || t.tgenabled::text AS d FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY 1`);
      target['@triggers'] = triggers.map((t: { d: string }) => t.d).join(',');
    } catch (error) {
      if ((error as { code?: string }).code !== '3D000') throw error;
      target['@database'] = 'absent';
    } finally { await sql.end(); }
  }
  return { files, target };
}

export function digestChanges(before: StateDigest, after: StateDigest): string[] {
  const changes: string[] = [];
  for (const side of ['files', 'target'] as const) {
    const keys = new Set([...Object.keys(before[side]), ...Object.keys(after[side])]);
    for (const key of [...keys].sort()) if (before[side][key] !== after[side][key]) changes.push(`${side} ${key}: ${before[side][key] ?? '(absent)'} -> ${after[side][key] ?? '(absent)'}`);
  }
  return changes;
}

// ── Common flows ──────────────────────────────────────────────────────────────

export const TARGET_ENV = 'GBRAIN_TARGET_URL';

/** The two-command agent flow: plan (exit 3, ask_user) then `--yes --expect <hash>`. */
export async function graduateViaAgentFlow(home: string, url: string, opts: { extra?: string[]; env?: Record<string, string>; hooks?: GbrainOpts['hooks'] } = {}) {
  const env = { [TARGET_ENV]: url, ...opts.env };
  const plan = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--json', ...(opts.extra ?? [])], { home, env });
  const hash = planHashOf(plan.json);
  const run = hash ? await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--yes', '--expect', hash, '--json', ...(opts.extra ?? [])],
    { home, env, hooks: opts.hooks, timeoutMs: 1_800_000 }) : null;
  return { plan, hash, run };
}

/** Assert no output byte names the target password (stdout, stderr, files under the fixture except the 0600 manifest and config). */
export function passwordLeaks(password: string, results: GbrainResult[], fixtureDir: string): string[] {
  const leaks: string[] = [];
  for (const [i, r] of results.entries()) {
    if (r.stdout.includes(password)) leaks.push(`result ${i} stdout`);
    if (r.stderr.includes(password)) leaks.push(`result ${i} stderr`);
  }
  const allowed = new Set(['graduation-manifest.json', 'config.json']);
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const info = lstatSync(path);
      if (info.isDirectory()) { if (!name.endsWith('.pglite') && !name.includes('.graduated-') && name !== '.git') walk(path); continue; }
      if (!info.isFile() || info.size > 4 * 1024 * 1024 || allowed.has(name)) continue;
      if (readFileSync(path).includes(password)) leaks.push(path);
    }
  };
  walk(fixtureDir);
  return leaks;
}

export function passwordOf(url: string): string {
  return decodeURIComponent(new URL(url).password);
}

/** Sibling paths of a data dir that graduation custody creates. */
export function custodyPaths(dataDir: string) {
  const parent = dirname(dataDir);
  const name = dataDir.slice(parent.length + 1);
  const graduated = existsSync(parent) ? readdirSync(parent).filter(n => n.startsWith(`${name}.graduated-`)).map(n => join(parent, n)) : [];
  return {
    marker: `${dataDir}.gbrain-graduation.json`,
    graduated,
    tombstone: existsSync(dataDir) && statSync(dataDir).isFile() ? dataDir : null,
    dataDirIsDirectory: existsSync(dataDir) && statSync(dataDir).isDirectory(),
  };
}

export function manifestPath(home: string): string {
  return join(home, '.gbrain', 'graduation-manifest.json');
}

// ── Older released binaries ───────────────────────────────────────────────────

/** The last `count` release tags at or below this checkout's VERSION, newest first (from origin). */
export function previousReleaseTags(count = 2): string[] {
  const version = readFileSync(join(REPO, 'VERSION'), 'utf8').trim();
  const out = Bun.spawnSync(['git', '-C', REPO, 'ls-remote', '--tags', '--refs', 'origin', 'v*'], { stdout: 'pipe', stderr: 'pipe' });
  if (out.exitCode !== 0) throw new Error(`git ls-remote failed: ${out.stderr.toString()}`);
  const parse = (tag: string) => tag.slice(1).split('.').map(Number);
  const cmp = (a: number[], b: number[]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; } return 0; };
  const current = version.split('.').map(Number);
  return out.stdout.toString().split('\n').map(line => line.split('refs/tags/')[1]).filter((t): t is string => !!t && /^v\d+(\.\d+){3}$/.test(t))
    .filter(t => cmp(parse(t), current) <= 0).sort((a, b) => cmp(parse(b), parse(a))).slice(0, count);
}

/**
 * A compiled binary of an older release, built once per tag into the cache
 * (`GBRAIN_OLDER_RELEASE_DIR`, default ~/.cache/gbrain-older-releases).
 * `GBRAIN_OLDER_RELEASE_BIN_<tag with dots as underscores>` points at a prebuilt one.
 */
export function olderReleaseBinary(tag: string): string {
  const preset = process.env[`GBRAIN_OLDER_RELEASE_BIN_${tag.replace(/\./g, '_')}`];
  if (preset) return preset;
  const cache = process.env.GBRAIN_OLDER_RELEASE_DIR || join(process.env.HOME ?? '/tmp', '.cache', 'gbrain-older-releases');
  const tree = join(cache, tag);
  const binary = join(tree, 'bin', 'gbrain');
  if (existsSync(binary)) return binary;
  const run = (argv: string[], cwd = REPO) => {
    const r = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`${argv.join(' ')}: ${r.stderr.toString().slice(-2000)}`);
  };
  run(['git', 'fetch', '-q', 'origin', 'tag', tag, '--no-tags']);
  if (!existsSync(tree)) run(['git', 'worktree', 'add', '-q', '--detach', tree, tag]);
  run([process.execPath, 'install', '--frozen-lockfile', '--ignore-scripts'], tree);
  run([process.execPath, 'build', '--compile', '--no-compile-autoload-bunfig', '--outfile', 'bin/gbrain', 'src/cli.ts'], tree);
  return binary;
}

// ── MCP clients ───────────────────────────────────────────────────────────────

function parseRpc(text: string): Record<string, any> {
  const data = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).pop();
  return JSON.parse(data ?? text);
}

/** One stateless JSON-RPC tools/call against `gbrain serve --http`. */
export async function mcpHttpCall(base: string, token: string, tool: string, args: Record<string, unknown> = {}): Promise<{ status: number; rpc: Record<string, any> | null }> {
  const res = await fetch(`${base}/mcp`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }) });
  const text = await res.text();
  let rpc: Record<string, any> | null = null;
  try { rpc = parseRpc(text); } catch {}
  return { status: res.status, rpc };
}

export interface StdioSession {
  /** Resolves with the JSON-RPC response, or with null when serve exited first. */
  call(tool: string, args?: Record<string, unknown>): Promise<Record<string, any> | null>;
  close(): Promise<GbrainResult>;
  exited: Promise<GbrainResult>;
}

/** `gbrain serve` over stdio, initialized, as an MCP host would launch it. */
export async function mcpStdioSession(opts: GbrainOpts & { argv?: string[] }): Promise<StdioSession> {
  const started = Date.now();
  const child = Bun.spawn(command(['serve', ...(opts.argv ?? [])], opts), { cwd: REPO, env: childEnv(opts), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const pending = new Map<number, (value: Record<string, any> | null) => void>();
  let stdout = '';
  let id = 0;
  const reading = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      stdout += decoder.decode(chunk);
      let nl: number;
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl); stdout = stdout.slice(nl + 1);
        try { const msg = JSON.parse(line); pending.get(msg.id)?.(msg); pending.delete(msg.id); } catch {}
      }
    }
  })();
  const exited = (async () => {
    const stderr = await new Response(child.stderr).text();
    await child.exited; await reading;
    for (const resolve of pending.values()) resolve(null);
    return { code: child.exitCode ?? -1, signal: child.signalCode ?? null, stdout, stderr, json: jsonDoc(stdout), ms: Date.now() - started };
  })();
  const send = (method: string, params: Record<string, unknown>): Promise<Record<string, any> | null> => {
    const n = ++id;
    const reply = new Promise<Record<string, any> | null>(resolve => pending.set(n, resolve));
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); child.stdin.flush(); } catch { pending.get(n)?.(null); }
    return reply;
  };
  const init = await Promise.race([send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'graduation-e2e', version: '1' } }), exited.then(() => null)]);
  if (init) { try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`); child.stdin.flush(); } catch {} }
  return {
    call: (tool, args = {}) => Promise.race([send('tools/call', { name: tool, arguments: args }), exited.then(() => null)]),
    async close() { try { child.stdin.end(); } catch {} const t = setTimeout(() => child.kill('SIGKILL'), 10_000); const r = await exited; clearTimeout(t); return r; },
    exited,
  };
}

/** A free TCP port on loopback. */
export function freePort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}
