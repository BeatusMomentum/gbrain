/**
 * #5876 (honest half): `auto_chronicle=true` has no reader in this version.
 *
 * Protects: the chronicle advisor no longer tells users to enable
 * auto_chronicle, and both the advisor and doctor say plainly that
 * `auto_chronicle=true` currently has no effect, naming the manual sweep.
 * Fails when: the coverage-gap finding recommends enabling the dead setting,
 * or a brain with it on gets no advisor/doctor signal.
 * Seams: none; in-memory PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { collectChronicle } from '../src/core/advisor/collect-chronicle.ts';
import type { AdvisorContext } from '../src/core/advisor/types.ts';
import { autoChronicleEntry } from '../src/commands/doctor/checks/auto-chronicle.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import type { Check } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;
const advisorCtx = () => ({ engine, remote: false } as unknown as AdvisorContext);
const doctorCtx = () => ({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext);

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await engine.unsetConfig('auto_chronicle'); });

describe('advisor', () => {
  test('the coverage gap names only the sweep, never the dead setting', async () => {
    await engine.putPage('meetings/2026-04-03', { type: 'meeting', title: 'Weekly sync', compiled_truth: 'x'.repeat(120) });
    const gap = (await collectChronicle.collect(advisorCtx())).find(f => f.id === 'chronicle_coverage_gap')!;
    expect(gap.detail).not.toContain('auto_chronicle');
  });

  test('auto_chronicle=true is reported as having no effect', async () => {
    expect((await collectChronicle.collect(advisorCtx())).some(f => f.id === 'auto_chronicle_no_effect')).toBe(false);
    await engine.setConfig('auto_chronicle', 'true');
    const finding = (await collectChronicle.collect(advisorCtx())).find(f => f.id === 'auto_chronicle_no_effect')!;
    expect(finding).toMatchObject({ severity: 'warn', title: 'auto_chronicle=true currently has no effect' });
    expect(finding.fix.command_argv).toEqual(['gbrain', 'chronicle-backfill', '--dry-run']);
  });
});

describe('doctor', () => {
  test('auto_chronicle check: ok when off, warn with code and fix when on', async () => {
    expect(categorizeCheck('auto_chronicle')).toBe('brain');
    const [off] = await autoChronicleEntry.run(doctorCtx()) as Check[];
    expect(off).toMatchObject({ name: 'auto_chronicle', status: 'ok' });
    await engine.setConfig('auto_chronicle', 'true');
    const [on] = await autoChronicleEntry.run(doctorCtx()) as Check[];
    expect(on).toMatchObject({ name: 'auto_chronicle', status: 'warn', details: { code: 'auto_chronicle_no_effect',
      fix: 'gbrain chronicle-backfill --dry-run', docs: 'docs/guides/troubleshooting.md#auto_chronicle-has-no-effect' } });
    expect(on.message).toContain('currently has no effect');
  });
});
