/**
 * #5828: which pages the brain_score timeline component grades.
 *
 * The 15-point timeline component rewards pages that have a history or are
 * events, so it grades only linkable pages whose type's active-pack
 * primitive is `entity` or `temporal` (aliases resolve to their canonical
 * type). Reference documents (`media`, `concept`, `annotation`) have no
 * events to record and are not graded. Types the pack does not declare,
 * untyped pages, and every page when no pack resolves stay graded, so a
 * brain only changes when its pack says a type is a document.
 */
import type { BrainEngine } from './engine.ts';
import { loadActivePackForLocalEngine } from './schema-pack/best-effort.ts';
import { classifyStoredType } from './schema-pack/type-usage.ts';

const TIMELINE_PRIMITIVES: ReadonlySet<string> = new Set(['entity', 'temporal']);

export async function loadTimelineGradedPredicate(
  engine: Pick<BrainEngine, 'getConfig'>,
): Promise<(type: string) => boolean> {
  const pack = await loadActivePackForLocalEngine(engine);
  if (!pack) return () => true;
  const primitiveOf = new Map(pack.manifest.page_types.map((t) => [t.name, t.primitive as string]));
  return (type) => {
    if (!type) return true;
    const cls = classifyStoredType(type, pack.manifest);
    if (cls.kind === 'undeclared') return true;
    return TIMELINE_PRIMITIVES.has(primitiveOf.get(cls.kind === 'canonical' ? type : cls.canonical) ?? '');
  };
}

/** Linkable pages the timeline component grades, and how many of them carry a timeline row. */
export async function gradeTimelinePages(
  engine: Pick<BrainEngine, 'getConfig'>,
  linkablePages: ReadonlyArray<{ type: string; has_timeline: boolean }>,
): Promise<{ graded: number; withTimeline: number }> {
  const isGraded = await loadTimelineGradedPredicate(engine);
  const graded = linkablePages.filter((row) => isGraded(row.type));
  return { graded: graded.length, withTimeline: graded.filter((row) => row.has_timeline).length };
}
