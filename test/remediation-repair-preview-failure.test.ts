/**
 * #6000: the remediation plan previews every automatic repair kind, and one
 * kind's preview can fail on a large brain (a statement timeout). That kind is
 * reported through the agent contract (code, redacted and capped message,
 * why, the read-only preview as `fix` with a read-only `verify`), and every
 * other kind is still planned, by `doctor --remediation-plan` and by
 * `doctor --remediate`, which exits 1 because the failed kind did not run. A
 * caller that records nothing still gets the error. A plan approved while the
 * preview failed no longer matches once the preview succeeds, so the run
 * refuses with `preview_changed` (the safe direction).
 *
 * Protects: the plan and the run completing around one failing preview, the
 * failure staying visible (plan JSON, run result, exit status) without
 * leaking connection details, and consent staying bound to what was shown.
 * Fails when: one kind's preview aborts the plan or the run again, a failed
 * preview disappears from the output, or its error text is echoed raw.
 * Seams: none; the failing and the pending preview are the registered
 * handlers' own `plan` methods, replaced for the test.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { RepairHandler, RepairKind } from '../src/core/repair/core.ts';
import { AUTO_REPAIR_REGISTRY, repairSpec } from '../src/core/repair/registry.ts';
import { planRepairSteps } from '../src/core/remediation/repairs.ts';
import { computeRemediationPlan, runRemediation } from '../src/core/remediation/index.ts';
import { remediationExitStatus, renderRemediationPlanLines, runRemediate } from '../src/commands/doctor/remediate.ts';
import { remediationPlanHash } from '../src/commands/doctor/remediate-consent.ts';
import { setCliExitVerdict } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';

const TIMEOUT = 'canceling statement due to statement timeout';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-preview-failure-'));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

/** Runs `fn` with the given kinds' previews replaced, restoring the registered ones afterwards. */
async function withPreviews<T>(previews: Partial<Record<RepairKind, RepairHandler['plan']>>, fn: () => Promise<T>): Promise<T> {
  const originals = Object.keys(previews).map(kind => [repairSpec(kind as RepairKind).handler, repairSpec(kind as RepairKind).handler.plan] as const);
  for (const [kind, plan] of Object.entries(previews)) repairSpec(kind as RepairKind).handler.plan = plan!;
  try { return await withEnv({ GBRAIN_HOME: home, GBRAIN_NON_INTERACTIVE: '1' }, fn); } finally { for (const [handler, plan] of originals) handler.plan = plan; }
}

const pending = (slug: string): RepairHandler['plan'] =>
  async () => ({ items: [{ cursor: { phase: 0, id: 1 }, source_id: '(brain)', slug, chars: 0, action: 'analyze (fixture)' }], residuals: {} });

/** attribution-backfill times out; planner-stats, which previews after it, has one table to analyze. */
const PREVIEWS: Partial<Record<RepairKind, RepairHandler['plan']>> = {
  'attribution-backfill': async () => { throw Object.assign(new Error(TIMEOUT), { code: '57014' }); },
  'planner-stats': pending('pages'),
};

const expectTimeoutFailure = (failures: unknown) => expect(structuredClone(failures)).toMatchObject([{
  kind: 'attribution-backfill', code: 'timeout', message: TIMEOUT,
  why: expect.stringContaining('GBRAIN_STATEMENT_TIMEOUT'),
  fix: { argv: expect.arrayContaining(['gbrain', 'repair', 'attribution-backfill']), command: expect.stringContaining('gbrain repair attribution-backfill'),
    next: 'run', consent: [], verify: { argv: expect.arrayContaining(['gbrain', 'doctor', '--remediation-plan', '--json']) } },
}]);

describe('a repair preview that fails (#6000)', () => {
  test('the fixture previews planner-stats after attribution-backfill', () => {
    const order = AUTO_REPAIR_REGISTRY.map(spec => spec.kind);
    expect(order.indexOf('planner-stats')).toBeGreaterThan(order.indexOf('attribution-backfill'));
  });

  test('doctor --remediation-plan lists the failed kind through the contract and still plans the others', async () => {
    const plan = await withPreviews(PREVIEWS, () => computeRemediationPlan(engine, { repairs: {} }));
    expectTimeoutFailure(plan.repair_preview_failures);
    expect(plan.repair_steps!.map(step => [step.kind, step.affected])).toContainEqual(['planner-stats', 1]);
    expect(plan.repair_steps!.some(step => step.kind === 'attribution-backfill')).toBe(false);
    const text = renderRemediationPlanLines(plan, 90).join('\n');
    expect(text).toContain('Repair previews that failed');
    expect(text).toContain(`  attribution-backfill [timeout]: ${TIMEOUT} (preview: gbrain repair attribution-backfill`);
    // A caller that records nothing still sees the error.
    await expect(withPreviews(PREVIEWS, () => planRepairSteps(engine))).rejects.toThrow(TIMEOUT);
  });

  test('a failed preview with no failures is absent, and an error that carries connection details is redacted and capped', async () => {
    const clean = await withPreviews({ 'planner-stats': pending('pages') }, () => computeRemediationPlan(engine, { repairs: {} }));
    expect('repair_preview_failures' in clean).toBe(false);
    const leaky = `connect failed: postgresql://alice-example:hunter2-secret@db.acme-example.internal:5432/brain password=hunter2-secret ${'x'.repeat(400)}`;
    const plan = await withPreviews({ 'attribution-backfill': async () => { throw new Error(leaky); } }, () => computeRemediationPlan(engine, { repairs: {} }));
    const [failure] = plan.repair_preview_failures!;
    expect(failure.code).toBe('preview_failed');
    expect(failure.message).not.toContain('hunter2-secret');
    expect(failure.message.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(plan)).not.toContain('hunter2-secret');
  });

  test('doctor --remediate plans the other repairs, reports the failed kind, and a run with one exits 1', async () => {
    const result = await withPreviews(PREVIEWS, () => runRemediation(engine, { dryRun: true, repairs: { include: true, remote: false, noEmbed: true } }));
    expectTimeoutFailure(result.repair_preview_failures);
    expect(result.submitted.map(step => step.id)).toContain('repair:planner-stats');
    expect(result.submitted.map(step => step.id)).not.toContain('repair:attribution-backfill');
    expect(remediationExitStatus(result, [])).toBe(1);
  });

  test('an approval bound while the preview failed is preview_changed once that preview succeeds', async () => {
    const args = ['--remediate', '--include-repairs', '--no-embed'];
    const approved = await withPreviews(PREVIEWS, () => remediationPlanHash(engine, args));
    const recovered = { ...PREVIEWS, 'attribution-backfill': pending('pages#1-1') };
    expect(await withPreviews(recovered, () => remediationPlanHash(engine, args))).not.toBe(approved);
    const quiet = [spyOn(console, 'log').mockImplementation(() => {}), spyOn(console, 'error').mockImplementation(() => {}),
      spyOn(process.stdout, 'write').mockImplementation((() => true) as never)];
    setCliExitVerdict(0);
    try {
      await expect(withPreviews(recovered, () => runRemediate(engine, [...args, '--yes', '--expect', approved, '--json'])))
        .rejects.toMatchObject({ code: 'preview_changed' });
    } finally {
      for (const spy of quiet) spy.mockRestore();
      setCliExitVerdict(0);
    }
  });
});
