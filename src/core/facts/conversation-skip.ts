/**
 * Terminal "not extractable" outcomes for conversation-facts extraction
 * (#5025 / N2), decided after parsing and before segmentation. A terminal
 * outcome is recorded against the page's content version, so the page
 * leaves the backlog until it changes.
 *
 *   - Undated: a time-only parse on a page with no date anchors every turn
 *     on 1970-01-01, so its facts would be dated at the epoch.
 *   - Prose: a meeting or email page with no speaker turns and the shape of
 *     meeting notes or a calendar event, when no LLM fallback is configured.
 *     Other speaker-less pages stay retryable (a later parser may learn
 *     their format).
 */
import { looksLikeMeetingNotes } from '../conversation-parser/builtins.ts';
import { deriveDateContext } from '../conversation-parser/parse.ts';
import type { ParsePhase } from '../conversation-parser/types.ts';
import type { Page } from '../types.ts';
import { ALLOWED_TYPE_ALIASES } from './conversation-types.ts';

const PROSE_PAGE_TYPES = new Set([...ALLOWED_TYPE_ALIASES.meeting, ...ALLOWED_TYPE_ALIASES.email]);

export interface TerminalConversationSkip {
  /** Recorded on the not-extractable audit row. */
  reason: string;
  /** The operator-facing line: what happened and what reopens the page. */
  message: string;
}

export function terminalConversationSkip(
  page: Page,
  body: string,
  phase: ParsePhase,
  messages: ReadonlyArray<{ timestamp: string }>,
  llmFallback: boolean,
): TerminalConversationSkip | null {
  if (messages.length > 0) {
    if (deriveDateContext({ page }).source !== 'epoch_default' || !messages.some((m) => m.timestamp.startsWith('1970-01-01T'))) return null;
    return {
      reason: 'no page date to place message times',
      message: 'no page date to place message times (they would read 1970-01-01); add a date: to the page frontmatter to extract it',
    };
  }
  if (phase !== 'no_match' || llmFallback || !PROSE_PAGE_TYPES.has(page.type) || !looksLikeMeetingNotes(body)) return null;
  const reason = `no speaker turns in this ${page.type} page (prose, not a transcript)`;
  return { reason, message: `${reason}; not extractable until the page changes` };
}
