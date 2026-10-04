/**
 * LANE PLACEHOLDER (G2a branch only). Lane G2b owns this module; the integrator
 * takes G2b's file. Signatures match GRADUATION_LANES.md.
 */
import type { BrainEngine } from '../engine.ts';
import type { GraduationEngines, InventoryEntry, TriggerBypass } from './engine-graduation.types.ts';

const placeholder = (fn: string): Error => new Error(`graduation-copy.ts placeholder: ${fn} is supplied by lane G2b`);

export async function detectTriggerBypass(_target: BrainEngine): Promise<TriggerBypass | null> { throw placeholder('detectTriggerBypass'); }
export async function copyTable(_e: GraduationEngines, _entry: InventoryEntry, _opts: { bypass: TriggerBypass; batchBytes?: number; onBatch?: (rows: number) => void; runId: string }): Promise<{ rows: number }> { throw placeholder('copyTable'); }
export async function copySequences(_e: GraduationEngines): Promise<void> { throw placeholder('copySequences'); }
export async function deferIndexes(_target: BrainEngine): Promise<void> { throw placeholder('deferIndexes'); }
export async function buildDeferredIndexes(_target: BrainEngine): Promise<void> { throw placeholder('buildDeferredIndexes'); }
export async function reenableTriggers(_target: BrainEngine, _relations: readonly string[]): Promise<void> { throw placeholder('reenableTriggers'); }
