/**
 * LANE PLACEHOLDER (G2a branch only). Lane G2b owns this module; the integrator
 * takes G2b's file. Signatures match GRADUATION_LANES.md; `TargetProbe` is
 * G2b's type (the orchestrator reads only `empty`, through `probeTargetEmpty`).
 */
import type { BrainEngine } from '../engine.ts';
import type { TargetIdentity, TargetRoutes } from './engine-graduation.types.ts';

const placeholder = (fn: string): Error => new Error(`graduation-target.ts placeholder: ${fn} is supplied by lane G2b`);

export interface TargetProbe { empty: boolean }
export function resolveTargetRoutes(_opts: { url?: string; urlEnv?: string; env?: NodeJS.ProcessEnv }): TargetRoutes & { mainUrl: string; ddlUrl: string } { throw placeholder('resolveTargetRoutes'); }
export function targetIdentity(_url: string): TargetIdentity { throw placeholder('targetIdentity'); }
export async function probeTarget(_routes: TargetRoutes & { mainUrl: string; ddlUrl: string }): Promise<TargetProbe> { throw placeholder('probeTarget'); }
export async function crossCheckRoutes(_main: BrainEngine, _ddl: BrainEngine, _runId: string): Promise<void> { throw placeholder('crossCheckRoutes'); }
