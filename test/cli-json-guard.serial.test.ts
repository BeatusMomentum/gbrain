/**
 * Agent contract v1 `--json` guard (A0/D2): under the guard, fd 1 carries
 * exactly one JSON document. Interposed stdout writes and console.log go to
 * stderr; only writeStdoutFinal (or writeNdjsonLine) reaches fd 1; a non-zero
 * exit that wrote no document gets the fallback document; spawnCliChild
 * pipes a child's stdout to stderr. Child processes, because the guard
 * patches process-global stdout/exit.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HELPER = join(import.meta.dir, '..', 'src', 'core', 'cli-force-exit.ts');

async function run(body: string): Promise<{ out: string; err: string; code: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-json-guard-'));
  const script = join(dir, 'run.ts');
  writeFileSync(script, `import * as g from ${JSON.stringify(HELPER)};\n${body}\n`);
  try {
    const proc = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('--json guard (document mode)', () => {
  test('console.log and stdout.write go to stderr; the final document alone reaches fd 1', async () => {
    const r = await run(`g.installStdoutPipeDelivery({ json: 'document' });
console.log('human progress line');
process.stdout.write('more noise\\n');
await g.writeStdoutFinal(JSON.stringify({ ok: true }) + '\\n');
g.flushThenExit(0);`);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ ok: true });
    expect(r.err).toContain('human progress line');
    expect(r.err).toContain('more noise');
  }, 20_000);

  test('a direct non-zero exit with no document writes the fallback document', async () => {
    const r = await run(`g.installStdoutPipeDelivery({ json: 'document' });
console.log('Error: something human');
g.noteRenderedErrorCode('invalid_params');
process.exit(2);`);
    expect(r.code).toBe(2);
    const doc = JSON.parse(r.out);
    expect(doc).toEqual({
      error: 'command_failed', code: 'invalid_params',
      message: 'The command exited with status 2 without writing its JSON result.',
      suggestion: 'Re-run without --json to read the error on stderr, or run `gbrain doctor --json`.',
      exit_code: 2, contract_version: 1,
    });
  }, 20_000);

  test('a document already written is never followed by a fallback', async () => {
    const r = await run(`g.installStdoutPipeDelivery({ json: 'document' });
await g.writeStdoutFinal(JSON.stringify({ error: 'x', code: 'x' }) + '\\n');
process.exit(1);`);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({ error: 'x', code: 'x' });
  }, 20_000);

  test('exit 0 without a document writes nothing to fd 1 (a bug D5 fails; E11 hook fires)', async () => {
    const r = await run(`g.installStdoutPipeDelivery({ json: 'document' });
g.setJsonDocumentMissingHook(() => process.stderr.write('HOOK_FIRED\\n'));
console.log('forgot the document');
process.exit(0);`);
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(r.err).toContain('HOOK_FIRED');
  }, 20_000);

  test('ndjson: lines reach fd 1; a failing exit appends a status:error line', async () => {
    const r = await run(`g.installStdoutPipeDelivery({ json: 'ndjson' });
await g.writeNdjsonLine({ n: 1 });
console.log('noise');
process.exit(1);`);
    const lines = r.out.trim().split('\n').map(l => JSON.parse(l));
    expect(lines[0]).toEqual({ n: 1 });
    expect(lines[1]).toMatchObject({ status: 'error', error: 'command_failed', exit_code: 1 });
  }, 20_000);

  test('spawnCliChild pipes the child stdout to stderr under the guard', async () => {
    const r = await run(`g.installStdoutPipeDelivery({ json: 'document' });
const child = g.spawnCliChild(process.execPath, ['-e', 'console.log("child says hi")']);
await new Promise(res => child.on('close', res));
await g.writeStdoutFinal(JSON.stringify({ ok: 1 }) + '\\n');
g.flushThenExit(0);`);
    expect(JSON.parse(r.out)).toEqual({ ok: 1 });
    expect(r.err).toContain('child says hi');
  }, 20_000);

  test('without the guard, installStdoutPipeDelivery keeps stdout as-is', async () => {
    const r = await run(`g.installStdoutPipeDelivery();
console.log('plain');
g.flushThenExit(0);`);
    expect(r.out).toBe('plain\n');
  }, 20_000);
});
