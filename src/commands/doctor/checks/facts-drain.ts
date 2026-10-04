/**
 * facts_drain (Lane D): the automatic facts drain on PGLite (src/core/facts/drain.ts).
 * Reports on/off, the queued facts-absorb backlog, the last run and its spend, and a
 * deferral (no key, budget used up, unpriced model under a user cap) with its fix,
 * so a background failure reaches the agent. Reads the database only.
 */
import { FACTS_DRAIN_DOCS, readFactsDrainStatus } from '../../../core/facts/drain.ts';
import type { Check } from '../../doctor.ts';
import { infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

async function runFactsDrainCheck(ctx: DoctorContext): Promise<Check[]> {
  const status = await readFactsDrainStatus(connectedEngine(ctx));
  const details = {
    health: status.health, backlog: status.backlog, last_run: status.last_run, daily_spent_usd: status.daily_spent_usd,
    ...(status.settings ? { enabled: status.settings.enabled, budget_usd: status.settings.budgetUsd, daily_budget_usd: status.settings.dailyBudgetUsd, max_jobs: status.settings.maxJobs } : {}),
    docs: FACTS_DRAIN_DOCS,
  };
  switch (status.health) {
    case 'not_applicable': return [infoCheck('facts_drain', status.message, 'not_applicable', undefined, details)];
    case 'disabled': return [infoCheck('facts_drain', status.message, 'disabled_by_choice', status.fix, details)];
    case 'deferred':
    case 'no_owner':
      return [{ name: 'facts_drain', status: 'warn', message: status.message, ...(status.fix ? { fix: status.fix } : {}), readiness_state: 'degraded', details }];
    default:
      return [{ name: 'facts_drain', status: 'ok', message: status.message, details }];
  }
}

export const factsDrainEntry: DoctorEntry = { name: 'facts_drain', emits: ['facts_drain'], run: runFactsDrainCheck };
