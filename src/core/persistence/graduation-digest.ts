/**
 * LANE PLACEHOLDER (G2a branch only). Lane G1 owns this module; the integrator
 * takes G1's file. Signatures match GRADUATION_LANES.md.
 */
import type { BrainEngine } from '../engine.ts';
import type { InventoryEntry, TableReceipt } from './engine-graduation.types.ts';

const placeholder = (fn: string): Error => new Error(`graduation-digest.ts placeholder: ${fn} is supplied by lane G1`);

export interface ColumnMeta { name: string; type: string }
export function canonicalRowText(_row: Record<string, unknown>, _columns: readonly ColumnMeta[]): string { throw placeholder('canonicalRowText'); }
export async function digestTable(_engine: BrainEngine, _entry: InventoryEntry, _opts?: { batchRows?: number; applyTransforms?: boolean }): Promise<TableReceipt> { throw placeholder('digestTable'); }
