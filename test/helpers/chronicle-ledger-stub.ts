/**
 * TEMPORARY (Lane 2 of the #5876 wave): a stand-in for Lane 1's `chronicle_page_state` migration,
 * with the columns E1 of the plan names. The integrator deletes this helper once the real
 * migration lands and the surface tests run against it.
 */
import type { BrainEngine } from '../../src/core/engine.ts';

export async function createChronicleLedgerStub(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`CREATE TABLE IF NOT EXISTS chronicle_page_state (
    source_id text NOT NULL, page_id integer NOT NULL, content_hash text NOT NULL, extractor_version integer NOT NULL DEFAULT 1,
    slug text NOT NULL, state text NOT NULL, reason text, trigger text NOT NULL,
    principal_kind text, principal_id text, request_id uuid, no_extract boolean NOT NULL DEFAULT false,
    attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz, cost_usd numeric, unpriced boolean NOT NULL DEFAULT false,
    event_slugs text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source_id, page_id, content_hash, extractor_version))`);
}

export interface LedgerRowStub {
  slug: string; state: string; reason?: string; trigger?: string; principal?: [string, string];
  cost?: number | null; unpriced?: boolean; hoursAgo?: number;
}

let pageSeq = 1;
export async function insertChronicleLedgerRow(engine: BrainEngine, row: LedgerRowStub): Promise<void> {
  await engine.executeRaw(`INSERT INTO chronicle_page_state
    (source_id, page_id, content_hash, slug, state, reason, trigger, principal_kind, principal_id, cost_usd, unpriced, updated_at)
    VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() - ($11 || ' hours')::interval)`,
  [pageSeq++, `h${pageSeq}`, row.slug, row.state, row.reason ?? null, row.trigger ?? 'auto', row.principal?.[0] ?? null,
    row.principal?.[1] ?? null, row.cost ?? null, row.unpriced ?? false, String(row.hoursAgo ?? 1)]);
}
