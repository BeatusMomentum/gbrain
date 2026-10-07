// W9F item 3: unmanaged concept publication binds its file write to the file
// it read under the page lock.
//
// Protects: on an unmanaged brain a narrative, frontmatter or tag edit made
// to a concept's markdown file (not yet imported) is never overwritten by
// `publishClassicConcept`; an edit that lands while the database import runs
// is kept too (the file write rechecks the bytes it read); both defer with
// `revision_conflict`, and the concept publishes once sync imports the edit.
// A file that differs only in formatting publishes on the first try, and a
// failed file write holds the concept instead of reporting success.
// Fails when: the publication compares only the database row with its
// baseline (the pre-fix behavior) and rewrites the file from the database,
// silently dropping the user's edit, or swallows a write-through failure.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { publishClassicConcept } from '../../src/core/cycle/concept-publication.ts';
import { _resetWriteThroughCacheForTest, writePageThrough } from '../../src/core/write-through.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

const SLUG = 'concepts/launch-dates';
const BASELINE = 'Launch dates slip when nobody owns them.';
const SYNTHESIZED = 'SYNTHESIZED: launch dates need a single owner.';
let engine: PGLiteEngine;
let repo: string;
let file: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

const frontmatter = { synthesized_by: 'synthesize_concepts-v0.41', tier: 2, member_hash: 'h1', visibility: 'world' };

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetWriteThroughCacheForTest();
  repo = mkdtempSync(join(tmpdir(), 'gbrain-concept-recheck-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [repo]);
  await importFromContent(engine, SLUG, serializeMarkdown(frontmatter, BASELINE, '', { type: 'concept', title: 'launch dates', tags: ['ops'] }), { noEmbed: true });
  const written = await writePageThrough(engine, SLUG, { sourceId: 'default' });
  expect(written.written).toBe(true);
  file = written.path!;
});

const importPage = (markdown: string) => importFromContent(engine, SLUG, markdown, { noEmbed: true });
const publish = (opts: { importPage?: (markdown: string) => Promise<unknown> } = {}) => publishClassicConcept(engine, SLUG, 'default',
  { ...frontmatter, member_hash: 'h2' }, SYNTHESIZED, BASELINE, { writeThrough: false, importPage: opts.importPage ?? importPage });
const codeOf = async (p: Promise<unknown>) => p.then(() => 'published', (err: { code?: string }) => err.code ?? String(err));

describe('publishClassicConcept file recheck (W9F item 3)', () => {
  test('a narrative edit made only to the file defers and survives', async () => {
    writeFileSync(file, readFileSync(file, 'utf-8').replace(BASELINE, `${BASELINE}\n\nUSER EDIT: the board owns launch dates.`));
    expect(await codeOf(publish())).toBe('revision_conflict');
    expect(readFileSync(file, 'utf-8')).toContain('USER EDIT: the board owns launch dates.');
    expect((await engine.getPage(SLUG))!.compiled_truth).toBe(BASELINE);
  });

  test('a frontmatter-only or tag-only edit to the file defers and survives', async () => {
    const original = readFileSync(file, 'utf-8');
    writeFileSync(file, original.replace('tier: 2', 'tier: 2\nowner: alice-example'));
    expect(await codeOf(publish())).toBe('revision_conflict');
    expect(readFileSync(file, 'utf-8')).toContain('owner: alice-example');

    writeFileSync(file, original.replace('  - ops', '  - ops\n  - launch'));
    expect(await codeOf(publish())).toBe('revision_conflict');
    expect(readFileSync(file, 'utf-8')).toContain('- launch');
  });

  test('an edit landing while the database import runs is kept', async () => {
    const outcome = await codeOf(publish({
      importPage: async (markdown) => {
        const result = await importPage(markdown);
        writeFileSync(file, readFileSync(file, 'utf-8').replace(BASELINE, `${BASELINE} MID-IMPORT EDIT.`));
        return result;
      },
    }));
    expect(outcome).toBe('revision_conflict');
    expect(readFileSync(file, 'utf-8')).toContain('MID-IMPORT EDIT.');
    expect(readFileSync(file, 'utf-8')).not.toContain(SYNTHESIZED);
  });

  test('a formatting-only difference publishes on the first try', async () => {
    const original = readFileSync(file, 'utf-8');
    const reordered = original.replace('tier: 2\n', '').replace('member_hash: h1\n', 'member_hash: h1\ntier: 2\n')
      .replace(BASELINE, `\n\n${BASELINE}\n\n\n`);
    expect(reordered).not.toBe(original);
    writeFileSync(file, reordered);
    expect(await codeOf(publish())).toBe('published');
    expect(readFileSync(file, 'utf-8')).toContain(SYNTHESIZED);
  });

  test('a deferred concept publishes once sync imports the edit', async () => {
    writeFileSync(file, readFileSync(file, 'utf-8').replace(BASELINE, `${BASELINE} USER EDIT.`));
    expect(await codeOf(publish())).toBe('revision_conflict');
    await importFromContent(engine, SLUG, readFileSync(file, 'utf-8'), { noEmbed: true });
    const baseline = (await engine.getPage(SLUG))!.compiled_truth;
    await publishClassicConcept(engine, SLUG, 'default', { ...frontmatter, member_hash: 'h2' }, SYNTHESIZED, baseline,
      { writeThrough: false, importPage });
    expect(readFileSync(file, 'utf-8')).toContain(SYNTHESIZED);
  });

  test('a failed file write holds the concept instead of reporting success', async () => {
    const dir = join(repo, 'concepts');
    chmodSync(dir, 0o555);
    try {
      expect(await codeOf(publish())).toBe('concept_write_through_failed');
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(readFileSync(file, 'utf-8')).toContain(BASELINE);
  });
});
