import type { Migration } from './types.ts';
import { DECIDE_REVIEW_SCHEMA_SQL } from '../ai/decide/schema.ts';

// System One decide: the ambiguous-band review lane (durable review queue and
// per-kind owner-reviewed proposals); DDL in src/core/ai/decide/schema.ts.
export const v207: Migration = {
  version: 207,
  name: 'decide_review_proposals',
  idempotent: true,
  sql: DECIDE_REVIEW_SCHEMA_SQL,
};
