/**
 * Lane H1b (Tier 2): the rows of the agent journey that hold the whole wave's
 * contract up across surfaces. Real CLI subprocesses, real `gbrain serve`
 * sessions (stdio and HTTP), keyless PGLite in temp homes, hard timeouts.
 *
 *   1. Every `--json` stdout parses: the journey's commands, the doctor family,
 *      every read op the CLI exposes (mutating:false, no required params), and
 *      every command a fix or plan names. (json-declared commands' success and
 *      failure shapes: test/cli-contract.serial.test.ts D5.)
 *   2. Zero WARNs without an executable fix, and every runnable fix runs: each
 *      doctor WARN/FAIL carries fix.argv; fixes the agent may run itself
 *      (consent [], actor agent, no inputs) are executed, and each fix.verify.
 *   3. Every remediation-plan command executes (plan steps, repair steps,
 *      explicit-repair previews, the combined command) through a `gbrain` on
 *      PATH, the way an agent pastes them.
 *   4. One embedding-enable command on every surface: init's hint, doctor's
 *      checks, `embed --all`, `whoami`, MCP whoami and gbrain://capabilities
 *      (behind the lock owner's two-step plan there).
 *   5. `--surface starter`: a subset of full, instructions name only listed
 *      tools, a listed tool answers, an unlisted one is a one-block error.
 *   6. Read-only grant over HTTP: only read tools listed; a write is refused
 *      with insufficient_scope as one block naming the host-side fix.
 *   7. Recovery from another directory with conflicting ambient brain/source
 *      (GBRAIN_BRAIN_ID, GBRAIN_SOURCE, .gbrain-mount, .gbrain-source) acts
 *      on the intended brain and source.
 *   8. Each exclusive fix while a live stdio serve holds the lock: the
 *      refusal is the two-step plan (stop the owner, then the same command),
 *      and following it succeeds.
 *
 * Existing lane coverage this builds on: D5 test/cli-contract.serial.test.ts,
 * E1 test/doctor-status-set.test.ts, A7 test/readiness-embedding-enablement.serial.test.ts
 * (the enable argv runs), F1 test/mcp-initialize-instructions.test.ts,
 * F6 test/mcp-notice-channels.test.ts, A2 test/callable-predicate.test.ts,
 * B5 test/scope-denial-contract.test.ts, A7 test/readiness.test.ts (exclusiveFix).
 *
 * Serial: real subprocesses, PGLite locks, an HTTP port.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { operations } from '../src/core/operations.ts';
import { shellQuote } from '../src/core/agent-output.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import {
  REPO, body, call, expectOneBlockError, gb, journeyEnv, mcp, oneDocument, waitFor, type GbResult,
} from './helpers/agent-journey.ts';

const MARKER = 'wombat-tier2-marker';

function writeNotes(dir: string, n: number, prefix = 'tier2-note'): string {
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= n; i++) writeFileSync(join(dir, `${prefix}-${i}.md`), `---\ntitle: ${prefix} ${i}\n---\n\n# ${prefix} ${i}\n\nThe ${MARKER} ${i}.\n`);
  return dir;
}

async function withBrain<T>(home: string, fn: (engine: PGLiteEngine) => Promise<T>): Promise<T> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') });
  try { return await fn(engine); } finally { await engine.disconnect(); }
}

async function seedTimelineFinding(home: string, slug: string): Promise<void> {
  await withBrain(home, engine => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
    `INSERT INTO timeline_entries(page_id,date,source,summary,detail)
       SELECT id,'2026-07-01','legacy','A database-only event','' FROM pages WHERE source_id='default' AND slug=$1`, [slug]),
  TEST_WRITE_ATTRIBUTION)));
}

async function pagesOf(home: string): Promise<string[]> {
  return withBrain(home, async engine => (await engine.executeRaw<{ s: string }>(
    "SELECT source_id || ':' || slug AS s FROM pages WHERE deleted_at IS NULL ORDER BY 1")).map(r => r.s));
}

/** A `--json` invocation: one parseable document; a failure document names code + suggestion. */
function expectJsonContract(r: GbResult, label: string): Record<string, any> {
  const doc = oneDocument(r, label);
  if (r.exitCode !== 0 && r.exitCode !== 3) {
    expect(typeof doc.code, `${label}: failure document has code (exit ${r.exitCode})`).toBe('string');
    expect(typeof doc.suggestion, `${label}: failure document has suggestion`).toBe('string');
  }
  return doc;
}

/** A directory with a `gbrain` that runs this checkout, so plan/fix command strings run as pasted. */
function gbrainShim(root: string): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gbrain'), `#!/bin/sh\nexec bun --no-env-file run ${JSON.stringify(join(REPO, 'src', 'cli.ts'))} "$@"\n`);
  chmodSync(join(bin, 'gbrain'), 0o755);
  return bin;
}

async function sh(home: string, command: string, bin: string, timeoutMs = 120_000): Promise<GbResult> {
  const t0 = performance.now();
  const env = journeyEnv(home, { PATH: `${bin}:${process.env.PATH ?? ''}` });
  const proc = Bun.spawn(['sh', '-c', command], { cwd: home, env, stdin: Bun.file('/dev/null'), stdout: 'pipe', stderr: 'pipe' });
  let killed = false;
  const killer = setTimeout(() => { killed = true; try { proc.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(killed, `${command} hung`).toBe(false);
    return { exitCode, stdout, stderr, ms: Math.round(performance.now() - t0), killed };
  } finally { clearTimeout(killer); }
}

interface Check { name: string; status: string; message: string; fix?: Fix; fix_unavailable_reason?: string }
interface Fix { argv?: string[]; command?: string; consent: string[]; actor: string; next: string; inputs?: unknown[]; verify?: { argv?: string[] }; then?: Fix; requires_exclusive?: boolean }

describe('H1b: --json parses, every WARN has an executable fix, every plan command runs', () => {
  let home = '';
  let bin = '';
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-tier2-json-'));
    bin = gbrainShim(home);
    expect((await gb(home, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    expect((await gb(home, ['import', writeNotes(join(home, 'notes'), 3), '--no-embed', '--json'])).exitCode).toBe(0);
    await seedTimelineFinding(home, 'tier2-note-1');
  }, 300_000);
  afterAll(() => { rmSync(home, { recursive: true, force: true }); });

  test('every read op on the CLI and the doctor family: --json stdout is one document', async () => {
    const readOps = operations
      .filter(op => op.mutating === false && op.cliHints?.name && !Object.values(op.params).some(p => p.required))
      .map(op => [op.cliHints!.name!]);
    expect(readOps.length).toBeGreaterThan(20);
    const commands = [
      ...readOps,
      ['doctor'], ['doctor', '--fast'], ['doctor', '--only', 'embeddings'], ['doctor', '--remediation-plan'],
      ['search', MARKER], ['query', MARKER], ['get', 'tier2-note-1'], ['recall', MARKER], ['sources', 'list'],
      ['jobs', 'list'], ['jobs', 'stats'], ['errors', 'invalid_params'], ['features'], ['status'], ['models'],
      ['embed', '--stale'], ['import', join(home, 'notes')], ['transcripts'], ['whoknows'],
    ];
    const bad: string[] = [];
    for (const args of commands) {
      const r = await gb(home, [...args, '--json'], { timeoutMs: 90_000 });
      try { expectJsonContract(r, `gbrain ${args.join(' ')} --json`); } catch (e) { bad.push(`${args.join(' ')} (exit ${r.exitCode}): ${String(e).slice(0, 300)}`); }
    }
    expect(bad).toEqual([]);
  }, 900_000);

  test('every doctor WARN/FAIL carries an executable fix; agent-runnable fixes and every verify run', async () => {
    const report = expectJsonContract(await gb(home, ['doctor', '--json']), 'doctor --json');
    const notOk = (report.checks as Check[]).filter(c => c.status !== 'ok');
    expect(notOk.length, 'the seeded brain has findings to fix').toBeGreaterThan(0);
    expect(notOk.filter(c => !c.fix?.argv?.length).map(c => `${c.name}: ${c.message}`)).toEqual([]);
    const ran: string[] = [];
    for (const c of notOk) {
      const fix = c.fix!;
      expect(fix.argv![0], `${c.name}: fixes are gbrain commands or a two-step plan`).toMatch(/^(gbrain|kill)$/);
      if (fix.argv![0] === 'gbrain') {
        const help = await gb(home, [fix.argv![1]!, '--help']);
        expect(help.exitCode, `${c.name}: \`gbrain ${fix.argv![1]} --help\``).toBe(0);
      }
      if (fix.consent.length === 0 && fix.actor === 'agent' && !fix.inputs?.length && fix.argv![0] === 'gbrain') {
        const r = await gb(home, fix.argv!.slice(1), { timeoutMs: 240_000 });
        expect(r.exitCode, `${c.name} fix ${fix.command}: ${r.stderr.slice(-1500)}`).toBe(0);
        if (fix.argv!.includes('--json')) expectJsonContract(r, fix.command!);
        ran.push(c.name);
      }
      if (fix.verify?.argv) {
        const v = await gb(home, fix.verify.argv.slice(1));
        expectJsonContract(v, `${c.name} verify`);
      }
    }
    expect(ran.length, 'at least one fix was run by the agent').toBeGreaterThan(0);
  }, 900_000);

  test('every remediation-plan command executes as pasted', async () => {
    const plan = expectJsonContract(await gb(home, ['doctor', '--remediation-plan', '--json']), 'doctor --remediation-plan --json');
    const commands: string[] = [
      ...(plan.explicit_repairs ?? []).map((r: { preview_command: string }) => r.preview_command),
      ...(plan.plan ?? []).map((s: { command: string }) => s.command),
      ...(plan.repair_steps ?? []).map((s: { command: string }) => s.command),
    ];
    expect(commands.length).toBeGreaterThan(2);
    for (const command of commands) {
      expect(command.startsWith('gbrain '), command).toBe(true);
      const r = await sh(home, command, bin, 240_000);
      expect(r.exitCode, `${command}: ${r.stderr.slice(-1500)}`).toBe(0);
    }
    // The combined command (approval included) completes: on PGLite its job steps run in-process.
    const after = expectJsonContract(await gb(home, ['doctor', '--remediation-plan', '--json']), 'doctor --remediation-plan --json (after)');
    expect(after.combined_command, 'the plan names its combined command').toBeTruthy();
    const combined = await sh(home, after.combined_command, bin, 240_000);
    expect(combined.exitCode, `${after.combined_command}: ${combined.stderr.slice(-1500)}`).toBe(0);
    expect(combined.ms, 'job steps run inline instead of waiting out a worker timeout').toBeLessThan(60_000);
    const timeline = expectJsonContract(await gb(home, ['doctor', '--only', 'timeline_history', '--json']), 'verify timeline_history');
    expect((timeline.checks as Check[]).find(c => c.name === 'timeline_history')?.status).toBe('ok');
  }, 900_000);
});

describe('H1b: one embedding-enable command on every surface', () => {
  let home = '';
  beforeAll(async () => { home = mkdtempSync(join(tmpdir(), 'gbrain-tier2-enable-')); }, 60_000);
  afterAll(() => { rmSync(home, { recursive: true, force: true }); });

  test('init hint, doctor, embed --all, whoami, MCP whoami and gbrain://capabilities name the same argv', async () => {
    const init = await gb(home, ['init', '--pglite', '--no-embedding', '--json']);
    expect(init.exitCode).toBe(0);
    expect((await gb(home, ['import', writeNotes(join(home, 'notes'), 1), '--no-embed', '--json'])).exitCode).toBe(0);

    const surfaces: Record<string, string[] | undefined> = {};
    const hint = init.stderr.split('\n').find(l => l.includes('--no-embedding: deferred setup'));
    surfaces['init stderr hint'] = hint ? undefined : [];
    const doctor = expectJsonContract(await gb(home, ['doctor', '--json']), 'doctor --json');
    for (const name of ['embeddings', 'embedding_provider', 'embed_staleness']) {
      surfaces[`doctor ${name}`] = (doctor.checks as Check[]).find(c => c.name === name)?.fix?.argv;
    }
    const embed = await gb(home, ['embed', '--all', '--json']);
    expect(embed.exitCode).toBe(1);
    surfaces['embed --all --json'] = expectJsonContract(embed, 'embed --all --json').fix?.argv;
    const who = expectJsonContract(await gb(home, ['whoami', '--json']), 'whoami --json');
    surfaces['whoami --json'] = who.readiness.find((r: { capability: string }) => r.capability === 'embeddings')?.fix?.argv;

    const s = await mcp(home, ['--surface', 'full']);
    try {
      // Over MCP the serve itself holds the lock, so the exclusive enable command rides
      // behind the two-step plan (stop this server, then the command): compare the command step.
      const step = (fix: Fix | undefined) => (fix?.argv?.[0] === 'kill' ? fix.then : fix)?.argv;
      const caps = JSON.parse(((await s.client.readResource({ uri: "gbrain://capabilities" })).contents[0] as { text: string }).text);
      const capFix = caps.readiness.find((r: { capability: string }) => r.capability === 'embeddings')?.fix as Fix | undefined;
      expect(capFix?.argv).toEqual(['kill', String(s.pid)]);
      surfaces['MCP gbrain://capabilities'] = step(capFix);
      const mw = await call(s, 'whoami');
      expect(mw.isError).toBeFalsy();
      surfaces['MCP whoami'] = step(body(mw).readiness.find((r: { capability: string }) => r.capability === 'embeddings')?.fix);
    } finally { await s.close(); }

    const expected = surfaces['doctor embeddings']!;
    expect(expected.slice(0, 4)).toEqual(['gbrain', 'init', '--force', '--embedding-model']);
    expect(expected).toEqual(expect.arrayContaining(['--path', join(home, '.gbrain', 'brain.pglite')]));
    expect(hint, 'init prints the deferred-setup hint').toContain(`\`${shellQuote(expected)}\``);
    delete surfaces['init stderr hint'];
    for (const [surface, argv] of Object.entries(surfaces)) expect(argv, surface).toEqual(expected);
  }, 600_000);
});

describe('H1b: --surface starter', () => {
  let home = '';
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-tier2-starter-'));
    expect((await gb(home, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    expect((await gb(home, ['import', writeNotes(join(home, 'notes'), 2), '--no-embed', '--json'])).exitCode).toBe(0);
  }, 300_000);
  afterAll(() => { rmSync(home, { recursive: true, force: true }); });

  test('a subset of full; instructions name only listed tools; listed tools answer, unlisted ones are one-block errors', async () => {
    const full = await mcp(home, ['--surface', 'full']);
    const fullTools = new Set((await full.client.listTools()).tools.map(t => t.name));
    await full.close();
    const starter = await mcp(home, ['--surface', 'starter']);
    try {
      const tools = (await starter.client.listTools()).tools.map(t => t.name);
      expect(tools.length).toBeGreaterThan(3);
      expect(tools.length).toBeLessThan(fullTools.size);
      for (const t of tools) expect(fullTools.has(t), `${t} is a full-surface tool`).toBe(true);
      const instructions = starter.client.getInstructions() ?? '';
      for (const name of fullTools) {
        if (tools.includes(name)) continue;
        expect(instructions.includes(`\`${name}\``) || new RegExp(`\\b${name}\\b \\{`).test(instructions), `instructions name unlisted ${name}`).toBe(false);
      }
      const recallTool = tools.includes('recall') ? 'recall' : 'search';
      const found = await call(starter, recallTool, { query: MARKER });
      expect(found.isError).toBeFalsy();
      expect(JSON.stringify(body(found))).toContain(MARKER);
      const hidden = [...fullTools].find(t => !tools.includes(t) && t === 'get_health') ?? [...fullTools].find(t => !tools.includes(t))!;
      const refused = expectOneBlockError(await call(starter, hidden, {}), `${hidden} on starter`);
      expect(refused.suggestion.length).toBeGreaterThan(0);
    } finally { await starter.close(); }
  }, 300_000);
});

describe('H1b: read-only grant over HTTP', () => {
  let home = '';
  let http: ChildProcess | null = null;
  const PORT = 43000 + Math.floor(Math.random() * 2000);
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-tier2-ro-'));
    expect((await gb(home, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    expect((await gb(home, ['import', writeNotes(join(home, 'notes'), 2), '--no-embed', '--json'])).exitCode).toBe(0);
  }, 300_000);
  afterAll(() => {
    if (http) try { http.kill('SIGTERM'); } catch { /* gone */ }
    rmSync(home, { recursive: true, force: true });
  });

  test('only read tools are listed and callable; a write is one insufficient_scope block with the host-side fix', async () => {
    const minted = await gb(home, ['auth', 'create', 'ro-harness', '--scopes', 'read']);
    expect(minted.exitCode, minted.stderr).toBe(0);
    const token = (minted.stdout.match(/gbrain_[a-f0-9]{64}/) ?? [''])[0];
    expect(token).toBeTruthy();
    http = spawn('bun', ['--no-env-file', 'run', join(REPO, 'src', 'cli.ts'), 'serve', '--http', '--bind', '127.0.0.1', '--port', String(PORT)],
      { cwd: home, env: journeyEnv(home), stdio: ['ignore', 'ignore', 'ignore'] });
    expect(await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/health`).catch(() => null))?.ok === true, 60_000)).toBe(true);
    const client = new Client({ name: 'ro-harness', version: '1' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    try {
      const listed = (await client.listTools()).tools;
      const byName = new Map(operations.map(op => [op.name, op]));
      // A read grant lists only read-scope tools (think writes nothing over MCP; request_tools is discovery).
      const beyondRead = listed.filter(t => byName.get(t.name)?.scope !== 'read').map(t => t.name);
      expect(beyondRead, 'a read grant lists no tool needing more than read').toEqual([]);
      expect(listed.map(t => t.name)).not.toContain('remember');
      for (const t of listed) if (byName.get(t.name)?.mutating === false) expect(t.annotations?.readOnlyHint, `${t.name} readOnlyHint`).toBe(true);
      const found = await client.callTool({ name: 'search', arguments: { query: MARKER } }) as any;
      expect(found.isError).toBeFalsy();
      const refused = await client.callTool({ name: 'remember', arguments: { fact: 'x', provenance: 'ro' } }) as any;
      const env = expectOneBlockError(refused, 'remember with a read grant');
      expect(env.code).toBe('insufficient_scope');
      expect(env.fix.actor).toBe('host_admin');
      expect(env.fix.next).toBe('tell_user_to_run');
      expect(env.fix.argv.slice(0, 3)).toEqual(['gbrain', 'auth', 'rescope-token']);
      expect(JSON.stringify(env)).not.toContain(home);
    } finally { await client.close(); }
  }, 300_000);
});

describe('H1b: recovery from another directory with conflicting ambient brain/source', () => {
  let root = '';
  let host = '';
  let team = '';
  let work = '';
  const ambient = () => ({ GBRAIN_BRAIN_ID: 'teambrain', GBRAIN_SOURCE: 'other' });
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-tier2-route-'));
    host = join(root, 'host'); team = join(root, 'team'); work = join(root, 'elsewhere');
    for (const d of [host, team, work]) mkdirSync(d, { recursive: true });
    expect((await gb(host, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    expect((await gb(team, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    for (const id of ['other', 'third']) {
      writeNotes(join(root, id), 1, id);
      const added = await gb(host, ['sources', 'add', id, '--path', join(root, id), '--force']);
      expect(added.exitCode, added.stderr).toBe(0);
    }
    const mounted = await gb(host, ['mounts', 'add', 'teambrain', '--path', team, '--engine', 'pglite', '--db-path', join(team, '.gbrain', 'brain.pglite')]);
    expect(mounted.exitCode, mounted.stderr).toBe(0);
    writeFileSync(join(work, '.gbrain-mount'), 'teambrain\n');
    writeFileSync(join(work, '.gbrain-source'), 'other\n');
  }, 300_000);
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  test('the import refusal fix, the approved remediation and the plan fix act on host/default', async () => {
    const notes = writeNotes(join(root, 'notes'), 2, 'route-note');
    // The refusal is produced in the intended context: the host brain, no ambient routing.
    const refused = await gb(host, ['import', notes, '--json']);
    expect(refused.exitCode).toBe(1);
    const fix = expectJsonContract(refused, 'import --json (keyless refusal)').fix as Fix;
    expect(fix.next).toBe('run');
    expect(fix.argv).toEqual(expect.arrayContaining(['--no-embed', '--brain', 'host', '--source', 'default']));
    // The agent runs it later from another directory whose ambient settings point elsewhere.
    const ran = await gb(host, fix.argv!.slice(1), { cwd: work, env: ambient() });
    expect(ran.exitCode, ran.stderr.slice(-1500)).toBe(0);
    expect(await pagesOf(host)).toEqual(expect.arrayContaining(['default:route-note-1', 'default:route-note-2']));
    expect(await pagesOf(team)).toEqual([]);

    await seedTimelineFinding(host, 'route-note-1');
    const consent = await gb(host, ['doctor', '--remediate', '--include-repairs', '--json']);
    expect(consent.exitCode).toBe(3);
    const payload = expectJsonContract(consent, 'doctor --remediate --json (refusal)');
    expect(payload.fix.argv).toEqual(expect.arrayContaining(['--brain', 'host']));
    expect(payload.preview.argv).toEqual(expect.arrayContaining(['--brain', 'host']));
    const preview = await gb(host, payload.preview.argv.slice(1), { cwd: work, env: ambient() });
    const previewDoc = expectJsonContract(preview, 'remediation preview from elsewhere');
    expect(previewDoc.repair_steps.map((s: { kind: string }) => s.kind)).toContain('timeline');
    const approved = await gb(host, payload.fix.argv.slice(1), { cwd: work, env: ambient(), timeoutMs: 240_000 });
    expect(approved.exitCode, approved.stderr.slice(-2000)).toBe(0);
    expect(expectJsonContract(approved, 'approved remediation from elsewhere').repairs_completed).toBe(1);
    const verify = expectJsonContract(await gb(host, ['doctor', '--only', 'timeline_history', '--json']), 'verify on host');
    expect((verify.checks as Check[]).find(c => c.name === 'timeline_history')?.status).toBe('ok');
  }, 600_000);
});

describe('H1b: exclusive fixes while a live stdio serve holds the lock', () => {
  let home = '';
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-tier2-excl-'));
    expect((await gb(home, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
  }, 120_000);
  afterAll(() => { rmSync(home, { recursive: true, force: true }); });

  const exclusive: Array<{ label: string; args: () => string[]; done: (r: GbResult) => void }> = [
    { label: 'import --no-embed', args: () => ['import', writeNotes(join(home, 'notes'), 2), '--no-embed', '--json'],
      done: r => expect(oneDocument(r, 'import').imported).toBe(2) },
    { label: 'doctor --remediate (approved)', args: () => ['doctor', '--remediate', '--yes', '--target-score', '50', '--json'],
      done: r => expect(oneDocument(r, 'doctor --remediate').exit_status).toBe(0) },
    { label: 'apply-migrations', args: () => ['apply-migrations', '--yes', '--no-autopilot-install', '--json'],
      done: r => expect(oneDocument(r, 'apply-migrations').status).not.toBe('failed') },
  ];

  for (const row of exclusive) {
    test(`${row.label}: the refusal is a two-step plan naming the owner; following it succeeds`, async () => {
      const owner = await mcp(home, ['--surface', 'verbs']);
      let ownerOpen = true;
      try {
        const args = row.args();
        const r = await gb(home, args);
        expect(r.exitCode, `${row.label} under a live serve: ${r.stdout.slice(0, 800)}`).not.toBe(0);
        const env = expectJsonContract(r, `${row.label} (busy)`);
        const fix = env.fix as Fix;
        expect(fix, `${row.label}: the refusal carries a fix, not "wait"`).toBeTruthy();
        expect(fix.argv).toEqual(['kill', String(owner.pid)]);
        expect(fix.actor).toBe('user');
        expect(fix.next).toBe('tell_user_to_run');
        expect(fix.then?.argv).toEqual(['gbrain', ...args]);
        expect(fix.then?.next).toBe('run');
        // Step one: the user stops the owning session. Step two: the agent runs `then` as given.
        await owner.close();
        ownerOpen = false;
        const second = await gb(home, fix.then!.argv!.slice(1), { timeoutMs: 240_000 });
        expect(second.exitCode, `${row.label} then-step: ${second.stderr.slice(-1500)}`).toBe(0);
        row.done(second);
      } finally { if (ownerOpen) await owner.close(); }
    }, 300_000);
  }

  test('doctor under a live serve: no FAIL, the DB checks name the owner and the two-step plan', async () => {
    const owner = await mcp(home, ['--surface', 'verbs']);
    try {
      const r = await gb(home, ['doctor', '--json']);
      expect(r.exitCode).toBe(0);
      const report = expectJsonContract(r, 'doctor --json under a live serve');
      expect((report.checks as Check[]).filter(c => c.status === 'fail').map(c => c.name)).toEqual([]);
      const connection = (report.checks as Check[]).find(c => c.name === 'connection')!;
      expect(connection.fix?.argv).toEqual(['kill', String(owner.pid)]);
      expect(connection.fix?.then?.argv).toEqual(['gbrain', 'doctor', '--json']);
      expect((report.checks as Check[]).filter(c => c.status === 'warn' && !c.fix?.argv).map(c => c.name)).toEqual([]);
    } finally { await owner.close(); }
  }, 300_000);
});
