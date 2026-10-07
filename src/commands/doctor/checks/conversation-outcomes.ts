/**
 * conversation_outcomes_stale (wave 9 follow-ups, Decision 8): conversation
 * pages whose durable extraction outcome (EXTRACTION_COMPLETE or
 * EXTRACTION_NOT_APPLICABLE) was recorded by an older conversation
 * parser/extractor version than this binary's CONVERSATION_EXTRACTOR_VERSION.
 *
 * An outcome stays fresh across a parser change (nothing reopens on its own,
 * so an upgrade never spends without the user), so this check is how a newer
 * parser's reach is seen: it counts stale outcomes and names the dry run that
 * previews re-extracting them. Outcomes older than the version stamp itself
 * are counted separately and never warn. Bounded: an indexed scan of the
 * extractor rows (idx_facts_extract_conversation_session), capped at
 * OUTCOME_SCAN_CAP and reported as "at least N" past it. Read-only.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { CONVERSATION_EXTRACTOR_VERSION, NON_EXTRACTABLE_AUDIT_SOURCE, outcomeExtractorVersion, TERMINAL_AUDIT_SOURCE } from '../../../core/facts/audit-sources.ts';

export const OUTCOME_SCAN_CAP = 5000;

export async function conversationOutcomesStaleCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  const name = 'conversation_outcomes_stale';
  try {
    const sources = sourceIds ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
    const rows = await engine.executeRaw<{ source_id: string; slug: string; context: string | null }>(
      `SELECT source_id, source_markdown_slug AS slug, context FROM facts
        WHERE source_id = ANY($1::text[]) AND source LIKE 'cli:extract-conversation-facts%' AND source = ANY($2::text[]) AND expired_at IS NULL
        ORDER BY id DESC LIMIT $3`, [sources, [TERMINAL_AUDIT_SOURCE, NON_EXTRACTABLE_AUDIT_SOURCE], OUTCOME_SCAN_CAP + 1]);
    const capped = rows.length > OUTCOME_SCAN_CAP;
    const scanned = rows.slice(0, OUTCOME_SCAN_CAP).map(row => ({ ...row, version: outcomeExtractorVersion(row.context) }));
    const stale = scanned.filter(row => row.version !== null && row.version < CONVERSATION_EXTRACTOR_VERSION);
    const unstamped = scanned.filter(row => row.version === null).length;
    const sample = stale.slice(0, 5).map(row => `${row.source_id}:${row.slug}`);
    const details = { extractor_version: CONVERSATION_EXTRACTOR_VERSION, scanned: scanned.length, capped,
      stale: stale.length, unstamped, sample, docs: 'docs/guides/repair.md#conversation-labels' };
    const atLeast = capped ? 'at least ' : '';
    if (!stale.length) {
      return { name, status: 'ok', details,
        message: `No conversation extraction outcome predates extractor version ${CONVERSATION_EXTRACTOR_VERSION}`
          + (unstamped ? ` (${atLeast}${unstamped} outcome(s) were recorded before outcomes carried a version; they stay as they are).` : '.') };
    }
    const first = stale[0]!;
    return { name, status: 'warn', details,
      message: `${atLeast}${stale.length} conversation page(s) keep an extraction outcome from an older parser/extractor version (current ${CONVERSATION_EXTRACTOR_VERSION}); `
        + 'they are not reopened automatically. Preview re-extracting one with: '
        + `gbrain extract-conversation-facts --source-id ${first.source_id} --slug ${first.slug} --force --dry-run — then run it without --dry-run (spend is capped by --max-cost-usd, default $5).` };
  } catch (error) {
    return { name, status: 'warn', details: { stale: 'unknown' },
      message: `Conversation extraction outcomes could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.` };
  }
}
