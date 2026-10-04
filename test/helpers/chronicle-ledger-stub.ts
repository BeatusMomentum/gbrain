/**
 * TEMPORARY (Lane 2 of the #5876 wave): Lane 1's `chronicle_page_state` and
 * `chronicle_judge_reservations` DDL (capy/chronicle-lane-core 95e8d6d04, migration
 * `chronicle_page_state`) minus the foreign keys, so the surface tests run before that migration
 * merges. The integrator deletes this helper once the migration is on the branch.
 */
import type { BrainEngine } from '../../src/core/engine.ts';

export async function createChronicleLedgerStub(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`CREATE TABLE IF NOT EXISTS chronicle_page_state (
    source_id TEXT NOT NULL, page_id INTEGER NOT NULL, content_hash TEXT NOT NULL, extractor_version INTEGER NOT NULL,
    slug TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','skipped','extracted','failed')), reason TEXT,
    trigger TEXT NOT NULL CHECK (trigger IN ('auto','backfill')), principal_kind TEXT, principal_id TEXT, request_id UUID,
    no_extract BOOLEAN NOT NULL DEFAULT false, attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0), next_attempt_at TIMESTAMPTZ,
    cost_usd NUMERIC, unpriced BOOLEAN NOT NULL DEFAULT false, event_slugs TEXT[] NOT NULL DEFAULT '{}',
    decided_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_id, page_id, content_hash, extractor_version))`);
  await engine.executeRaw(`CREATE TABLE IF NOT EXISTS chronicle_judge_reservations (
    id BIGSERIAL PRIMARY KEY, reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(), source_id TEXT NOT NULL,
    page_id INTEGER NOT NULL, content_hash TEXT NOT NULL)`);
}

export interface LedgerRowStub {
  slug: string; state: 'pending' | 'skipped' | 'extracted' | 'failed'; reason?: string; trigger?: 'auto' | 'backfill';
  principal?: [string, string]; cost?: number | null; unpriced?: boolean; hoursAgo?: number;
}

let pageSeq = 1;
/** Judged automatic rows (extracted/failed) also get the reservation the phase takes before each call. */
export async function insertChronicleLedgerRow(engine: BrainEngine, row: LedgerRowStub): Promise<void> {
  const pageId = pageSeq++;
  const hash = `h${pageId}`;
  const hoursAgo = String(row.hoursAgo ?? 1);
  const judged = row.state === 'extracted' || row.state === 'failed';
  await engine.executeRaw(`INSERT INTO chronicle_page_state
    (source_id, page_id, content_hash, extractor_version, slug, state, reason, trigger, principal_kind, principal_id,
     attempts, cost_usd, unpriced, updated_at)
    VALUES ('default', $1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() - ($12 || ' hours')::interval)`,
  [pageId, hash, row.slug, row.state, row.reason ?? null, row.trigger ?? 'auto', row.principal?.[0] ?? null,
    row.principal?.[1] ?? null, judged ? 1 : 0, row.cost ?? null, row.unpriced ?? false, hoursAgo]);
  if (judged && (row.trigger ?? 'auto') === 'auto') {
    await engine.executeRaw(`INSERT INTO chronicle_judge_reservations (reserved_at, source_id, page_id, content_hash)
      VALUES (now() - ($1 || ' hours')::interval, 'default', $2, $3)`, [hoursAgo, pageId, hash]);
  }
}
