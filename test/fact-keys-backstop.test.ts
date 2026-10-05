/**
 * Fact keys through the facts backstop (docs/designs/FACT_KEYS.md): a page
 * write's extraction publishes keys from the extractor's own output when
 * `search.fact_keys` is on, keeps the page untouched when it is off, and
 * publishes nothing when the stored page no longer holds the extracted text.
 * PGLite + chat/embed transport stubs; no network.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsBackstop } from '../src/core/facts/backstop.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests, configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';
import { installPageProjection, preparePageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';

let engine: PGLiteEngine;
const slug = 'meetings/synthetic-keys';
const body = 'Alice-example confirmed the offsite moves to the lake cabin in June. The cedar deck repair is on the list before then.';
const embedded: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  embedded.length = 0;
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    embedded.push(...values);
    return { embeddings: values.map((_, i) => Array.from({ length: 1536 }, (_, j) => (j === i % 1536 ? 1 : 0.01))) };
  }) as never);
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({ facts: [
      { fact: 'The offsite moves to the lake cabin in June', kind: 'event', entity: null, confidence: 1, notability: 'high' },
      { fact: 'The cedar deck needs repair', kind: 'fact', entity: null, confidence: 1, notability: 'low' },
    ] }),
    blocks: [], stopReason: 'end', model: 'test:stub', providerId: 'test',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
  }));
  await engine.executeRaw('DELETE FROM pages');
  await engine.putPage(slug, { type: 'meeting', title: 'Synthetic keys', compiled_truth: body, timeline: '' });
  const prepared = (await readProjectionSnapshot(engine, slug, 'default', { allowUnsealed: true }))!;
  await installPageProjection(engine, prepared, (await preparePageProjection(prepared)).chunks, { seal: true });
  await engine.executeRaw("UPDATE pages SET contextual_retrieval_mode='title' WHERE slug=$1", [slug]);
  await engine.setConfig('facts.default_visibility', 'world');
});
afterEach(async () => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  __resetFactsQueueForTests();
  await engine.setConfig('search.fact_keys', 'off');
});

const keyed = () => engine.executeRaw<{ fact_keys: string | null; embedded: boolean }>(
  'SELECT fact_keys, embedding IS NOT NULL AS embedded FROM content_chunks ORDER BY chunk_index');
const page = (text = body) => ({ slug, type: 'meeting' as const, compiled_truth: text, frontmatter: {} as Record<string, unknown> });
const ctx = () => ({ engine, sourceId: 'default', sessionId: null, source: 'mcp:put_page' as const, mode: 'inline' as const, notabilityFilter: 'all' as const });

test('extraction publishes every extracted fact as a key when fact keys are on', async () => {
  await engine.setConfig('search.fact_keys', 'on');
  const result = await runFactsBackstop(page(), ctx());
  expect(result).toMatchObject({ mode: 'inline', inserted: 2 });
  expect(await keyed()).toEqual([{ fact_keys: 'The offsite moves to the lake cabin in June; The cedar deck needs repair', embedded: true }]);
  expect(embedded).toContain(`<context>Synthetic keys\nFacts: The offsite moves to the lake cabin in June; The cedar deck needs repair\n</context>\n${body}`);
  const rows = await engine.executeRaw<{ item_text: string; visibility: string }>('SELECT item_text,visibility FROM page_fact_keys ORDER BY ordinal');
  expect(rows).toEqual([
    { item_text: 'The offsite moves to the lake cabin in June', visibility: 'world' },
    { item_text: 'The cedar deck needs repair', visibility: 'world' },
  ]);
});

test('fact keys off: extraction runs and the page keeps its chunks unkeyed', async () => {
  const result = await runFactsBackstop(page(), ctx());
  expect(result).toMatchObject({ mode: 'inline', inserted: 2 });
  expect((await keyed()).map(r => r.fact_keys)).toEqual([null]);
  expect(await engine.executeRaw('SELECT 1 FROM page_fact_keys')).toEqual([]);
});

test('text that no longer matches the stored page publishes no keys', async () => {
  await engine.setConfig('search.fact_keys', 'on');
  await runFactsBackstop(page(`${body} An older draft.`), ctx());
  expect((await keyed()).map(r => r.fact_keys)).toEqual([null]);
  expect(await engine.executeRaw('SELECT 1 FROM page_fact_keys')).toEqual([]);
});
