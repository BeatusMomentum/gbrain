import { currentVerifiedLocalWriter, localHostId, readLocalWriter } from './identity.ts';
import type { Principal, SqlEngine, WriteRequest } from './model.ts';

/**
 * The actor the database stamps on rows written inside withCoordinatedWrite
 * or withWriteAttribution. `requestId` is persistence_requests.id (globally
 * unique), or null for a maintenance write with no journal request.
 */
export interface WriteAttribution { requestId: string | null; principal: Principal; }

export { withWriteAttribution } from './context.ts';

/** A journaled request publishes as itself. */
export function requestAttribution(row: Pick<WriteRequest, 'id' | 'principal_kind' | 'principal_id'>): WriteAttribution {
  return { requestId: row.id, principal: { kind: row.principal_kind, id: row.principal_id } };
}

/** A write by a known principal that has no journal request (manual links, source lifecycle). */
export function principalAttribution(principal: Principal): WriteAttribution {
  return { requestId: null, principal };
}

/**
 * The executing maintenance principal: the verified local writer of this call
 * (server-side owner work), else this installation's local CLI registration,
 * else the host itself when the installation has no usable registration.
 * Attribution records the actor and never authorizes, so an unreadable
 * registration falls back to the host instead of failing the write. The
 * registration found is memoized per engine (an in-process rotation keeps
 * naming the registration this process started with): per-page maintenance
 * loops would otherwise repeat a file read and two queries for every page.
 */
export async function maintenanceAttribution(engine: SqlEngine): Promise<WriteAttribution> {
  const verified = currentVerifiedLocalWriter();
  if (verified) return principalAttribution(verified.principal);
  let registration = installationRegistration.get(engine);
  if (!registration) {
    registration = readLocalWriter(engine, 'cli').then(local => local.id);
    installationRegistration.set(engine, registration);
  }
  try { return principalAttribution({ kind: 'local_cli', id: await registration }); }
  catch {
    installationRegistration.delete(engine);
    return principalAttribution({ kind: 'application', id: `host:${localHostId()}` });
  }
}
const installationRegistration = new WeakMap<SqlEngine, Promise<string>>();
