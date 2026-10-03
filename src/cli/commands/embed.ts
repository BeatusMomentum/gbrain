/**
 * `gbrain embed`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import { jsonRequested, setCliExitVerdict, writeStdoutFinal } from '../../core/cli-force-exit.ts';
import { lastBackgroundJob } from '../../core/cli-options.ts';
import { BUDGET_STOP_EXIT_CODE } from '../../core/exit-codes.ts';
import type { BrainEngine } from '../../core/engine.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(engine: BrainEngine, args: string[], ctx: CliDispatchContext): Promise<void> {
  const { SELECTED_CONFIG_BY_ENGINE } = ctx;
  const { runEmbed } = await import('../../commands/embed.ts');
  // #3037: mirror the `import` case above — the CLI was discarding the
  // result, so a run where every chunk failed to embed still exited 0
  // and cron/CI/health gates read total silence as success. Surface
  // non-zero on failures > 0. (undefined = backgrounded via --background.)
  const embedResult = await runEmbed(engine, args, SELECTED_CONFIG_BY_ENGINE.get(engine) ?? null);
  // D2: under --json the result is the one document (a budget stop carries
  // remaining_stale + resume_command and exits 11; --background names its job).
  if (jsonRequested(args)) {
    const job = lastBackgroundJob();
    await writeStdoutFinal(`${JSON.stringify(embedResult ?? { status: 'backgrounded', ...(job !== null ? { job_id: job } : {}) }, null, 2)}\n`);
  }
  if (embedResult && embedResult.failures > 0) {
    setCliExitVerdict(1);
  } else if (embedResult && 'reason' in embedResult && embedResult.reason === 'time_budget') {
    setCliExitVerdict(BUDGET_STOP_EXIT_CODE);
  }
}
