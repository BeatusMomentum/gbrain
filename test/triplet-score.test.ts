/**
 * Relational-arm triplet scoring: the pure scorer (summed, importance-scaled
 * distances, missing-part penalty, worst hop) and the end-to-end arm on PGLite
 * (path edges from the fanout, the wider fetch that reaches candidates past
 * the alphabetical cut, lexical fallback without a query vector).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { buildRelationalArm } from '../src/core/search/relational-recall.ts';
import { applyTripletScoring, scoreRow, type TripletInputs } from '../src/core/search/triplet-score.ts';
import type { SearchResult } from '../src/core/types.ts';

function row(slug: string, edges: string[]): SearchResult {
  return {
    slug, page_id: 1, title: slug, type: 'person' as never, chunk_text: '', chunk_source: 'compiled_truth',
    chunk_id: 0, chunk_index: 0, score: 0, stale: false, source_id: 'default', relational_path_edges: edges,
  };
}

function inputs(over: Partial<TripletInputs> = {}): TripletInputs {
  return {
    queryTerms: new Set(['payment']), penalty: 3, pageDistance: new Map(), edgeContext: new Map(),
    pageImportance: new Map(), edgeImportance: new Map(), ...over,
  };
}

describe('scoreRow', () => {
  test('sums the three distances, each scaled by (2 - importance)', () => {
    const t = scoreRow(row('people/bo', ['people/bo|works_at|companies/acme']), inputs({
      pageDistance: new Map([['default:people/bo', 0.2], ['default:companies/acme', 0.4]]),
      edgeContext: new Map([['default:people/bo|works_at|companies/acme', 'Bo leads payments at Acme']]),
    }))!;
    expect(t.parts[0]!.from).toBeCloseTo(0.3, 4);
    expect(t.parts[0]!.edge_distance).toBeCloseTo(0, 4);
    expect(t.parts[0]!.to).toBeCloseTo(0.6, 4);
    expect(t.worst).toBeCloseTo(0.9, 4);
  });

  test('missing page vectors and empty edge context cost the penalty', () => {
    const t = scoreRow(row('people/bo', ['people/bo|works_at|companies/acme']), inputs({
      edgeContext: new Map([['default:people/bo|works_at|companies/acme', '']]),
    }))!;
    expect(t.worst).toBeCloseTo(3 * 1.5 * 3, 4);
  });

  test('higher importance lowers the score; the worst hop decides', () => {
    const base = inputs({
      pageDistance: new Map([['default:a', 0.1], ['default:b', 0.1], ['default:c', 1.5]]),
      edgeContext: new Map([['default:a|knows|b', 'payment'], ['default:b|knows|c', 'payment']]),
    });
    const t = scoreRow(row('c', ['a|knows|b', 'b|knows|c']), base)!;
    expect(t.worst).toBe(Math.max(...t.parts.map(p => p.total)));
    expect(t.worst).toBeCloseTo((0.1 + 0 + 1.5) * 1.5, 4);
    const trusted = scoreRow(row('c', ['b|knows|c']), { ...base, pageImportance: new Map([['default:c', 0.6]]) })!;
    expect(trusted.worst).toBeLessThan((0.1 + 1.5) * 1.5);
  });
});

describe('relational arm with triplet scoring [pglite]', () => {
  let eng: PGLiteEngine;

  beforeAll(async () => {
    eng = new PGLiteEngine();
    await eng.connect({});
    await eng.initSchema();
    await eng.putPage('companies/acme-example', { type: 'company', title: 'Acme Example', compiled_truth: 'A company.', timeline: '' });
    for (let i = 0; i < 60; i++) {
      const slug = `people/a${String(i).padStart(2, '0')}-example`;
      await eng.putPage(slug, { type: 'person', title: `Person ${i}`, compiled_truth: 'Works at Acme.', timeline: '' });
      await installFixtureChunks(eng, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Works at Acme.' }]);
      await eng.addLink(slug, 'companies/acme-example', 'on the sales team', 'works_at', 'manual');
    }
    await eng.putPage('people/zed-example', { type: 'person', title: 'Zed Example', compiled_truth: 'Payments engineer.', timeline: '' });
    await installFixtureChunks(eng, 'people/zed-example', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Payments engineer.' }]);
    await eng.addLink('people/zed-example', 'companies/acme-example', 'leads the payments platform', 'works_at', 'manual');
  }, 60_000);

  afterAll(async () => {
    await eng.disconnect();
  });

  test('fanout rows carry their stored-direction path edges', async () => {
    const list = await buildRelationalArm(eng, 'who works at acme-example', { limit: 5 });
    expect(list.length).toBeGreaterThan(0);
    for (const r of list) expect(r.relational_path_edges).toEqual([`${r.slug}|works_at|companies/acme-example`]);
  });

  test('without scoring the alphabetical cut drops the relevant person; the wide fetch plus scoring keeps it first', async () => {
    const narrow = await buildRelationalArm(eng, 'who works at acme-example', { limit: 10 });
    expect(narrow.map(r => r.slug)).not.toContain('people/zed-example');
    const wide = await buildRelationalArm(eng, 'who works at acme-example', { limit: 100, wide: true });
    expect(wide.map(r => r.slug)).toContain('people/zed-example');
    const ran = await applyTripletScoring(eng, 'who works on payments at acme-example', wide, {
      queryEmbedding: null, column: 'embedding', keep: 10, penalty: 3,
    });
    expect(ran).toBe(true);
    expect(wide).toHaveLength(10);
    expect(wide[0]!.slug).toBe('people/zed-example');
    expect(wide[0]!.triplet!.worst).toBeLessThan(wide[1]!.triplet!.worst);
  });
});
