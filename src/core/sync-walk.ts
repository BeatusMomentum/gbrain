/**
 * Git-aware file enumeration shared by the synchronous import walker
 * (`collectSyncableFiles` in commands/import.ts) and its non-blocking twin
 * (`collectSyncableFilesAsync`), plus the token that lets a full sync reuse
 * runImport's walk.
 *
 * Both walkers list a tree with `git ls-files` and feed every entry through
 * `gitListCandidates`, so their filters cannot drift. The async walker runs
 * `git ls-files` and the ignored-directory probe as awaited children and the
 * per-file lstat through a bounded pool, so a large tree on a slow filesystem
 * no longer holds the event loop (other sources' database handshakes, lock
 * heartbeats and timers keep running). This module imports nothing from
 * commands/, so commands/import.ts can depend on it without a cycle.
 */
import { execFile } from 'child_process';
import { lstat } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { hasMalformedPathSegment } from './sync.ts';
import { runWithLimit } from './worker-pool.ts';
import type { SyncStrategy } from './sync.ts';

export const GIT_LS_FILES_ARGS = ['ls-files', '--cached', '--others', '--exclude-standard', '-z'] as const;
export const GIT_CHECK_IGNORE_ARGS = ['check-ignore', '-q', '.'] as const;
export const GIT_LS_FILES_MAX_BUFFER = 512 * 1024 * 1024;
/** lstat calls in flight per async walk; the runtime's I/O pool bounds real parallelism. */
const WALK_LSTAT_CONCURRENCY = 32;
const execFileAsync = promisify(execFile);

/**
 * The `git ls-files -z` entries that pass the walker filters, as absolute
 * paths in listing order. The malformed-name check runs first and is
 * reported through `onExcluded`, because it hides renameable content; the
 * other filters (`accept`: strategy, prune, metafile) are silent by design.
 */
export function gitListCandidates(dir: string, stdout: string, accept: (relPath: string) => boolean,
  onExcluded?: (relPath: string) => void): string[] {
  const candidates: string[] = [];
  for (const rel of stdout.split('\0')) {
    if (!rel) continue;
    if (hasMalformedPathSegment(rel)) { onExcluded?.(rel); continue; }
    if (accept(rel)) candidates.push(join(dir, rel));
  }
  return candidates;
}

/**
 * The git fast path without blocking the event loop: same filters, same
 * no-symlink rule (submodule gitlinks drop out as non-regular entries), same
 * sorted output, and the same `null` signal into the FS-walk fallback for a
 * non-git directory or one the enclosing repository ignores.
 */
export async function gitListSyncableFilesAsync(dir: string, accept: (relPath: string) => boolean,
  onExcluded?: (relPath: string) => void): Promise<string[] | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', ['-C', dir, ...GIT_LS_FILES_ARGS], { encoding: 'utf8', maxBuffer: GIT_LS_FILES_MAX_BUFFER }));
  } catch {
    return null;
  }
  if (stdout === '' && await execFileAsync('git', ['-C', dir, ...GIT_CHECK_IGNORE_ARGS]).then(() => true, () => false)) return null;
  const candidates = gitListCandidates(dir, stdout, accept, onExcluded);
  // A rejected lstat (ls-files raced a deletion, or unreadable) drops the file, like the synchronous loop.
  const regular = await runWithLimit({
    items: candidates,
    limit: WALK_LSTAT_CONCURRENCY,
    fn: async (full: string) => {
      const st = await lstat(full);
      return !st.isSymbolicLink() && st.isFile();
    },
  });
  return candidates.filter((_, i) => regular[i].ok && regular[i].value).sort();
}

/** The options that decide what a walk lists. */
export interface WalkOptions { strategy: SyncStrategy; includeGitignored: boolean; includeHidden: string[]; exclude: string[] }

/**
 * runImport's walk handed to a full sync. `complete` is set only when the walk
 * returned and the run was not aborted; `files` are root-relative, taken
 * before `--exclude` (the same set the full sync's own walk would list).
 */
export interface CollectedWalk { complete: true; root: string; options: WalkOptions; files: string[] }

export function walkOptions(opts: { strategy?: SyncStrategy; includeGitignored?: boolean; includeHidden?: string[]; exclude?: string[] }): WalkOptions {
  return { strategy: opts.strategy ?? 'markdown', includeGitignored: opts.includeGitignored ?? false,
    includeHidden: [...(opts.includeHidden ?? [])], exclude: [...(opts.exclude ?? [])] };
}

/** A walk may stand in for a fresh one only when it completed for the same root with identical options. */
export function reusableWalk(walk: CollectedWalk | undefined, root: string, options: WalkOptions): walk is CollectedWalk {
  if (walk?.complete !== true || walk.root !== root) return false;
  const a = walk.options;
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((value, i) => value === y[i]);
  return a.strategy === options.strategy && a.includeGitignored === options.includeGitignored
    && same(a.includeHidden, options.includeHidden) && same(a.exclude, options.exclude);
}
