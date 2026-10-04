/**
 * Temporal typed edges — deterministic evidence derivation (zero LLM).
 *
 * Given one page's content and the derived link rows it owns, produce:
 * - the tense of each owned assertion row ('past' when every compiled-truth
 *   mention of the other endpoint carries a past-tense cue such as
 *   "previously at", "former CTO of"; otherwise 'present');
 * - dated transitions: cue-bearing timeline lines ("- **2025-03-01** | left
 *   [Acme](...)"), the explicit grammar ("Ended works_at [[companies/acme]]",
 *   "Started advises [[companies/acme]]") inside a dated timeline entry, and
 *   `since:` / `until:` keys on relationship frontmatter objects.
 *
 * Natural cues only date relationships the page already asserts (an owned
 * row of a matching state/event type); they never create a relationship.
 * The explicit grammar is a full statement on its own: it names the relation
 * and the target, so a closure survives even after the stale positive
 * sentence is deleted. Lines whose timeline source label starts with
 * `gbrain-dream` carry producer 'dream' (an applied contradiction proposal).
 *
 * Contract and examples: docs/guides/temporal-edges.md.
 */
import { createHash } from 'node:crypto';
import {
  relationSemantics, normalizePartialDate, type AssertionTense, type DatePrecision,
  type TransitionKind, type TransitionProducer,
} from './link-validity.ts';

export interface OwnedRow {
  from_slug: string;
  to_slug: string;
  link_type?: string;
  link_source?: string | null;
  origin_field?: string | null;
}

export interface DerivedTransition {
  from_slug: string;
  to_slug: string;
  link_type: string;
  kind: TransitionKind;
  occurred_on: string;
  date_precision: DatePrecision;
  producer: Extract<TransitionProducer, 'timeline' | 'explicit' | 'frontmatter' | 'dream'>;
  line_hash: string;
}

export interface TemporalEvidence {
  /** Tense per owned row, keyed by rowKey(). */
  tense: Map<string, AssertionTense>;
  transitions: DerivedTransition[];
  /** Explicit-grammar lines whose relation or target could not be used. */
  unmatched: Array<{ line: string; reason: 'not_temporal' | 'event_cannot_end' | 'no_target' }>;
}

export const rowKey = (r: Pick<OwnedRow, 'from_slug' | 'to_slug' | 'link_type'>) => `${r.from_slug}\0${r.to_slug}\0${r.link_type ?? ''}`;

// ─── Cue lexicon ─────────────────────────────────────────────────────────
// Each pattern is anchored at the END of the text just before a reference to
// the other endpoint, so the nearest phrase decides ("Left [Wisp] to join
// [Helix]": end for Wisp, start for Helix).

const ROLE = String.raw`(?:[\w&./-]+\s+){0,4}?`;

const EMPLOYMENT = {
  end: new RegExp(String.raw`\b(?:left|departed(?:\s+from)?|quit|resigned(?:\s+as\s+${ROLE})?(?:\s+from|\s+at)?|stepped\s+down(?:\s+as\s+${ROLE})?(?:\s+from|\s+at)?|(?:was\s+)?laid\s+off\s+(?:from|by|at)|(?:was\s+)?let\s+go\s+(?:from|by)|(?:was\s+)?fired\s+(?:from|by)|no\s+longer\s+(?:at|with|works\s+at|working\s+at)|exited|parted\s+ways\s+with)\s*$`, 'i'),
  start: new RegExp(String.raw`\b(?:join(?:ed|s)?(?:\s+${ROLE}(?:at|as))?|hired\s+(?:by|at|as\s+${ROLE}at)|started\s+(?:at|with|working\s+at)|became\s+${ROLE}(?:at|of)|promoted\s+to\s+${ROLE}(?:at|of)|signed\s+on\s+(?:at|with)|named\s+${ROLE}(?:at|of))\s*$`, 'i'),
  past: new RegExp(String.raw`\b(?:previously(?:\s+worked)?\s+(?:at|with|for)|formerly(?:\s+${ROLE})?\s*(?:at|of|with)|former\s+${ROLE}(?:at|of|with)|ex-[\w-]+\s+(?:at|of)|used\s+to\s+work\s+(?:at|for)|worked\s+(?:at|for|with)|spent\s+(?:[\w-]+\s+){1,4}?(?:at|with)|(?:his|her|their|my)\s+(?:time|stint|tenure)\s+at|stint\s+at|was\s+${ROLE}(?:at|of)|alum(?:nus|na|ni)?\s+of)\s*$`, 'i'),
};

const ADVISORY = {
  end: /\b(?:stepped\s+down\s+as\s+(?:an?\s+)?(?:\w+\s+)?advisor\s+(?:to|at|of|for)|left\s+(?:the\s+)?advisory\s+board\s+(?:of|at)|no\s+longer\s+advis(?:es|ing)|stopped\s+advising|ended\s+(?:the\s+|(?:his|her|their)\s+)?advisory\s+(?:role|work)\s+(?:with|at|for))\s*$/i,
  start: /\b(?:joined\s+(?:the\s+)?advisory\s+board\s+(?:of|at)|became\s+(?:an?\s+)?(?:\w+\s+)?advisor\s+(?:to|at|of|for)|started\s+advising|began\s+advising)\s*$/i,
  past: /\b(?:former\s+(?:\w+\s+)?advisor\s+(?:to|at|of|for)|previously\s+advised|used\s+to\s+advise|advised)\s*$/i,
};

const PARTNER = {
  end: /\b(?:left|stepped\s+down\s+(?:as\s+(?:a\s+)?partner\s+)?(?:from|at))\s*$/i,
  start: /\b(?:joined(?:\s+as\s+(?:a\s+)?(?:\w+\s+)?partner\s+at)?|became\s+(?:a\s+)?(?:\w+\s+)?partner\s+at)\s*$/i,
  past: /\b(?:former\s+(?:\w+\s+)?partner\s+(?:at|of)|was\s+(?:a\s+)?(?:\w+\s+)?partner\s+at)\s*$/i,
};

const EVENT_START: Record<string, RegExp> = {
  invested_in: /\b(?:invested\s+in|invests\s+in|backed|led\s+(?:the\s+)?(?:\w+\s+){0,3}?(?:round|investment|seed)\s+(?:in|for|of)|participated\s+in\s+(?:\w+\s+){0,3}?(?:round|seed)\s+(?:of|in|for)|wrote\s+(?:a|the|an)\s+(?:\w+\s+){0,2}?check\s+(?:to|for|into))\s*$/i,
  led_round: /\b(?:led(?:\s+the)?(?:\s+\w+){0,3}?)\s*$/i,
  founded: /\b(?:founded|co-?founded|started)\s*$/i,
};

type CueSet = { end: RegExp; start: RegExp; past: RegExp };
function cuesFor(linkType: string): CueSet | null {
  if (linkType === 'works_at') return EMPLOYMENT;
  if (linkType === 'advises') return ADVISORY;
  if (linkType === 'yc_partner') return PARTNER;
  return null;
}

// ─── References ──────────────────────────────────────────────────────────

/** Normalize a link target to a slug: strip ./ ../ prefixes, a .md suffix and an #anchor. */
export function normalizeLinkTarget(raw: string): string {
  let s = raw.trim().replace(/[#?].*$/, '').replace(/\.md$/i, '');
  while (s.startsWith('../') || s.startsWith('./')) s = s.replace(/^\.\.?\//, '');
  return s.replace(/^\/+/, '');
}

interface RefHit { index: number; target: string }

const MD_LINK_RE = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const WIKI_LINK_RE = /\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g;

function referencesIn(text: string): RefHit[] {
  const hits: RefHit[] = [];
  for (const m of text.matchAll(MD_LINK_RE)) hits.push({ index: m.index!, target: normalizeLinkTarget(m[1]) });
  for (const m of text.matchAll(WIKI_LINK_RE)) hits.push({ index: m.index!, target: normalizeLinkTarget(m[1].replace(/^[a-z0-9-]+:(?=[a-z])/i, '')) });
  return hits.sort((a, b) => a.index - b.index);
}

/** Does a normalized link target point at `slug` (full path or unique basename form)? */
function refersTo(target: string, slug: string): boolean {
  if (target === slug) return true;
  const base = slug.split('/').pop()!;
  return !target.includes('/') && target.toLowerCase() === base.toLowerCase();
}

/** The clause right before a reference: back to the previous sentence/clause break or reference, max 90 chars. */
function windowBefore(text: string, index: number, prevRefEnd: number): string {
  const start = Math.max(0, index - 90, prevRefEnd);
  let w = text.slice(start, index);
  const cut = Math.max(w.lastIndexOf('. '), w.lastIndexOf('; '), w.lastIndexOf('\n'), w.lastIndexOf(', and '));
  if (cut >= 0) w = w.slice(cut + 1);
  return w.replace(/\*\*|__|[*_`]/g, '');
}

// ─── Timeline lines ──────────────────────────────────────────────────────

const DATED_LINE_RE = /^\s*(?:[-*]\s*)?\*\*(\d{4}-\d{2}-\d{2})\*\*\s*[|\-–—]+\s*(.+?)\s*$/;
const DATED_HEADING_RE = /^\s*###\s+(\d{4}-\d{2}-\d{2})\s*[-–—]+\s*(.+?)\s*$/;
const EXPLICIT_RE = /\b(Started|Ended)\s+([a-z][a-z0-9_]*)\s+(?:\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]|\[[^\]\n]*\]\(([^)\s]+)\))/g;

const EXPLICIT_TEST = new RegExp(EXPLICIT_RE.source);

interface DatedLine { date: string; text: string; dream: boolean }

function datedLines(content: string): DatedLine[] {
  const out: DatedLine[] = [];
  let fence = false;
  for (const line of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = DATED_LINE_RE.exec(line) ?? DATED_HEADING_RE.exec(line);
    if (!m || !normalizePartialDate(m[1])) continue;
    out.push({ date: m[1], text: m[2], dream: /^gbrain-dream\b/i.test(m[2].trim()) });
  }
  return out;
}

const lineHash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// ─── Derivation ──────────────────────────────────────────────────────────

export interface PageForEvidence {
  slug: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown> | null | undefined;
}

export function deriveTemporalEvidence(page: PageForEvidence, rows: readonly OwnedRow[]): TemporalEvidence {
  const tense = new Map<string, AssertionTense>();
  const transitions: DerivedTransition[] = [];
  const unmatched: TemporalEvidence['unmatched'] = [];
  const content = `${page.compiled_truth ?? ''}\n${page.timeline ?? ''}`;
  const lines = datedLines(content);
  const temporalRows = rows.filter(r => relationSemantics(r.link_type) !== 'reference');
  const other = (r: OwnedRow) => (r.from_slug === page.slug ? r.to_slug : r.from_slug);
  const seen = new Set<string>();
  const push = (t: DerivedTransition) => {
    const k = `${t.from_slug}\0${t.to_slug}\0${t.link_type}\0${t.kind}\0${t.occurred_on}\0${t.producer}`;
    if (!seen.has(k)) { seen.add(k); transitions.push(t); }
  };

  // 1. Explicit grammar inside dated timeline entries.
  for (const line of lines) {
    for (const m of line.text.matchAll(EXPLICIT_RE)) {
      const linkType = m[2];
      const target = normalizeLinkTarget(m[3] ?? m[4] ?? '');
      const semantics = relationSemantics(linkType);
      if (!target) { unmatched.push({ line: line.text, reason: 'no_target' }); continue; }
      if (semantics === 'reference') { unmatched.push({ line: line.text, reason: 'not_temporal' }); continue; }
      if (semantics === 'event' && m[1] === 'Ended') { unmatched.push({ line: line.text, reason: 'event_cannot_end' }); continue; }
      const resolved = target.includes('/') ? target : temporalRows.map(other).find(slug => refersTo(target, slug)) ?? null;
      if (!resolved) { unmatched.push({ line: line.text, reason: 'no_target' }); continue; }
      push({ from_slug: page.slug, to_slug: resolved, link_type: linkType, kind: m[1] === 'Started' ? 'start' : 'end',
        occurred_on: line.date, date_precision: 'day', producer: line.dream ? 'dream' : 'explicit', line_hash: lineHash(line.text) });
    }
  }

  // 2. Natural cues on dated lines, for relationships this page asserts.
  for (const line of lines) {
    if (EXPLICIT_TEST.test(line.text)) continue;
    const refs = referencesIn(line.text);
    let prevEnd = 0;
    for (const ref of refs) {
      const window = windowBefore(line.text, ref.index, prevEnd);
      prevEnd = ref.index + 2;
      for (const r of temporalRows) {
        if (!refersTo(ref.target, other(r)) || !r.link_type) continue;
        const cues = cuesFor(r.link_type);
        let kind: TransitionKind | null = null;
        if (cues) kind = cues.end.test(window) ? 'end' : cues.start.test(window) ? 'start' : null;
        else if (EVENT_START[r.link_type]?.test(window)) kind = 'start';
        if (!kind) continue;
        push({ from_slug: r.from_slug, to_slug: r.to_slug, link_type: r.link_type, kind, occurred_on: line.date,
          date_precision: 'day', producer: line.dream ? 'dream' : 'timeline', line_hash: lineHash(line.text) });
      }
    }
  }

  // 3. Frontmatter since/until on relationship objects ({name, since, until}).
  const fm = page.frontmatter ?? {};
  for (const r of temporalRows) {
    if (r.link_source !== 'frontmatter' || !r.origin_field) continue;
    const field = fm[r.origin_field];
    const items = Array.isArray(field) ? field : [field];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const name = typeof obj.name === 'string' ? obj.name : typeof obj.slug === 'string' ? obj.slug : null;
      if (!name || !nameMatches(name, other(r))) continue;
      for (const [key, kind] of [['since', 'start'], ['until', 'end']] as const) {
        const d = normalizePartialDate(stringish(obj[key]));
        if (!d) continue;
        push({ from_slug: r.from_slug, to_slug: r.to_slug, link_type: r.link_type!, kind, occurred_on: d.date,
          date_precision: d.precision, producer: 'frontmatter', line_hash: lineHash(`${r.origin_field}:${name}:${key}`) });
      }
    }
  }

  // 4. Tense of each owned assertion row, from compiled-truth mentions only.
  const narrative = stripDatedLines(page.compiled_truth ?? '');
  const narrativeRefs = referencesIn(narrative);
  for (const r of temporalRows) {
    if (relationSemantics(r.link_type) !== 'state') continue;
    const cues = cuesFor(r.link_type!)!;
    let past = 0, present = 0, prevEnd = 0;
    for (const ref of narrativeRefs) {
      const window = windowBefore(narrative, ref.index, prevEnd);
      prevEnd = ref.index + 2;
      if (!refersTo(ref.target, other(r))) continue;
      if (cues.past.test(window) || cues.end.test(window)) past++; else present++;
    }
    tense.set(rowKey(r), past > 0 && present === 0 && r.link_source !== 'frontmatter' ? 'past' : 'present');
  }
  return { tense, transitions, unmatched };
}

function stripDatedLines(text: string): string {
  return text.split('\n').map(l => (DATED_LINE_RE.test(l) || DATED_HEADING_RE.test(l) ? '' : l)).join('\n');
}

function stringish(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' ? v : null;
}

function nameMatches(name: string, slug: string): boolean {
  const base = slug.split('/').pop()!.toLowerCase();
  const norm = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return norm === base || base.startsWith(`${norm}-`) || normalizeLinkTarget(name).toLowerCase() === slug.toLowerCase();
}
