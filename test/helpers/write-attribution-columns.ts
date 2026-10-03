/**
 * TEST-ONLY stand-in for lane F1a's `f1_write_attribution` migration
 * (Foundations 1 spec 2.3): adds the write attribution columns, without
 * triggers, so lane F1b's read and backfill tests run before F1a merges.
 * Every statement is `ADD COLUMN IF NOT EXISTS`, so it is a no-op once F1a's
 * migration has created the columns. Drop this file (and its callers' one
 * line) when F1a lands; nothing in src/ imports it.
 */
import type { BrainEngine } from '../../src/core/engine.ts';

const CONTENT_ATTRIBUTION = ['write_request_id uuid', 'write_principal_kind text', 'write_principal_id text',
  'last_write_request_id uuid', 'last_write_principal_kind text', 'last_write_principal_id text', 'last_written_at timestamptz'];

const COLUMNS: Record<string, string[]> = {
  pages: ['revision_write_request_id uuid', 'revision_principal_kind text', 'revision_principal_id text'],
  page_versions: ['write_request_id uuid', 'write_principal_kind text', 'write_principal_id text',
    'archived_write_request_id uuid', 'archived_principal_kind text', 'archived_principal_id text'],
  facts: CONTENT_ATTRIBUTION,
  takes: CONTENT_ATTRIBUTION,
  timeline_entries: CONTENT_ATTRIBUTION,
};

export async function ensureWriteAttributionColumns(engine: BrainEngine): Promise<void> {
  for (const [table, columns] of Object.entries(COLUMNS)) {
    await engine.executeRaw(`ALTER TABLE ${table} ${columns.map(c => `ADD COLUMN IF NOT EXISTS ${c}`).join(', ')}`);
  }
}
