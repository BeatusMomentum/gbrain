/**
 * `sync --full` file walk: it runs without holding the event loop, a full sync
 * with nothing to delete walks the tree once, and a deletion is never decided
 * on runImport's walk alone.
 *
 * runImport walks the tree with `collectSyncableFilesAsync` and hands the
 * completed walk to performFullSync (`onCollected`). The hold settle and the
 * delete reconcile reuse it only when it completed for the same root with the
 * same options. The walk predates the import, so a file restored after it is
 * missing from it: when the reused walk names any page stale, the reconcile
 * walks the tree again and decides on that fresh listing.
 *
 * The git shim counts `git ls-files` listings and, on request, restores a file
 * right after the first listing is taken (between the import walk and the
 * reconcile).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { execFileSync, execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { performSync } from '../src/commands/sync.ts';
import { runImport } from '../src/commands/import.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'walk-once';
let engine: PGLiteEngine;
let repo: string;
let shimDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  const rows = await engine.executeRaw<{ id: string }>(`SELECT id FROM sources WHERE id = $1`, [SOURCE]);
  if (rows.length === 0) await runSources(engine, ['add', SOURCE, '--no-federated']);
  repo = mkdtempSync(join(tmpdir(), 'gbrain-walk-once-'));
  execSync('git init -q && git config user.email "t@example.com" && git config user.name "T"', { cwd: repo, stdio: 'pipe' });
  mkdirSync(join(repo, 'notes'), { recursive: true });
  for (const name of ['a', 'b', 'c', 'd']) {
    writeFileSync(join(repo, `notes/${name}.md`), note(name));
  }
  execSync('git add -A && git commit -q -m fixture', { cwd: repo, stdio: 'pipe' });
  shimDir = mkdtempSync(join(tmpdir(), 'gbrain-walk-once-shim-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(shimDir, { recursive: true, force: true });
});

function note(name: string): string {
  return `---\ntype: note\ntitle: Note ${name}\n---\n\nBody of ${name}.\n`;
}

function commit(message: string): void {
  execSync(`git add -A && git commit -q -m "${message}"`, { cwd: repo, stdio: 'pipe' });
}

function fullSync(opts: { exclude?: string[] } = {}) {
  return performSync(engine, { repoPath: repo, full: true, sourceId: SOURCE, noPull: true, noEmbed: true, ...opts });
}

/**
 * Runs `fn` with a git on PATH that records every syncable-file listing and returns
 * how many it saw. With `restoreAfterFirst`, the first listing is taken before that
 * file is written back, so only later listings can include it.
 */
async function countListings(fn: () => Promise<unknown>, restoreAfterFirst?: { rel: string; body: string }): Promise<number> {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const log = join(shimDir, 'listings.log');
  rmSync(log, { force: true });
  const restore = restoreAfterFirst ? join(shimDir, 'restore.md') : '';
  if (restoreAfterFirst) writeFileSync(restore, restoreAfterFirst.body);
  const target = restoreAfterFirst ? join(repo, restoreAfterFirst.rel) : '';
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh
case " $* " in
  *" ls-files --cached --others --exclude-standard "*)
    echo listing >> "${log}"
    out=$("${realGit}" "$@" | tr '\\0' '\\n'); rc=$?
    if [ -n "${restore}" ] && [ -f "${restore}" ]; then mv "${restore}" "${target}"; fi
    printf '%s\\n' "$out" | tr '\\n' '\\0'
    exit $rc ;;
esac
exec "${realGit}" "$@"
`, { mode: 0o755 });
  await withEnv({ PATH: `${shimDir}:${process.env.PATH}` }, fn);
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
}

async function liveSlugs(): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL ORDER BY slug`, [SOURCE],
  );
  return rows.map((r) => r.slug);
}

describe('sync --full file walk', () => {
  test('the import walk lets timers run while it lists and stats the tree', async () => {
    let fired = false;
    let firedBeforeWalkDone = null as boolean | null;
    const original = console.error;
    console.error = (...args: unknown[]) => {
      const line = String(args[0] ?? '');
      if (line.includes('[gbrain phase] import.collect_files start')) setTimeout(() => { fired = true; }, 0);
      else if (line.includes('[gbrain phase] import.collect_files done')) firedBeforeWalkDone = fired;
    };
    try {
      await fullSync();
    } finally {
      console.error = original;
    }
    // Between the phase's start and done lines a synchronous walk never yields.
    expect(firedBeforeWalkDone).toBe(true);
    expect(await liveSlugs()).toEqual(['notes/a', 'notes/b', 'notes/c', 'notes/d']);
  });

  test('a full sync with nothing to delete walks once, and the hold settle reuses the import walk', async () => {
    // #5988: a file whose frontmatter needs interpretation is held, not failed.
    writeFileSync(join(repo, 'notes/held.md'), '---\ntitle: first line\nsecond line\n---\nBody.\n');
    commit('add a held file');
    expect(await fullSync()).toMatchObject({ holds_outstanding: 1 });

    let second: unknown;
    expect(await countListings(async () => { second = await fullSync({ exclude: ['notes/b.md'] }); })).toBe(1);
    // The held file is still on disk, so its hold stays; the excluded b keeps its page.
    expect(second).toMatchObject({ holds_outstanding: 1 });
    expect(await liveSlugs()).toEqual(['notes/a', 'notes/b', 'notes/c', 'notes/d']);
  });

  test('a deletion is decided on a fresh walk: a file restored after the import walk keeps its page', async () => {
    await fullSync();
    expect(await liveSlugs()).toEqual(['notes/a', 'notes/b', 'notes/c', 'notes/d']);

    rmSync(join(repo, 'notes/c.md'));
    rmSync(join(repo, 'notes/d.md'));
    commit('remove c and d');

    // d is written back after the import walk listed the tree, before the reconcile.
    const listings = await countListings(() => fullSync({ exclude: ['notes/b.md'] }), { rel: 'notes/d.md', body: note('d') });
    // c is gone from the tree → soft-deleted. d is back on disk → kept. b is excluded but on disk → kept.
    expect(await liveSlugs()).toEqual(['notes/a', 'notes/b', 'notes/d']);
    expect(listings).toBe(2);
  });

  test('runImport hands over its walk only when the walk completed unaborted', async () => {
    const handed: unknown[] = [];
    await runImport(engine, [repo, '--no-embed'], { sourceId: SOURCE, onCollected: (walk) => { handed.push(walk); } });
    expect(handed).toEqual([expect.objectContaining({ complete: true, root: repo, files: ['notes/a.md', 'notes/b.md', 'notes/c.md', 'notes/d.md'] })]);

    handed.length = 0;
    const controller = new AbortController();
    const original = console.error;
    console.error = (...args: unknown[]) => {
      if (String(args[0] ?? '').includes('[gbrain phase] import.collect_files start')) controller.abort();
    };
    try {
      await runImport(engine, [repo, '--no-embed'], { sourceId: SOURCE, signal: controller.signal, onCollected: (walk) => { handed.push(walk); } }).catch(() => undefined);
    } finally {
      console.error = original;
    }
    expect(controller.signal.aborted).toBe(true);
    expect(handed).toEqual([]);
  });
});
