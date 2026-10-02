/**
 * The report-only scale harness (`bun run test:scale`) is reproducible only if
 * its fixture is: the same seed and page count must give byte-identical pages,
 * and the known answers the harness asserts must hold in the fixture itself.
 */
import { expect, test } from 'bun:test';
import { generateScaleFixture } from '../../scripts/scale/fixture.ts';

test('same seed and size give an identical fixture; another seed differs', () => {
  const a = generateScaleFixture({ pages: 300, seed: 7 });
  const b = generateScaleFixture({ pages: 300, seed: 7 });
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  expect(JSON.stringify(generateScaleFixture({ pages: 300, seed: 8 }).pages)).not.toBe(JSON.stringify(a.pages));
});

test('fixture shape: page count, two sources, unique tokens, links stay in their source, islands and hub hold', () => {
  const f = generateScaleFixture({ pages: 301, seed: 1 });
  expect(f.pages.length).toBe(301);
  expect(f.pages.filter(p => p.sourceId === 'default').length).toBe(151);
  expect(new Set(f.pages.map(p => p.token)).size).toBe(301);
  for (const p of f.pages) {
    expect(p.content).toContain(p.token);
    const own = new Set(f.pages.filter(q => q.sourceId === p.sourceId).map(q => q.slug));
    for (const target of p.links) expect(own.has(target)).toBe(true);
  }
  expect(f.islands.length).toBeGreaterThan(0);
  for (const island of f.islands) {
    expect(f.pages.some(p => p.sourceId === 'default' && p.links.includes(island))).toBe(false);
  }
  expect(f.pages.find(p => p.slug === f.hub && p.sourceId === 'default')!.links.length).toBe(3);
  expect(() => generateScaleFixture({ pages: 5, seed: 1 })).toThrow();
});
