/**
 * Bootstrap progression regression test.
 *
 * extractTakesFromPages selected pages by updated_at DESC + LIMIT with no
 * exclusion of pages that already hold takes — so on a corpus larger than
 * one run's cap (the CLI clamps --max-pages to 1000), every re-run rescanned
 * the same most-recent slice: the older tail could never be bootstrapped,
 * and each rescan re-spent LLM budget producing upsert-identical rows.
 * Seen live on a 2,311-eligible-page brain where the second run would have
 * covered 0 new pages.
 *
 * Pins: covered pages are skipped by default (runs progress), and
 * includeCovered restores the full rescan (refresh semantics).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';
import { extractTakesFromPages } from '../src/core/extract-takes-from-pages.ts';

let engine: PGLiteEngine;
let repo: string;

/** #4473: takes are md-first — each probe page needs a real .md home. */
function seedMd(slug: string, body: string): void {
  writeFileSync(join(repo, `${slug}.md`), `# ${slug}\n\n${body}\n`, 'utf-8');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  repo = mkdtempSync(join(tmpdir(), 'gb-takes-progression-'));
  mkdirSync(join(repo, 'concepts'), { recursive: true });
  await engine.setConfig('sync.repo_path', repo);

  configureGateway({
    chat_model: 'anthropic:claude-haiku-4-5-20251001',
    env: { ANTHROPIC_API_KEY: 'sk-ant-test-takes-progression' },
  });
  __setChatTransportForTests(async () => ({
    text: '[{"claim":"a stubbed claim","kind":"take","weight":0.7}]',
    blocks: [{ type: 'text' as const, text: '[{"claim":"a stubbed claim","kind":"take","weight":0.7}]' }],
    stopReason: 'end' as const,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5-20251001',
    providerId: 'anthropic',
  }));

  const body = 'An opinion-bearing body long enough to clear the 200-char eligibility floor. '.repeat(5);
  await engine.putPage('concepts/progression-a', {
    type: 'concept', title: 'A', compiled_truth: body, frontmatter: {},
  });
  await engine.putPage('concepts/progression-b', {
    type: 'concept', title: 'B', compiled_truth: body, frontmatter: {},
  });
  seedMd('concepts/progression-a', body);
  seedMd('concepts/progression-b', body);
});

afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(repo, { recursive: true, force: true });
});

describe('extractTakesFromPages — bootstrap progression', () => {
  test('first run covers the eligible pages', async () => {
    const r1 = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(r1.pages_scanned).toBe(2);
    expect(r1.claims_extracted).toBe(2);
  });

  test('second run skips covered pages — repeat runs progress instead of rescanning', async () => {
    const r2 = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(r2.pages_scanned).toBe(0);
    expect(r2.claims_extracted).toBe(0);
  });

  test('a page added after the first run is picked up (progression, not a frozen set)', async () => {
    const body = 'Another opinion-bearing body long enough to clear the eligibility floor. '.repeat(5);
    await engine.putPage('concepts/progression-c', {
      type: 'concept', title: 'C', compiled_truth: body, frontmatter: {},
    });
    seedMd('concepts/progression-c', body);
    const r3 = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(r3.pages_scanned).toBe(1);
  });

  test('includeCovered rescans everything (refresh semantics)', async () => {
    const r4 = await extractTakesFromPages(engine, {
      bootstrapEnabled: true, maxPages: 50, includeCovered: true,
    });
    expect(r4.pages_scanned).toBe(3);
  });

  // #5059: a page that yields zero claims stays uncovered, so the plain
  // updated_at-DESC selection re-picked it first forever. next_before is the
  // exact (updated_at, id) keyset position of the last processed page.
  function transport(textFor: (content: string) => string | Error): void {
    __setChatTransportForTests(async (opts) => {
      const content = String(opts.messages[0]?.content ?? '');
      const text = textFor(content);
      if (text instanceof Error) throw text;
      return {
        text,
        blocks: [{ type: 'text' as const, text }],
        stopReason: 'end' as const,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5-20251001',
        providerId: 'anthropic',
      };
    });
  }

  function cursorOf(nextBefore: string | null): { updatedAt: string; id: number } {
    const separator = nextBefore!.lastIndexOf(',');
    return { updatedAt: nextBefore!.slice(0, separator), id: Number(nextBefore!.slice(separator + 1)) };
  }

  async function seedAt(slug: string, at: string): Promise<number> {
    const body = `A narrative body for ${slug} long enough to clear the 200-char eligibility floor. `.repeat(4);
    await engine.putPage(slug, { type: 'concept', title: slug, compiled_truth: body, frontmatter: {} });
    seedMd(slug, body);
    await engine.executeRaw(`UPDATE pages SET updated_at = $2::text::timestamptz WHERE slug = $1`, [slug, at]);
    const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [slug]);
    return row!.id;
  }

  test('a cursor advances past a newest page that yields no claims (equal timestamps break on id)', async () => {
    const olderSlug = 'concepts/claim-bearing-older';
    const newestSlug = 'concepts/zero-claim-newest';
    await seedAt(olderSlug, '2030-01-02T03:04:05.123456Z');
    const newestId = await seedAt(newestSlug, '2030-01-02T03:04:05.123456Z');
    transport((content) => content.includes(newestSlug) ? '[]' : '[{"claim":"an older claim","kind":"take","weight":0.7}]');

    const first = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 1, sourceIdFilter: 'default' });
    expect(first.pages_scanned).toBe(1);
    expect(first.claims_extracted).toBe(0);
    expect(first.next_before).toEndWith(`,${newestId}`);

    const again = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 1, sourceIdFilter: 'default' });
    expect(again.next_before).toBe(first.next_before);

    const second = await extractTakesFromPages(engine, {
      bootstrapEnabled: true, maxPages: 1, sourceIdFilter: 'default', before: cursorOf(first.next_before),
    });
    expect(second.pages_scanned).toBe(1);
    expect(second.claims_extracted).toBe(1);
  });

  test('the cursor keeps microsecond precision: a page 1 microsecond older is not skipped', async () => {
    await seedAt('concepts/micro-newer', '2031-05-06T07:08:09.123457Z');
    await seedAt('concepts/micro-older', '2031-05-06T07:08:09.123456Z');
    transport(() => '[]');
    const first = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 1, dryRun: true });
    expect(first.next_before).toContain('.123457');
    let seen = '';
    transport((content) => { seen = content; return '[]'; });
    const second = await extractTakesFromPages(engine, {
      bootstrapEnabled: true, maxPages: 1, dryRun: true, before: cursorOf(first.next_before),
    });
    expect(second.pages_scanned).toBe(1);
    expect(seen).toContain('concepts/micro-older');
  });

  test('a page whose model call failed is reported and selected again by a run without --before', async () => {
    const failing = 'concepts/flaky-newest';
    const failingId = await seedAt(failing, '2032-01-01T00:00:00.000001Z');
    transport((content) => content.includes(failing) ? new Error('provider overloaded') : '[]');
    const first = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 1 });
    expect(first.skipped).toEqual([{ slug: failing, reason: expect.stringMatching(/^llm_error:/) }]);
    expect(first.next_before).toEndWith(`,${failingId}`);

    transport(() => '[{"claim":"recovered claim","kind":"take","weight":0.6}]');
    const retry = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 1 });
    expect(retry.pages_scanned).toBe(1);
    expect(retry.claims_extracted).toBe(1);
    const [covered] = await engine.executeRaw<{ n: number }>(
      'SELECT count(*)::int AS n FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1', [failing]);
    expect(covered!.n).toBe(1);
  });
});
