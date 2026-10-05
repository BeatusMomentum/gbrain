/**
 * Per-edge verb attachment in link-type inference: a verb that belongs to
 * another link in the same context window does not type this link, and
 * "joined [X] as <role>" reads as works_at. Pure, no engine.
 */
import { describe, expect, test } from 'bun:test';
import { extractPageLinks, inferLinkType, type SlugResolver } from '../src/core/link-extraction.ts';

const nullResolver: SlugResolver = { resolve: async () => null };
const types = async (content: string) => (await extractPageLinks('people/dana-example', content, {}, 'person', nullResolver, { skipFrontmatter: true }))
  .candidates.map(c => [c.targetSlug, c.linkType]);

test('two links with different verbs in one sentence each get their own verb', async () => {
  expect(await types('Dana works at [Acme](companies/acme-example) on payments and also advises [Widget](companies/widget-co) on pricing.'))
    .toEqual([['companies/acme-example', 'works_at'], ['companies/widget-co', 'advises']]);
  expect(await types('She co-founded [Beta](companies/beta-co) in 2019, and she works at [Acme](companies/acme-example) today.'))
    .toEqual([['companies/beta-co', 'founded'], ['companies/acme-example', 'works_at']]);
});

test('a compound role keeps precedence: founder and CEO of [X] is founded', async () => {
  expect(await types('Dana is the founder and CEO of [Apex](companies/apex-example), an infrastructure company.'))
    .toEqual([['companies/apex-example', 'founded']]);
});

test('a timeline line "Joined [X] as engineer" is works_at on a page whose prose never names X', async () => {
  expect(await types('A short bio.\n\n## Timeline\n\n- **2024-03-01** | linkedin — Joined [Acme](companies/acme-example) as engineer'))
    .toEqual([['companies/acme-example', 'works_at']]);
  expect(inferLinkType('person', 'joined [Acme](companies/acme-example) as a senior engineer', undefined, 'companies/acme-example')).toBe('works_at');
});

test('without a locatable link, plain precedence applies as before', () => {
  expect(inferLinkType('person', 'works at Acme and advises Widget')).toBe('advises');
});

test('the verb is read at this link, not at an earlier mention of the same target in the window', () => {
  const body = [
    'Alice is CTO of [Acme](../companies/acme-example).',
    '- **2025-03-01** | linkedin — Left [Acme](../companies/acme-example) to join [Widget](../companies/widget-co)',
    '- **2025-03-02** | note — works at [Widget](../companies/widget-co)',
  ].join('\n');
  const at = body.lastIndexOf('[Widget]');
  const window = body.slice(Math.max(0, at - 120), at + 120).replace(/\s+/g, ' ').trim();
  const anchor = body.slice(Math.max(0, at - 120), at).replace(/\s+/g, ' ').trimStart().length;
  expect(inferLinkType('person', window, undefined, 'companies/widget-co', undefined, anchor)).toBe('works_at');
  expect(inferLinkType('person', window, undefined, 'companies/widget-co')).toBe('mentions');
});

test('links joined by "and" share the verb before the first: works at [A] and at [B]', async () => {
  const content = 'Alice works at [Acme](companies/acme-example) and at [Widget](companies/widget-co).';
  const window = content.replace(/\s+/g, ' ');
  expect(inferLinkType('person', window, undefined, 'companies/widget-co', undefined, window.indexOf('[Widget]'))).toBe('works_at');
  expect(inferLinkType('person', 'Alice works at [Acme](companies/acme-example) and also advises [Widget](companies/widget-co).', undefined, 'companies/widget-co')).toBe('advises');
});

test('a verb right before a preposition and the next link belongs to that link: "Took an advisory role with [X]"', async () => {
  const content = 'Alice works at [Beta](companies/beta-example).\n\n## Timeline\n\n- **2024-03-01** | linkedin — Took an advisory role with [Acme](companies/acme-example)';
  const r = await extractPageLinks('people/alice-example', content, {}, 'person', { resolve: async () => null } as SlugResolver, {});
  expect(r.candidates.map(c => [c.targetSlug, c.linkType])).toEqual([['companies/beta-example', 'works_at'], ['companies/acme-example', 'advises']]);
});

describe('advisory, board, investor and observer roles are never employment', () => {
  const typeOf = async (line: string, prose = '') => {
    const r = await extractPageLinks('people/alice-example', `${prose}\n\n## Timeline\n\n- **2023-09-01** | note — ${line}`, {}, 'person', { resolve: async () => null } as SlugResolver, {});
    return r.candidates.filter(c => c.targetSlug === 'companies/acme-example').map(c => c.linkType);
  };
  const advisory = ['Took an advisory role with [Acme](companies/acme-example)', 'Became a board member of [Acme](companies/acme-example)',
    "Joined [Acme](companies/acme-example)'s board", 'Joined the board of [Acme](companies/acme-example)', 'Board director at [Acme](companies/acme-example)',
    'Took on a board role at [Acme](companies/acme-example)', 'Joined [Acme](companies/acme-example) as an independent director', 'Started advising [Acme](companies/acme-example)'];
  test('a board or advisory role types advises, even on a page whose prose names a job elsewhere', async () => {
    for (const line of advisory) {
      expect(await typeOf(line)).toEqual(['advises']);
      expect(await typeOf(line, 'Alice is the CTO of [Beta](companies/beta-example).')).toEqual(['advises']);
    }
  });
  test('an observer or investor role types invested_in', async () => {
    for (const line of ['Board observer at [Acme](companies/acme-example)', 'Became an observer at [Acme](companies/acme-example)', 'Joined [Acme](companies/acme-example) as an angel investor'])
      expect(await typeOf(line)).toEqual(['invested_in']);
  });
  test("an investor's board seat is the investment", async () => {
    expect(await typeOf('Joined the board of [Acme](companies/acme-example)', 'Alice is a general partner at a venture fund.')).toEqual(['invested_in']);
  });
});

describe('ordinary job roles type works_at (must not regress against master)', () => {
  const types = async (body: string) => {
    const r = await extractPageLinks('people/alice-example', `Alice.\n\n${body}`, {}, 'person', { resolve: async () => null } as SlugResolver, {});
    return r.candidates.map(c => `${c.targetSlug.split('/')[1]}:${c.linkType}`);
  };
  const A = '[Acme](companies/acme-example)', B = '[Widget](companies/widget-co)';
  test('a role before "at" and a join or move ending "as <role>" stay works_at, in prose and on timeline lines', async () => {
    for (const line of [`Led engineering at ${A}`, `Senior designer at ${A}`, `Product lead at ${A}`, `Runs marketing at ${A}`, `Joined ${A} as CTO`,
      `Joined ${A} as chief of staff`, `Moved to ${A} as head of sales`, `Switched to ${A} as product lead`, `Rejoined ${A} as COO`, `Returned to ${A} as general counsel`]) {
      expect(await types(line)).toEqual(['acme-example:works_at']);
      expect(await types(`## Timeline\n\n- **2024-02-01** | linkedin — ${line}`)).toEqual(['acme-example:works_at']);
    }
  });
  test('a role-before-"at" job keeps works_at when the next line\'s verb belongs to another company', async () => {
    expect(await types(`## Timeline\n\n- **2019-01-01** | note — Senior designer at ${B}\n- **2023-06-01** | note — Moved to ${A} as head of sales`))
      .toEqual(['widget-co:works_at', 'acme-example:works_at']);
  });
  test('advising work inside a job is not an advisory relationship', async () => {
    expect(await types(`Solutions engineer advising customers at ${A}`)).not.toContain('acme-example:advises');
  });
});
