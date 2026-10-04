/**
 * STUB (G3 CLI lane). The G2a lane owns this module; the integrator replaces
 * this file with G2a's implementation. Only `inspectGraduationPath` is
 * stubbed (file reads per the plan's marker and tombstone formats) so the
 * CLI, serve and doctor consumers can be exercised before G2a merges.
 */
import { readFileSync, statSync } from 'node:fs';
import type { GraduationPathState, IntentMarker, Tombstone } from './engine-graduation.types.ts';

export function intentMarkerPath(dataDir: string): string {
  return `${dataDir}.gbrain-graduation.json`;
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function readIntentMarker(dataDir: string): IntentMarker | null {
  return readJson<IntentMarker>(intentMarkerPath(dataDir));
}

export function readTombstone(dataDir: string): Tombstone | null {
  try {
    if (!statSync(dataDir).isFile()) return null;
  } catch {
    return null;
  }
  const t = readJson<Tombstone>(dataDir);
  return t?.kind === 'gbrain-engine-graduated' ? t : null;
}

export function inspectGraduationPath(dataDir: string): GraduationPathState {
  const marker = readIntentMarker(dataDir);
  const tombstone = readTombstone(dataDir);
  if (tombstone) return { dataDir, state: 'graduated', marker, tombstone };
  if (!marker) return { dataDir, state: 'none', marker, tombstone };
  if (marker.state === 'graduated' || marker.state === 'rolled_back' || marker.state === 'abandoned') return { dataDir, state: 'none', marker, tombstone };
  return { dataDir, state: pidAlive(marker.pid) ? 'in_progress' : 'interrupted', marker, tombstone };
}
