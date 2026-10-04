/**
 * STUB (G3 CLI lane). The G2a lane owns this module; the integrator replaces
 * this file with G2a's implementation. Signatures follow GRADUATION_LANES.md
 * and the CLI <-> orchestrator types in engine-graduation.types.ts.
 */
import type {
  GraduationCommandOptions, GraduationPlan, GraduationReceipt, GraduationRollbackResult, GraduationStatusDoc,
} from './engine-graduation.types.ts';

function notMerged(name: string): never {
  throw new Error(`${name}: the engine graduation orchestrator (G2a) is not merged into this build.`);
}

export async function planGraduation(_opts: GraduationCommandOptions): Promise<GraduationPlan> { return notMerged('planGraduation'); }
export async function runGraduation(_opts: GraduationCommandOptions): Promise<GraduationReceipt> { return notMerged('runGraduation'); }
export async function graduationStatus(): Promise<GraduationStatusDoc> { return notMerged('graduationStatus'); }
export async function resumeGraduation(_opts: GraduationCommandOptions): Promise<GraduationReceipt> { return notMerged('resumeGraduation'); }
export async function rollbackGraduation(_opts: GraduationCommandOptions): Promise<GraduationRollbackResult> { return notMerged('rollbackGraduation'); }
export async function reconcileGraduation(): Promise<void> { return notMerged('reconcileGraduation'); }
