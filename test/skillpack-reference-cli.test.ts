/**
 * `gbrain skillpack reference` help and the --all + --apply-clean-hunks
 * refusal (#5491).
 *
 * Protects: an operator or agent reading `reference --help` sees that
 * --apply-clean-hunks works per skill only, and the --all refusal names the
 * per-skill path through the agent-operator contract before any workspace
 * lookup can mask it. Fails when help shows one combined form, the refusal
 * loses its contract fields, or workspace resolution runs first. Existing
 * coverage (skillpack-reference-apply.test.ts) exercises the core apply, not
 * this CLI surface.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

const root = mkdtempSync(join(tmpdir(), 'sp-refcli-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function dir(prefix: string): string {
  return mkdtempSync(join(root, `${prefix}-${n++}-`));
}

function skillpack(args: string[], opts: { cwd?: string } = {}) {
  return runCli(['skillpack', ...args], {
    home: dir('home'),
    cwd: opts.cwd,
    env: { OPENCLAW_WORKSPACE: '', GBRAIN_SKILLS_DIR: undefined },
    timeoutMs: 120_000,
  });
}

/** A workspace with book-mirror scaffolded and one intentional local edit. */
async function editedWorkspace() {
  const ws = dir('ws');
  const scaffold = await skillpack(['scaffold', 'book-mirror', '--workspace', ws]);
  expect(scaffold.exitCode, scaffold.stderr).toBe(0);
  const skillPath = join(ws, 'skills', 'book-mirror', 'SKILL.md');
  appendFileSync(skillPath, '\nIntentional local edit.\n');
  return { ws, skillPath, edited: readFileSync(skillPath, 'utf-8') };
}

describe('skillpack reference help (#5491)', () => {
  test('--help shows --apply-clean-hunks only on the per-skill form, with the local-edit caveat', async () => {
    const r = await skillpack(['reference', '--help']);
    expect(r.exitCode).toBe(0);
    const usage = r.stdout.split('\n').filter(l => l.startsWith('gbrain skillpack reference'));
    const nameForm = usage.find(l => l.includes('<name>'));
    const allForm = usage.find(l => l.includes('--all'));
    expect(nameForm).toContain('--apply-clean-hunks');
    expect(nameForm).not.toContain('--all');
    expect(allForm).not.toContain('--apply-clean-hunks');
    expect(allForm).toContain('--since');
    expect(r.stdout).toContain('including intentional local edits');
  }, 120_000);

  test('reference --harness --help says --apply-clean-hunks takes exactly one skill', async () => {
    const r = await skillpack(['reference', '--harness', 'claude-code', '--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[--skill <slug>]');
    expect(r.stdout).toContain('--apply-clean-hunks needs exactly one skill');
  }, 120_000);
});

describe('skillpack reference --all --apply-clean-hunks refusal (#5491)', () => {
  test('human: exit 2, the contract lines name the per-skill command, nothing is written', async () => {
    const { ws, skillPath, edited } = await editedWorkspace();
    const r = await skillpack(['reference', '--all', '--apply-clean-hunks', '--workspace', ws]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Error [invalid_params]: --apply-clean-hunks works on one skill at a time, not with --all.');
    expect(r.stderr).toContain('Fix: gbrain skillpack reference --all');
    expect(r.stderr).toContain('Why: The apply aligns every clean hunk to gbrain, including intentional local edits');
    expect(readFileSync(skillPath, 'utf-8')).toBe(edited);
  }, 180_000);

  test('--json: one invalid_params envelope with suggestion, why and the read-only sweep as fix', async () => {
    const r = await skillpack(['reference', '--all', '--apply-clean-hunks', '--json'], { cwd: dir('cwd') });
    expect(r.exitCode).toBe(2);
    const doc = JSON.parse(r.stdout.trim());
    expect(doc).toMatchObject({ code: 'invalid_params', class: 'caller', contract_version: 1 });
    expect(doc.suggestion).toContain('gbrain skillpack reference <slug> --apply-clean-hunks');
    expect(doc.why).toContain('every skill at once');
    expect(doc.fix).toMatchObject({ argv: ['gbrain', 'skillpack', 'reference', '--all'], next: 'run' });
  }, 120_000);

  test('the refusal fires before workspace resolution', async () => {
    const r = await skillpack(['reference', '--all', '--apply-clean-hunks'], { cwd: dir('cwd') });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('not with --all');
    expect(r.stderr).not.toContain('auto-detect');
  }, 120_000);
});

describe('skillpack reference read-only and per-skill paths still run (#5491 negative controls)', () => {
  test('per-skill --apply-clean-hunks --dry-run and the --all sweep both exit 0 and write nothing', async () => {
    const { ws, skillPath, edited } = await editedWorkspace();
    const apply = await skillpack(['reference', 'book-mirror', '--apply-clean-hunks', '--dry-run', '--json', '--workspace', ws]);
    expect(apply.exitCode, apply.stderr).toBe(0);
    expect(JSON.parse(apply.stdout).summary.totalHunksApplied).toBeGreaterThanOrEqual(1);
    const sweep = await skillpack(['reference', '--all', '--json', '--workspace', ws]);
    expect(sweep.exitCode, sweep.stderr).toBe(0);
    const bookMirror = (JSON.parse(sweep.stdout).skills as Array<{ slug: string; summary: { differs: number } }>).find(s => s.slug === 'book-mirror');
    expect(bookMirror?.summary.differs).toBeGreaterThanOrEqual(1);
    expect(readFileSync(skillPath, 'utf-8')).toBe(edited);
  }, 180_000);
});
