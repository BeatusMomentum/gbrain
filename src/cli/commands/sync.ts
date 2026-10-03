/**
 * `gbrain sync`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 *
 * A refusal that carries an agent-contract `fix` (e.g. `sync_not_applicable`,
 * `writer_coordinator_required`) renders through `renderCliError` so the
 * operator sees the code, the exact next command and why (`--json`: the v1
 * envelope on stdout).
 */
import type { BrainEngine } from '../../core/engine.ts';
import { OperationError } from '../../core/ops/contract.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runSync } = await import('../../commands/sync.ts');
  try {
    await runSync(engine, args);
  } catch (err) {
    if (!(err instanceof OperationError) || !err.fix) throw err;
    const { renderCliError } = await import('../../core/agent-output.ts');
    const { setCliExitVerdict, writeStdoutFinal } = await import('../../core/cli-force-exit.ts');
    const out = renderCliError(err, { json: args.includes('--json'), command: 'sync', tty: !!process.stderr.isTTY });
    if (out.stdout) await writeStdoutFinal(out.stdout);
    if (out.stderr) process.stderr.write(out.stderr);
    setCliExitVerdict(out.exitCode);
  }
}
