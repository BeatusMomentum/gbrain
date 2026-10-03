/**
 * F4 status-only serve (agent operator contract v1): a second `gbrain serve`
 * on a PGLite brain another serve holds, and a serve with no brain at all,
 * complete the MCP handshake with exactly one `gbrain_status` tool that names
 * the lock owner / missing brain path, the fix and the relay text. Then the
 * documented recoveries end in a successful recall:
 *   (a) the owner closes → the next gbrain_status call opens the brain in
 *       place, tools/list_changed fires and the full catalog answers recall;
 *   (b) no brain → `gbrain init` (the fix) → recovery in place → recall.
 * `--fail-fast` keeps the pre-F4 exit for supervisors.
 *
 * Serial: real subprocesses over one temp GBRAIN_HOME (PGLite lock).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { keylessBrainEnv } from './helpers/provider-env.ts';

const MARKER = 'zelkova-status-marker-4q7';

function cli(args: string[], env: Record<string, string>) {
  return spawnSync('bun', ['--no-env-file', 'run', 'src/cli.ts', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
}

async function connect(env: Record<string, string>, extra: string[] = []) {
  const transport = new StdioClientTransport({
    command: 'bun', args: ['--no-env-file', 'run', 'src/cli.ts', 'serve', ...extra], cwd: process.cwd(), env, stderr: 'pipe',
  });
  const client = new Client({ name: 'status-mode-test', version: '1.0.0' }, { capabilities: {} });
  let stderr = '';
  transport.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
  client.onclose = () => { if (process.env.STATUS_TEST_DEBUG) console.error(`[serve ${extra.join(' ')} closed] ${stderr}`); };
  await client.connect(transport);
  return { client, transport };
}

function body(res: unknown): Record<string, any> {
  return JSON.parse((res as { content: Array<{ text: string }> }).content[0].text);
}

async function waitFor(pred: () => Promise<boolean>, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function envFor(home: string): Record<string, string> {
  const env = keylessBrainEnv(process.env, home, { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined });
  delete env.GBRAIN_SOURCE;
  delete env.GBRAIN_SERVE_FAIL_FAST;
  return env;
}

describe('status-only serve: lock contention → recovery in place (a)', () => {
  let home: string;
  let env: Record<string, string>;
  const opened: Array<{ client: Client; transport: StdioClientTransport }> = [];

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-status-lock-'));
    env = envFor(home);
    expect(cli(['init', '--pglite', '--no-embedding', '--non-interactive'], env).status).toBe(0);
    const notes = join(home, 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'm.md'), `---\ntitle: ${MARKER}\n---\n\n# ${MARKER}\n\nStatus-mode recall proof ${MARKER}.\n`);
    expect(cli(['import', notes, '--no-embed'], env).status).toBe(0);
  }, 120_000);

  afterAll(async () => {
    for (const c of opened) { try { await c.client.close(); } catch { /* best-effort */ } }
    rmSync(home, { recursive: true, force: true });
  });

  test('second serve handshakes with gbrain_status naming the owner, then recovers when the owner closes', async () => {
    const owner = await connect(env);
    opened.push(owner);
    expect((await owner.client.listTools()).tools.some(t => t.name === 'search')).toBe(true);

    const second = await connect(env);
    opened.push(second);
    expect(second.client.getInstructions()).toContain('STATUS-ONLY MODE');
    const tools = (await second.client.listTools()).tools.map(t => t.name);
    expect(tools).toEqual(['gbrain_status']);

    const status = body(await second.client.callTool({ name: 'gbrain_status', arguments: {} }));
    expect(status.status).toBe('unavailable');
    expect(status.reason).toBe('lock_held');
    expect(status.why).toContain(String(status.lock_owner.pid));
    expect(status.why).toContain(status.brain_path);
    expect(status.lock_owner.transport).toBe('stdio');
    expect(status.fix.next).toBe('tell_user_to_run');
    expect(status.user_message).toBeTruthy();
    expect(status.decisions[0].options.map((o: { id: string }) => o.id)).toEqual(['close_owner', 'share_http']);

    // Any other tool: one error block that names gbrain_status.
    const refused = await second.client.callTool({ name: 'search', arguments: { query: MARKER } });
    expect(refused.isError).toBe(true);
    expect((refused.content as unknown[]).length).toBe(1);
    expect(body(refused).code).toBe('serve_status_only');

    let listChanged = false;
    second.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { listChanged = true; });
    await owner.client.close();
    opened.shift();

    expect(await waitFor(async () => body(await second.client.callTool({ name: 'gbrain_status', arguments: {} })).status === 'recovered')).toBe(true);
    expect(await waitFor(async () => listChanged, 10_000)).toBe(true);
    expect((await second.client.listTools()).tools.some(t => t.name === 'search')).toBe(true);
    const found = await second.client.callTool({ name: 'search', arguments: { query: MARKER } });
    expect(found.isError).toBeFalsy();
    expect(JSON.stringify(body(found))).toContain(MARKER);
  }, 180_000);

  test('--fail-fast keeps the supervisor exit', () => {
    const holder = spawnSync('bun', ['--no-env-file', 'run', 'src/cli.ts', 'serve', '--fail-fast'], { cwd: process.cwd(), env: { ...env, GBRAIN_HOME: join(home, 'nope') }, input: '', encoding: 'utf8', timeout: 60_000 });
    expect(holder.status).not.toBe(0);
  }, 90_000);
});

describe('status-only serve: no brain → init → recovery in place (b)', () => {
  let home: string;
  let env: Record<string, string>;
  let session: { client: Client; transport: StdioClientTransport } | null = null;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-status-nobrain-'));
    env = envFor(home);
  });
  afterAll(async () => {
    if (session) { try { await session.client.close(); } catch { /* best-effort */ } }
    rmSync(home, { recursive: true, force: true });
  });

  test('handshake names the missing config path; running the fix recovers and recall works', async () => {
    session = await connect(env);
    const status = body(await session.client.callTool({ name: 'gbrain_status', arguments: {} }));
    expect(status.reason).toBe('no_brain');
    expect(status.why).toContain(join(home, '.gbrain', 'config.json'));
    expect(status.fix.argv).toEqual(['gbrain', 'init', '--pglite', '--no-embedding']);
    // A1 surface rule: a CLI-only fix on stdio is relayed (tell_user_to_run).
    expect(status.fix.next).toBe('tell_user_to_run');
    expect(status.fix.consent).toEqual(['persistent_install']);

    expect(cli(['init', '--pglite', '--no-embedding', '--non-interactive'], env).status).toBe(0);
    expect(await waitFor(async () => body(await session!.client.callTool({ name: 'gbrain_status', arguments: {} })).status === 'recovered', 60_000)).toBe(true);
    const remembered = await session.client.callTool({ name: 'remember', arguments: { fact: `${MARKER} is the install-check fact`, provenance: 'install-check' } });
    expect(remembered.isError).toBeFalsy();
    const recalled = await session.client.callTool({ name: 'recall', arguments: { query: MARKER } });
    expect(recalled.isError).toBeFalsy();
    expect(JSON.stringify(body(recalled))).toContain(MARKER);
  }, 180_000);
});
