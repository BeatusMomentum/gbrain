/**
 * auto_chronicle (#5876): the `auto_chronicle` config key has no reader in this
 * version (the put_page chronicle backstop was dropped and nothing else enqueues
 * `chronicle_extract`), so a brain with it set to true silently gets no events.
 * Warns when the key is on, naming the manual sweep and the unset command.
 */
import { isAutoChronicleEnabled } from '../../../core/chronicle/config.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

export const AUTO_CHRONICLE_DOCS = 'docs/guides/troubleshooting.md#auto_chronicle-has-no-effect';

async function runAutoChronicle(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const enabled = await isAutoChronicleEnabled(connectedEngine(ctx));
  checks.push(enabled
    ? {
      name: 'auto_chronicle',
      status: 'warn',
      message: 'auto_chronicle=true currently has no effect: no write or cycle step enqueues chronicle extraction, so new meetings are not swept into events. ' +
        'Fix: run `gbrain chronicle-backfill --dry-run`, then `gbrain chronicle-backfill`; `gbrain config unset auto_chronicle` clears the setting.',
      details: { code: 'auto_chronicle_no_effect', enabled: true, cause: 'auto_chronicle has no reader in this version',
        fix: 'gbrain chronicle-backfill --dry-run', docs: AUTO_CHRONICLE_DOCS },
    }
    : { name: 'auto_chronicle', status: 'ok', message: 'auto_chronicle is off.', details: { enabled: false } });
  return checks;
}

export const autoChronicleEntry: DoctorEntry = { name: 'auto_chronicle', emits: ['auto_chronicle'], run: runAutoChronicle };
