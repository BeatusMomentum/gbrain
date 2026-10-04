/**
 * LANE PLACEHOLDER (G2a branch only). Lane G1 owns this module; the integrator
 * takes G1's file. Signatures match GRADUATION_LANES.md.
 */
import type { BrainEngine } from '../engine.ts';
import type { GraduationEngines, Inventory, ReplayProbeResult, TableReceipt, VerifyResult } from './engine-graduation.types.ts';

const placeholder = (fn: string): Error => new Error(`graduation-verify.ts placeholder: ${fn} is supplied by lane G1`);

export async function verifyGraduation(_e: GraduationEngines, _ctx: { inventory: Inventory; sourceReceipts: readonly TableReceipt[]; replayRequestId?: string; runDoctor: () => Promise<readonly string[]> }): Promise<VerifyResult> { throw placeholder('verifyGraduation'); }
export async function replayProbe(_target: BrainEngine, _requestId: string, _callerIntent?: unknown): Promise<ReplayProbeResult> { throw placeholder('replayProbe'); }
