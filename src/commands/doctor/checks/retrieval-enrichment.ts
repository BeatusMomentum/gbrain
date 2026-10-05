/**
 * Fact keys (docs/designs/FACT_KEYS.md): keyed coverage, eligible pages
 * without keys, and keys left behind while the setting is off. Read-only.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { factKeysStatus } from '../../../core/facts/fact-keys-status.ts';

async function runRetrievalEnrichment(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  if (engine === null) return checks;
  ctx.progress.heartbeat('retrieval_enrichment');
  try {
    const status = await factKeysStatus(engine);
    const details = { ...status, docs: 'docs/guides/time-aware-recall.md' };
    if (!status.enabled && (status.keyed_chunks > 0 || status.key_rows > 0)) {
      checks.push({ name: 'retrieval_enrichment', status: 'warn', details,
        message: `Fact keys are off but ${status.keyed_pages} page(s) still carry keys. Run \`gbrain fact-keys clear\` (re-embeds the keyed chunks; repeat until it reports none left).` });
    } else if (!status.enabled) {
      checks.push({ name: 'retrieval_enrichment', status: 'ok', details, message: 'Fact keys are off (search.fact_keys).' });
    } else {
      checks.push({ name: 'retrieval_enrichment', status: 'ok', details,
        message: `Fact keys on: ${status.keyed_pages} page(s) keyed, ${status.eligible_unkeyed_pages} eligible page(s) without keys${status.eligible_unkeyed_pages ? ' (new writes key themselves; `gbrain fact-keys refresh --dry-run` lists the rest — refresh re-runs paid extraction, so ask the user first)' : ''}.` });
    }
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    checks.push(code === '42P01' || code === '42703'
      ? { name: 'retrieval_enrichment', status: 'ok', message: 'Skipped (fact-key schema unavailable; apply migrations with gbrain apply-migrations --yes).' }
      : { name: 'retrieval_enrichment', status: 'warn', message: `Fact keys could not be inspected: ${err instanceof Error ? err.message : String(err)}. Health is unknown.` });
  }
  return checks;
}

export const retrievalEnrichmentEntry: DoctorEntry = {
  name: 'retrieval_enrichment',
  emits: ['retrieval_enrichment'],
  run: runRetrievalEnrichment,
};
