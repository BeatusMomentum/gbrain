/**
 * Per-edge verb attachment in link-type inference: a verb that belongs to
 * another link in the same context window does not type this link, and
 * "joined [X] as <role>" reads as works_at. Pure, no engine.
 */
import { expect, test } from 'bun:test';
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
