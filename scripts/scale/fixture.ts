/**
 * Deterministic synthetic brain for the report-only scale harness
 * (`bun run test:scale`, docs/TESTING.md "Scale tier"). Same seed and page
 * count always produce the same pages, links and known answers, so a report
 * can be reproduced from its printed seed. No embeddings, no provider calls.
 *
 * Two sources: `default` and `scale-b`. About a third of `scale-b` bodies copy
 * a `default` body (partly overlapping corpora). Each page links to three
 * pages of its own source, carries two dated timeline bullets and a unique
 * search token. A few island pages have no links in or out (known orphans).
 */

export interface ScalePage { sourceId: string; slug: string; content: string; token: string; links: string[] }
export interface ScaleFixture {
  seed: number;
  pages: ScalePage[];
  /** Island pages: no inbound or outbound links. */
  islands: string[];
  /** A `default` page with outbound links, for traversal and backlink queries. */
  hub: string;
}

export const SCALE_SOURCES = ['default', 'scale-b'] as const;
const WORDS = ['ledger', 'harbor', 'quartz', 'meadow', 'signal', 'lantern', 'orbit', 'canvas', 'summit', 'thicket', 'ember', 'falcon',
  'garnet', 'hollow', 'island', 'juniper', 'kestrel', 'linden', 'marble', 'nectar', 'oracle', 'pepper', 'quiver', 'russet'];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function kindFor(i: number): 'people' | 'companies' | 'notes' {
  const r = i % 10;
  return r < 2 ? 'people' : r < 3 ? 'companies' : 'notes';
}

export function generateScaleFixture(opts: { pages: number; seed: number }): ScaleFixture {
  if (!Number.isInteger(opts.pages) || opts.pages < 20) throw new Error('scale fixture needs at least 20 pages');
  const rand = mulberry32(opts.seed);
  const pick = <T,>(items: readonly T[]) => items[Math.floor(rand() * items.length)]!;
  const perSource = [Math.ceil(opts.pages / 2), Math.floor(opts.pages / 2)];
  const slugsBySource = SCALE_SOURCES.map((_, s) => Array.from({ length: perSource[s]! }, (_, i) => `${kindFor(i)}/scale-${s}-${i}`));
  const islandEvery = 97;
  const isIsland = (i: number) => i % islandEvery === islandEvery - 1;
  const pages: ScalePage[] = [];
  const defaultBodies: string[] = [];
  for (const [s, sourceId] of SCALE_SOURCES.entries()) {
    const slugs = slugsBySource[s]!;
    const linkable = slugs.filter((_, i) => !isIsland(i));
    for (const [i, slug] of slugs.entries()) {
      const token = `scaletok${s}x${i}`;
      const links = isIsland(i) ? [] : Array.from({ length: 3 }, () => pick(linkable)).filter(target => target !== slug);
      const reuse = s === 1 && i % 3 === 0 && defaultBodies.length > 0;
      const prose = reuse ? defaultBodies[i % defaultBodies.length]!
        : Array.from({ length: 3 }, () => Array.from({ length: 24 }, () => pick(WORDS)).join(' ') + '.').join('\n\n');
      if (s === 0) defaultBodies.push(prose);
      const month = String(1 + Math.floor(rand() * 12)).padStart(2, '0');
      const day = String(1 + Math.floor(rand() * 28)).padStart(2, '0');
      const content = [
        '---', `title: Scale ${s} ${i}`, `type: ${kindFor(i) === 'people' ? 'person' : kindFor(i) === 'companies' ? 'company' : 'note'}`, '---',
        `# Scale ${s} ${i}`, '', `${prose} Marker ${token}.`, '',
        ...links.map(target => `See [[${target}]].`), '',
        '## Timeline', '', `- **2025-${month}-${day}** | Scale event ${i} recorded`, `- **2026-${month}-${day}** | Scale follow-up ${i}`, '',
      ].join('\n');
      pages.push({ sourceId, slug, content, token, links });
    }
  }
  const islands = pages.filter(p => p.sourceId === 'default' && p.links.length === 0
    && !pages.some(other => other.sourceId === 'default' && other.links.includes(p.slug))).map(p => p.slug);
  const hub = pages.find(p => p.sourceId === 'default' && p.links.length === 3)!.slug;
  return { seed: opts.seed, pages, islands, hub };
}
