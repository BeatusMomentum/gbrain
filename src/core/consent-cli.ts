/**
 * CLI glue for the consent primitive (agent operator contract v1, Lane C).
 *
 * `consentGate()` is how a CLI command handler asks for consent: it runs
 * `requireConsent()` and, on a `confirmation_required` refusal, writes the
 * refusal (the consent payload under `--json`, the `[AGENT]` block plus the
 * one-line error otherwise), sets the exit verdict to 3 and resolves `null`.
 * The handler returns without doing any work, so teardown (engine
 * disconnect, lock release) still runs through the one exit seam. Any other
 * error (e.g. `preview_changed`) propagates.
 *
 * Handlers that already call `process.exit` everywhere use
 * `consentGateOrExit()`, which exits 3 on refusal instead.
 */
import { setCliExitVerdict } from './cli-force-exit.ts';
import { isConsentRefusal, printConsentRefusal, requireConsent, type Authorization, type ConsentEnv, type ConsentRequest } from './consent.ts';
import type { BrainEngine } from './engine.ts';

export interface ConsentGateOpts {
  /** `--json` was requested: the refusal is the payload document on stdout. `--json` never implies consent. */
  json: boolean;
  env?: ConsentEnv;
}

export async function consentGate(req: ConsentRequest, opts: ConsentGateOpts): Promise<Authorization | null> {
  try {
    return await requireConsent(req, opts.env ?? {});
  } catch (e) {
    if (!isConsentRefusal(e)) throw e;
    setCliExitVerdict(printConsentRefusal(e, { json: opts.json }));
    return null;
  }
}

export async function consentGateOrExit(req: ConsentRequest, opts: ConsentGateOpts): Promise<Authorization> {
  const auth = await consentGate(req, opts);
  if (auth) return auth;
  process.exit(3);
}

/** The DB-plane `spend.posture` read requireConsent needs to honour `tokenmax`. */
export function engineConsentEnv(engine: Pick<BrainEngine, 'getConfig'> | null | undefined, extra: ConsentEnv = {}): ConsentEnv {
  return engine ? { getConfig: (key: string) => engine.getConfig(key), ...extra } : extra;
}

