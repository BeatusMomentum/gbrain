/**
 * LANE PLACEHOLDER (G2a branch only). Lane G2b owns this module; the integrator
 * takes G2b's file. Signatures match GRADUATION_LANES.md.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { GraduationBlocker } from './engine-graduation.types.ts';

const placeholder = (fn: string): Error => new Error(`graduation-drain.ts placeholder: ${fn} is supplied by lane G2b`);

export async function graduationBlockers(_source: BrainEngine, _hostId: string): Promise<readonly GraduationBlocker[]> { throw placeholder('graduationBlockers'); }
export async function drainForGraduation(_source: BrainEngine, _opts: { timeoutMs: number; hostId: string; config: GBrainConfig }): Promise<{ drained: readonly string[]; blockers: readonly GraduationBlocker[] }> { throw placeholder('drainForGraduation'); }
export async function freezeSource(_source: BrainEngine): Promise<void> { throw placeholder('freezeSource'); }
