/**
 * Temporal typed edges — deterministic evidence derivation from page content
 * (src/core/link-temporal-evidence.ts): cue-dated timeline lines, the explicit
 * Started/Ended grammar, frontmatter since/until and assertion tense.
 */
import { describe, test, expect } from 'bun:test';
import { deriveTemporalEvidence, rowKey, normalizeLinkTarget, type OwnedRow } from '../src/core/link-temporal-evidence.ts';

const alice = 'people/alice-example';
const row = (to: string, link_type: string, extra: Partial<OwnedRow> = {}): OwnedRow => ({ from_slug: alice, to_slug: to, link_type, link_source: 'markdown', ...extra });
const derive = (compiled: string, timeline: string, rows: OwnedRow[], frontmatter: Record<string, unknown> = {}) =>
  deriveTemporalEvidence({ slug: alice, compiled_truth: compiled, timeline, frontmatter }, rows);
const brief = (t: ReturnType<typeof derive>['transitions']) => t.map(x => `${x.to_slug.split('/').pop()}:${x.link_type}:${x.kind}:${x.occurred_on}:${x.producer}`);

describe('dated timeline cues', () => {
  test('left X to join Y dates both relationships', () => {
    const ev = derive('', '- **2025-03-01** | linkedin — Left [Acme](../companies/acme-example) to join [Widget](../companies/widget-co) as CTO',
      [row('companies/acme-example', 'works_at'), row('companies/widget-co', 'works_at')]);
    expect(brief(ev.transitions)).toEqual(['acme-example:works_at:end:2025-03-01:timeline', 'widget-co:works_at:start:2025-03-01:timeline']);
  });

  test('a cue never creates a relationship the page does not assert', () => {
    const ev = derive('', '- **2025-03-01** | note — Joined [Widget](companies/widget-co)', [row('companies/acme-example', 'works_at')]);
    expect(ev.transitions).toEqual([]);
  });

  test('leaving employment does not end an advisory relationship', () => {
    const ev = derive('', '- **2024-06-01** | note — left [Acme](companies/acme-example)', [row('companies/acme-example', 'advises')]);
    expect(ev.transitions).toEqual([]);
  });

  test('advisory cues date advises', () => {
    const ev = derive('', '- **2024-06-01** | note — stepped down as advisor to [Acme](companies/acme-example)', [row('companies/acme-example', 'advises')]);
    expect(brief(ev.transitions)).toEqual(['acme-example:advises:end:2024-06-01:timeline']);
  });

  test('a meeting with a former employer is not a start', () => {
    const ev = derive('', '- **2026-01-10** | cal — Coffee with the [Acme](companies/acme-example) team', [row('companies/acme-example', 'works_at')]);
    expect(ev.transitions).toEqual([]);
  });

  test('bare wikilinks resolve against asserted targets', () => {
    const ev = derive('', '- **2023-02-01** | me — joined [[acme-example]]', [row('companies/acme-example', 'works_at')]);
    expect(brief(ev.transitions)).toEqual(['acme-example:works_at:start:2023-02-01:timeline']);
  });

  test('event relations get their dated occurrence', () => {
    const ev = derive('', '- **2021-05-01** | deal — invested in [Fund A](companies/fund-a)', [row('companies/fund-a', 'invested_in')]);
    expect(brief(ev.transitions)).toEqual(['fund-a:invested_in:start:2021-05-01:timeline']);
  });

  test('fenced code is ignored', () => {
    const ev = derive('', '```\n- **2025-03-01** | x — left [Acme](companies/acme-example)\n```', [row('companies/acme-example', 'works_at')]);
    expect(ev.transitions).toEqual([]);
  });
});

describe('explicit grammar', () => {
  test('Ended works_at needs no positive assertion on the page', () => {
    const ev = derive('', '- **2025-03-01** | me — Ended works_at [[companies/acme-example]]', []);
    expect(brief(ev.transitions)).toEqual(['acme-example:works_at:end:2025-03-01:explicit']);
  });

  test('dream-labelled lines carry producer dream', () => {
    const ev = derive('', '- **2025-03-01** | gbrain-dream (inferred) — Ended works_at [[companies/acme-example]] (superseded by works_at companies/widget-co)', []);
    expect(brief(ev.transitions)).toEqual(['acme-example:works_at:end:2025-03-01:dream']);
  });

  test('unusable explicit lines are reported, not silent', () => {
    const ev = derive('', '- **2025-03-01** | me — Ended mentions [[companies/acme-example]]\n- **2025-03-02** | me — Ended founded [[companies/acme-example]]', []);
    expect(ev.transitions).toEqual([]);
    expect(ev.unmatched.map(u => u.reason)).toEqual(['not_temporal', 'event_cannot_end']);
  });
});

describe('frontmatter since/until', () => {
  test('relationship objects with since and until', () => {
    const r = row('companies/acme-example', 'works_at', { link_source: 'frontmatter', origin_field: 'company' });
    const ev = derive('', '', [r], { company: [{ name: 'Acme', since: '2021-04', until: '2024-02-15' }] });
    expect(ev.transitions.map(t => `${t.kind}:${t.occurred_on}:${t.date_precision}:${t.producer}`)).toEqual(['start:2021-04-01:month:frontmatter', 'end:2024-02-15:day:frontmatter']);
  });
});

describe('assertion tense', () => {
  const acme = row('companies/acme-example', 'works_at');
  test('past-tense mention only → past', () => {
    expect(derive('Alice was previously at [Acme](companies/acme-example).', '', [acme]).tense.get(rowKey(acme))).toBe('past');
    expect(derive('She is a former CTO of [Acme](companies/acme-example).', '', [acme]).tense.get(rowKey(acme))).toBe('past');
  });
  test('present beats past on the same page', () => {
    const text = 'Alice was previously at [Acme](companies/acme-example). Now she runs the EU team at [Acme](companies/acme-example).';
    expect(derive(text, '', [acme]).tense.get(rowKey(acme))).toBe('present');
  });
  test('plain present mention → present', () => {
    expect(derive('Alice is CTO of [Acme](companies/acme-example).', '', [acme]).tense.get(rowKey(acme))).toBe('present');
  });
  test('timeline lines do not set tense', () => {
    expect(derive('Alice is CTO of [Acme](companies/acme-example).\n- **2025-03-01** | x — worked at [Acme](companies/acme-example)', '', [acme]).tense.get(rowKey(acme))).toBe('present');
  });
});

test('normalizeLinkTarget', () => {
  expect(normalizeLinkTarget('../companies/acme-example.md#team')).toBe('companies/acme-example');
  expect(normalizeLinkTarget('./people/a')).toBe('people/a');
});
