/**
 * LANE PLACEHOLDER (G2a branch only). Lane G1 owns this module; the integrator
 * takes G1's file. Signatures match GRADUATION_LANES.md exactly so the
 * orchestrator typechecks against the contract.
 */
import type { BrainEngine } from '../engine.ts';
import type { Inventory, InventoryEntry } from './engine-graduation.types.ts';

const placeholder = (fn: string): Error => new Error(`graduation-inventory.ts placeholder: ${fn} is supplied by lane G1`);

export const GRADUATION_INVENTORY: Inventory = { version: 0, entries: [] };
export function expectedRelations(_engine: 'pglite' | 'postgres'): readonly string[] { throw placeholder('expectedRelations'); }
export async function assertRelationSet(_engine: BrainEngine, _kind: 'pglite' | 'postgres', _inv?: Inventory): Promise<void> { throw placeholder('assertRelationSet'); }
export async function copyOrder(_engine: BrainEngine, _inv?: Inventory): Promise<readonly InventoryEntry[]> { throw placeholder('copyOrder'); }
export async function fkClosure(_engine: BrainEngine, _relation: string): Promise<readonly string[]> { throw placeholder('fkClosure'); }
