import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Fact keys (docs/designs/FACT_KEYS.md). page_fact_keys holds the facts
// extractor's own output for one page revision (occurrence keys, captured
// before dedup), the provenance withdrawal discovery joins on.
// content_chunks.fact_keys is the derived key text a chunk's title-tier
// embedding input carries; it changes only together with that chunk's vector.
// Created empty; nullable column with no backfill (keys arrive with the next
// extraction). Keep in sync with src/schema.sql.
export const FACT_KEYS_SQL = `
      CREATE TABLE IF NOT EXISTS page_fact_keys (
        page_id            INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        source_id          TEXT    NOT NULL,
        page_revision      TEXT    NOT NULL,
        ordinal            INTEGER NOT NULL,
        item_text          TEXT    NOT NULL,
        item_fingerprint   TEXT    NOT NULL,
        subject            TEXT    NOT NULL,
        visibility         TEXT    NOT NULL CHECK (visibility IN ('private','world')),
        extractor_version  TEXT    NOT NULL,
        PRIMARY KEY (page_id, page_revision, ordinal)
      );
      CREATE INDEX IF NOT EXISTS page_fact_keys_withdrawal_idx
        ON page_fact_keys (source_id, item_fingerprint, visibility, subject);
      ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS fact_keys TEXT;
`;

export const v209: Migration = {
  version: 209,
  name: 'fact_keys',
  idempotent: true,
  sql: FACT_KEYS_SQL,
};
