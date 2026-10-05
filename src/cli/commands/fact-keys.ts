/**
 * `gbrain fact-keys`: post-connect dispatch; the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runFactKeys } = await import('../../commands/fact-keys.ts');
  await runFactKeys(engine, args);
}
