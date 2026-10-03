import { OperationError } from '../ops/contract.ts';
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
 */
export async function maintenanceAttribution(engine: SqlEngine): Promise<WriteAttribution> {
  const verified = currentVerifiedLocalWriter();
  if (verified) return principalAttribution(verified.principal);
  try {
    return principalAttribution({ kind: 'local_cli', id: (await readLocalWriter(engine, 'cli')).id });
  } catch (error) {
    if (!(error instanceof OperationError) || !['writer_registration_required', 'permission_denied'].includes(error.code)) throw error;
    return principalAttribution({ kind: 'application', id: `host:${localHostId()}` });
  }
}
