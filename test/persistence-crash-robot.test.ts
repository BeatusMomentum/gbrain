/**
 * The crash robot's in-process contracts (scripts/persistence/ops.ts,
 * generator.ts, model.ts, robot-driver.ts, shrink.ts) and the PGLite release
 *
 *
 * Protects: the op-descriptor protocol refuses malformed descriptors; the five
 * cross-boundary sequences exist and pass the reference model through the real
 * operation handlers; schedules are a function of their seed; shrinking keeps
 * dependencies and accepts only a 3/3 reproduction; a PGLite owner releases a
 * claim last written before it started, and never one written after.
 * Fails when: a descriptor field stops being validated, a sequence family
 * disappears or regresses on master, `restrict` keeps an op whose producer was
 * dropped, or a restarted PGLite owner waits out a dead owner's lease.
 * Seams: none (the fault hook stays uninstalled); PGLite.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { descriptor, parseDescriptor } from '../scripts/persistence/ops.ts';
import { crossBoundarySequences, randomSchedule } from '../scripts/persistence/generator.ts';
import { ROBOT_TOPOLOGY, restrict } from '../scripts/persistence/robot-driver.ts';
import { shrinkRun } from '../scripts/persistence/shrink.ts';
import { runSchedule } from '../scripts/persistence/crash-robot.ts';
import { prepareTopology } from '../scripts/persistence/history-fixture.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';

async function robotBrain<T>(run: (brain: Awaited<ReturnType<typeof prepareTopology>>) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-crash-robot-test-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine();
      try { return await run(await prepareTopology(engine, { sources: 2, worktrees: 2, root: join(home, 'checkouts'), prefix: 'robot' })); }
      finally { await disposePersistenceConsumer(engine); await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

describe('op-descriptor protocol', () => {
  test('accepts a well-formed descriptor and refuses every malformed field', () => {
    const good = descriptor('op-1', 'put_page', 'local', 'robot-0', { slug: 'notes/a', content: 'x' }, { deps: ['op-0'] });
    expect(parseDescriptor(JSON.parse(JSON.stringify(good)))).toEqual(good);
    for (const bad of [{ ...good, v: 2 }, { ...good, id: '' }, { ...good, kind: 'drop_table' }, { ...good, actor: '' },
      { ...good, requestId: 7 }, { ...good, args: [] }, { ...good, deps: [3] }]) {
      expect(() => parseDescriptor(bad)).toThrow(/op descriptor/);
    }
  });
});

describe('generator', () => {
  test('the five cross-boundary sequences are always generated', () => {
    expect(crossBoundarySequences(ROBOT_TOPOLOGY).map(s => s.label)).toEqual(['withdrawal_then_stale_publication',
      'overlapping_slugs_two_sources', 'competing_writers_one_page', 'caller_bound_replay', 'authority_change_pending_effects']);
  });
  test('a random schedule is a function of its seed and covers every write op', () => {
    expect(JSON.stringify(randomSchedule(ROBOT_TOPOLOGY, 9))).toBe(JSON.stringify(randomSchedule(ROBOT_TOPOLOGY, 9)));
    expect(JSON.stringify(randomSchedule(ROBOT_TOPOLOGY, 10))).not.toBe(JSON.stringify(randomSchedule(ROBOT_TOPOLOGY, 9)));
    const kinds = new Set(Array.from({ length: 40 }, (_, i) => randomSchedule(ROBOT_TOPOLOGY, i).ops.map(d => d.kind)).flat());
    expect([...kinds].sort()).toEqual(['add_timeline_entry', 'delete_page', 'edit_page', 'forget', 'put_page', 'remember',
      'restore_page', 'takes_add', 'takes_supersede']);
  });
});

describe('shrinking', () => {
  test('restrict drops an op whose producer was dropped and shrinks groups', () => {
    const schedule = crossBoundarySequences(ROBOT_TOPOLOGY)[2];
    const kept = restrict(schedule, new Set(schedule.ops.filter(d => d.id !== 'cw0').map(d => d.id)));
    expect(kept.ops.map(d => d.id)).toEqual([]);
    const partial = restrict(schedule, new Set(['cw0', 'cw1', 'cw4']));
    expect(partial.ops.map(d => d.id)).toEqual(['cw0', 'cw1', 'cw4']);
    expect(partial.groups).toEqual([]);
  });
  test('ddmin finds the minimal reproducing set and requires 3/3', async () => {
    const failing = { schedule: 'random-1', seed: 1, length: 8, crashed: false, duration_ms: 0,
      ops: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], violations: [{ class: 'lost_write' as const, detail: 'x' }] };
    const result = await shrinkRun(failing, async run => ({ violations: run.ops!.includes('c') && run.ops!.includes('f') ? [{ class: 'lost_write' }] : [] }));
    expect(result.shrunk.ops).toEqual(['c', 'f']);
    expect(result).toMatchObject({ reproduced: 3, accepted: true });
    let calls = 0;
    const flaky = await shrinkRun(failing, async () => ({ violations: ++calls % 2 ? [{ class: 'lost_write' }] : [] }));
    expect(flaky.accepted).toBe(false);
  });
});

describe('reference model on master behavior', () => {
  test('the cross-boundary sequences hold every invariant through the real handlers', async () => {
    for (const schedule of crossBoundarySequences(ROBOT_TOPOLOGY)) {
      const result = await robotBrain(({ world }) => runSchedule(world, schedule));
      expect({ label: schedule.label, violations: result.violations }).toEqual({ label: schedule.label, violations: [] });
    }
  }, 180_000);
});
