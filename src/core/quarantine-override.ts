/**
 * #6259 (fix wave 12, W1.2): an operator's decision that a quarantined page is
 * not junk, recorded as the `quarantine_override` frontmatter key.
 *
 * The content-quality gate re-derives `quarantine` and `content_flag` on every
 * import, so deleting the marker never sticks: the next sync (or the owner's
 * publication) re-stamps it. `gbrain quarantine clear <slug> --force` writes
 * this key instead. It is bound to the page's title, type and body: while
 * they are unchanged the gate keeps its classifier verdict (junk patterns,
 * operator literals, markup ratio) off the page; any change to them expires
 * the override and the gate decides again. Size gates (oversize `embed_skip`)
 * are not overridden.
 *
 * Trust: only trusted local callers set it. Every untrusted ingress strips it
 * (the gate-owned strip in `import-file.ts`, which remote put_page,
 * put_pages, HTTP and ingest-capture all reach through `remote: true`); a
 * remote edit that leaves title, type and body unchanged carries the stored
 * override forward, so an unrelated tag edit does not re-hide the page.
 * Company-brain inspection refuses files that carry it.
 */
import type { BrainEngine } from './engine.ts';
import type { ContentSanityResult } from './content-sanity.ts';
import { parseMarkdown, type ParsedMarkdown } from './markdown.ts';
import { sanitizeText } from './batch-rows.ts';
import { sha256 } from './persistence/digest.ts';
import { CONTENT_FLAG_KEY, QUARANTINE_KEY } from './quarantine.ts';

export const QUARANTINE_OVERRIDE_KEY = 'quarantine_override';

export interface QuarantineOverride { binding: string; cleared_at: string }

type Bound = Pick<ParsedMarkdown, 'title' | 'type' | 'compiled_truth' | 'timeline'>;

/** What the override is bound to: the classifier's inputs (title, type, body). */
export function quarantineOverrideBinding(page: Bound): string {
  return sha256(JSON.stringify(['quarantine_override/v1', page.title ?? '', page.type ?? '', page.compiled_truth ?? '', page.timeline ?? '']));
}

/** The override for `markdown` exactly as the import gate will parse and canonicalize it. */
export function quarantineOverrideFor(markdown: string, path: string, now = new Date()): QuarantineOverride {
  const parsed = parseMarkdown(markdown, path, { validate: true });
  return { binding: quarantineOverrideBinding({ title: sanitizeText(parsed.title), type: parsed.type,
    compiled_truth: sanitizeText(parsed.compiled_truth), timeline: sanitizeText(parsed.timeline) }), cleared_at: now.toISOString() };
}

function overrideOf(value: unknown): QuarantineOverride | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { binding, cleared_at } = value as Record<string, unknown>;
  return typeof binding === 'string' && /^[0-9a-f]{64}$/.test(binding) && typeof cleared_at === 'string' ? { binding, cleared_at } : null;
}

/** Whether `page` carries an override bound to its current title, type and body. */
export function hasCurrentQuarantineOverride(page: Bound & { frontmatter?: Record<string, unknown> | null }): boolean {
  const override = overrideOf(page.frontmatter?.[QUARANTINE_OVERRIDE_KEY]);
  return !!override && override.binding === quarantineOverrideBinding(page);
}

/**
 * Called by the import gate before it assesses `parsed` (already canonicalized).
 * Remote input loses any override it carries, then keeps the stored one only
 * when it still binds this content; trusted input keeps its own override only
 * while it binds. A stale or malformed override is dropped.
 */
export async function settleQuarantineOverride(engine: Pick<BrainEngine, 'executeRaw'>, parsed: ParsedMarkdown,
  slug: string, sourceId: string | undefined, remote: boolean): Promise<void> {
  if (remote) {
    delete parsed.frontmatter[QUARANTINE_OVERRIDE_KEY];
    const [stored] = await engine.executeRaw<{ override: unknown }>(
      `SELECT frontmatter->'${QUARANTINE_OVERRIDE_KEY}' AS override FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`, [sourceId ?? 'default', slug]);
    const carried = overrideOf(stored?.override);
    if (carried && carried.binding === quarantineOverrideBinding(parsed)) parsed.frontmatter[QUARANTINE_OVERRIDE_KEY] = carried;
  } else if (Object.hasOwn(parsed.frontmatter, QUARANTINE_OVERRIDE_KEY) && !hasCurrentQuarantineOverride(parsed)) {
    delete parsed.frontmatter[QUARANTINE_OVERRIDE_KEY];
  }
  // A classifier marker the content still carries (a file written before the clear) goes with a current override.
  if (!hasCurrentQuarantineOverride(parsed)) return;
  delete parsed.frontmatter[QUARANTINE_KEY];
  if ((parsed.frontmatter[CONTENT_FLAG_KEY] as { reason?: unknown } | undefined)?.reason !== 'oversized') delete parsed.frontmatter[CONTENT_FLAG_KEY];
}

/** The gate verdict with the classifier's hide and markup-flag outcomes removed for an overridden page; size outcomes stay. */
export function withQuarantineOverride(result: ContentSanityResult, page: Bound & { frontmatter?: Record<string, unknown> | null }): ContentSanityResult {
  if (!hasCurrentQuarantineOverride(page)) return result;
  const classifier = new Set(['junk_pattern', 'literal_substring', 'high_markup']);
  const kept = result.reasons.map((reason, i) => [reason, result.reason_messages[i]] as const).filter(([reason]) => !classifier.has(reason));
  return { ...result, junk_pattern_matches: [], literal_substring_matches: [],
    reasons: kept.map(([reason]) => reason), reason_messages: kept.map(([, message]) => message!).filter(Boolean),
    shouldQuarantine: false, shouldHardBlock: false, shouldSkipEmbed: result.oversize, shouldFlag: result.oversize,
    flag_reason: result.oversize ? 'oversized' : null };
}
